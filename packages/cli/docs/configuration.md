# Configuration

Back to the [`@gamecrate/cli` README](../README.md).

One global file holds your games and profiles. A per-repository `.gamecrate` file can add
profiles, pins, and flag defaults on top. This page covers both, and how gamecrate merges your
file over a plugin's defaults.

## Where the file lives

Your config lives in `~/.config/gamecrate/`. If you set `XDG_CONFIG_HOME`, the directory moves
with it. The file is named `config`, and gamecrate reads four suffixes:

| Suffix | Format |
| --- | --- |
| `.yml` | YAML |
| `.yaml` | YAML |
| `.json` | JSON with comments and trailing commas |
| `.jsonc` | JSON with comments and trailing commas |

Keep one. Two config files in the same directory fail with `two configs in <dir>` and exit `3`,
because silent precedence is how you edit the wrong file for twenty minutes. gamecrate probes
`.yml` first, so that is the name an error message uses when nothing is on disk yet.

A file named `profiles.<ext>` is renamed to `config.<ext>` on the next run, and gamecrate prints
the rename. Both stems present at once fails with `two global configs in <dir>` and exit `3`.

An absent file and an empty file both mean no config. Every subcommand that does not launch
survives that, so `gamecrate help` works before you have written anything.

`gamecrate init` writes this file for you, and installs the plugin where the loader can find
it. The rest of this page is what it wrote, and what to change.

## A config that runs

`gamecrate init` writes the skeleton below. It validates as written, but the placeholder install
path points nowhere, so `doctor` and `run` both fail until you replace it:

```yaml
plugins: ['@gamecrate/rimworld']
games:
  rimworld:
    gameFiles:
      host: ~/games/rimworld
    scanRoots:
      - { path: ~/projects/rimworld-mods, maxDepth: 2 }
    profiles:
      dev:
        mods: [brrainz.harmony]
```

| Key | Why you write it |
| --- | --- |
| `gameFiles.host` | Required while `gameFiles.source` is `mount`, which is the RimWorld default |
| `scanRoots` | The plugin ships an empty list, so nothing is indexed until you add a directory |

A `mount` game with no `image` block pulls `ghcr.io/rimworks/gamecrate/runtime-base:1`, which
runs a native Linux build. Write your own `image.ref` to override it. A `source: image` game
carries the game inside the image, so it has no default and `image.ref` is required.

Proton is not reachable this way. gamecrate runs a game through Proton only when the image says
so in its `gamecrate.launcher` label, and `steam build` is the only thing that writes that
label. See [Game images](images.md).

`scanRoots` entries take a `path`, a `maxDepth`, and an optional `exclude` list of globs.
[Mod sources](mod-sources.md) covers the other ways to name a mod.

## Root keys

Everything outside a `games` block:

| Key | Default | What it does |
| --- | --- | --- |
| `plugins` | `[]` | The plugins to load. See below |
| `games` | required | One block per game, keyed by the name a plugin claims |
| `dataRoot` | `~/.local/share/gamecrate` | Where saves, logs, locks, clones, and downloads go |
| `defaults.settings` | the built-in settings | The bottom layer of the settings ladder |
| `buildConcurrency` | `3` | How many `dotnet build` runs go at once when a launch rebuilds stale mods. `1` builds them one at a time |
| `steamcmd.path` | unset | Which `steamcmd` to run. See below |

Run `gamecrate config edit` to open the file in `$VISUAL`, or `$EDITOR` when `$VISUAL` is
unset, and validate it on save. With neither variable set it fails with `no $EDITOR or $VISUAL
set`. With nothing on disk yet, it creates `config.yml` holding `plugins: []` and `games: {}`.
Write the `games` block yourself before the first [`mods add --global`](mods-commands.md), or
that write comes out as one long line.

## How plugins resolve

`plugins` is an array of strings. gamecrate loads each one before it reads the rest of the
file, because a plugin decides what a valid game block looks like.

A string that starts with `~`, `.` or `/` is a path. `~` expands to your home directory, and a
relative path resolves against your config directory. A path to a directory loads that
directory's entry point, read from its `package.json`.

Anything else is a package name. A global install is the normal way, and what `gamecrate init`
does:

```sh
npm install -g @gamecrate/rimworld
```

gamecrate looks in three places, in order: `node_modules` walking up from the config directory,
`node_modules` walking up from the running executable, then the directory `npm root -g` reports.
The last two only run when the first finds nothing, so a per-project plugin still wins.

A name none of the three can find fails with `plugin "<name>": cannot be resolved from <dir>`
and exit `3`.

Each plugin claims one game name. Two plugins claiming the same name is a config error. A
`games` block whose name no plugin claims fails validation too, because nothing supplies the
required keys that a plugin's defaults normally fill in.

## Where the game comes from

`gameFiles.source` picks one of two setups, and it decides whether you need a copy of the game
on this machine at all.

| `source` | Where the game lives | Needs |
| --- | --- | --- |
| `mount` | Your own install, bind-mounted read-only into a runtime image | `gameFiles.host` |
| `image` | Baked into the image, which is what [`steam build`](images.md) produces | nothing else |

The RimWorld plugin defaults to `mount`, so a config that does not say otherwise needs
`gameFiles.host`. Point at an image you built instead and the host copy stops mattering:

```yaml
games:
  rimworld:
    gameFiles:
      source: image
    image:
      ref: ghcr.io/you/rimworld-game:1.6
      acquire: pull
```

`image.acquire` is a separate question from `gameFiles.source`. `pull` fetches the image,
`build` builds it from `image.context`. A `mount` setup still pulls an image, it just pulls a
runtime that holds no game.

## The steamcmd binary

gamecrate downloads [workshop items](mod-sources.md#workshop-items) with `steamcmd`. The
optional top-level `steamcmd` key says which one to run:

```yaml
steamcmd:
  path: /usr/bin/steamcmd
```

A `path` that is not an executable file fails with `steamcmd.path is not an executable file:
<path>` and exit `5`. That is an error, not a fallback, because a typo there would otherwise
download through a tool you did not choose.

With the key absent, gamecrate looks for `steamcmd` on your `PATH`. Failing that, it runs the
`steamcmd/steamcmd` Docker image. That run binds the download directory in at the same path it
has on the host, and maps your own user into the container. With no `steamcmd` and no `docker`, a
download fails with `steamcmd is not available` and exit `5`.

## Arrays replace instead of merging

A plugin ships defaults for its game. Your `games.<name>` block merges on top of those
defaults, key by key. Objects merge. Scalars overwrite.

**Arrays do not concatenate.** The array you write replaces the plugin's array. That covers
`dlc`, `modes`, `scanRoots`, and `saveExtensions`. To add one DLC, copy the plugin's full list
and append to it.

The `image.updates` block controls the staleness check a launch runs: `check` turns it on or off,
and `everyHours` sets how long one answer lasts. [Game
images](images.md#checking-for-a-newer-build) covers what it does.

Two arrays are exceptions. `steamBuild.branches` concatenates, matched on `name`, so you
add a private beta without copying the plugin's list. Your fields win on a name the plugin
already declares, and a new name lands at the end.

`settings` is the other. It merges through five layers: the top-level `defaults`, then
`games.<game>`, then the profile, then the instance, then the command line. The arrays inside
it, `gameArgs` and `dockerArgs`, concatenate at every layer.

When a config error points at a key you never wrote, the message says which plugin's defaults
supplied it.

### Settings

Every key under `settings`, with the value gamecrate uses when no layer sets it:

| Key | Default | What it does |
| --- | --- | --- |
| `width`, `height` | `1920`, `1080` | The window size. `--resolution` overrides both |
| `devMode` | `true` | Written into the game's prefs |
| `runInBackground` | `true` | Written into the game's prefs |
| `resetModsConfigOnCrash` | `false` | Forced to `false` when written, whatever you set |
| `gpu` | `true` | Passes the card into the container. NVIDIA goes through the Container Device Interface, which needs `/etc/cdi/nvidia.yaml`. AMD and Intel go through the render nodes under `/dev/dri`. A host with neither renders in software, and `doctor` says so |
| `audio` | `true` | Mounts the host audio sockets |
| `input` | `false` | Mounts `/dev/input` |
| `network` | `bridge` | `none`, `bridge` or `host`. The RimWorld plugin sets `host` |
| `display` | `x11` | `x11` or `wayland`. Only X11 lets gamecrate retitle and close the window |
| `memory` | `8g` | The container memory limit |
| `cpus` | `6` | The container CPU limit |
| `pidsLimit` | `1024` | The container process limit |
| `prefsExtra` | unset | Extra keys written verbatim into the prefs file |
| `gameArgs` | unset | Arguments appended to the game command line. Concatenates across layers. See [Passing arguments to the game](running.md#passing-arguments-to-the-game) |
| `dockerArgs` | unset | Extra `docker run` arguments. Concatenates across layers |

### Mod name aliases

`games.<game>.aliases` maps a name you type to a package id. It covers every mod entry gamecrate
looks up: a profile's `mods`, `--mod`, and `--only`. `--without` is a glob over package ids that
already resolved, so an alias does not apply there.

```yaml
games:
  rimworld:
    aliases:
      harmony: brrainz.harmony
```

The lookup runs after an exact package id match and before the short-name match, so an alias
never shadows a real id. `gamecrate help <game>` lists the ones you set.

## Profiles

A profile is a mod set. Each entry under `mods` takes one of three forms:

| Form | Meaning |
| --- | --- |
| `brrainz.harmony` | A package id. `workshop:2009463077` and `path:~/mods/x` name a source outright |
| `{ id: some.mod, optional: true }` | An object. `workshop` or `path` beside the `id` pins it. `optional` turns a miss into a warning |
| `{ match: 'Cosmere.*' }` | A glob over every indexed package id. `first` lists ids to load ahead of the rest, `sort` is `alpha` or `none`, and `minMatches` fails the launch below that count |

`extends` inherits a parent profile's mods and appends its own. `exclude` drops entries by glob,
and a child's list adds to its parent's. `includeBase: false` leaves out the game's `base` list.
`autoDependencies` inserts each mod's declared dependencies ahead of it, and it is on unless you
set it to `false`. Set it to `false` when you want the mod list taken literally. A dependency
that is not installed is a launch problem.

`alias` marks a profile as another name for an existing one, and it cannot have `mods` or
`extends` of its own. `aliases` gives one profile extra names. Both share the parent's data
directory, so your saves never split by spelling. `instances` splits one profile into named
sub-runs, each with its own saves, logs, lock, and container. An instance can name a
[`worktree`](mod-sources.md#worktrees-and---use) to promote, and it can set its own `settings`.

`description` is one line saying what the profile is for. `gamecrate list` prints it on its own
line under the profile, and `gamecrate list --json` prints it as a `description` field on that
profile. It changes nothing about the launch.

```yaml
profiles:
  dev:
    description: harmony plus the mod I am working on
    mods: [brrainz.harmony, yourname.yourmod]
```

```
rimworld  (headed, headless, screenshot)
  modless  built-in: core + official DLC
  dev      2 entries
           harmony plus the mod I am working on
```

A profile can also set a default for three flags, so you stop typing them:

| Key | Stands in for |
| --- | --- |
| `detach` | `--detach`. `--no-detach` overrides it. |
| `replace` | `--replace`. `--no-replace` overrides it. |
| `build` | `--build` and `--no-build`. Takes `auto`, `always`, or `never`. |

A profile can pin the game version it runs against. `gameVersion` is a tag on the game's own
image repository, so `"1.6"` resolves to `<your repo>:1.6`, and `steam build` writes that tag for
you. `image` is a whole reference and gamecrate uses it as written. `image` beats
`gameVersion`, and `--image` beats both.

```json
{
  "profiles": {
    "stable": { "gameVersion": "1.6", "mods": ["brrainz.harmony"] },
    "scratch": { "image": "ghcr.io/me/other:sha-abc", "mods": [] }
  }
}
```

Either key switches the game files to the image, because the game lives inside one. A host mount
over the same path would hide what the image holds.

A headed profile on X11 can set `windowTitle` and `windowIcon`. The caption defaults to
`<game> <profile>`, and `windowIcon` is a path relative to the config file it appears in, read
by ImageMagick. A Wayland client owns its own caption, so neither key applies there.

gamecrate ships one profile of its own, `modless`. It resolves to the core game plus its
official DLC, and you cannot redefine it. Subcommand names are reserved the same way: a game or
profile called `run`, `add` or `sync` fails validation.

Profile names, instance names and game names must match `[A-Za-z0-9][A-Za-z0-9._-]*`. The first
character must be a letter or a digit. Each name becomes a directory under the data root, so a
name that could redirect a path is refused.

Two profiles that differ only in case fail validation, because they would share one data
directory. So do two profiles, or two instances, whose container names collide.

## A mod's own settings

A profile's `modSettings` is a list of settings files to write before launch. Each entry takes
four keys:

| Key | What it holds |
| --- | --- |
| `file` | The filename, relative to the game's `modSettingsDir`. A path that climbs out of it fails with exit `3` |
| `class` | The type the engine writes on the settings block |
| `values` | The keys to write |
| `replace` | Optional. The keys in `values` that overwrite rather than merge |

A key already in the file keeps its value unless `replace` names it, so a setting you changed in
game survives. To take a setting back, change it in the game.

## Per-directory defaults

gamecrate looks for a `.gamecrate` file in the current directory and every parent. It takes the
same four suffixes as the global config. `.gamecrate.yml`, `.gamecrate.yaml`,
`.gamecrate.json`, and `.gamecrate.jsonc` all work, and two of them in one directory is the same
error. Most keys stand in for a flag of the same name, camel-cased. A mod repository can pin its
own game, profile, and extra Docker arguments:

```yaml
game: rimworld
defaultProfile: dev
mode: headed
detach: true
dockerArgs: ['--cpus', '4']
```

A flag on the command line beats the file.

The flag-shaped keys are `mods`, `without`, `only`, `dockerArgs`, `gameArgs`, `worktree`, `use`,
`marker`, `instance`, `log`, `timeout`, `renderWait`, `dryRun`, `printPlan`, `json`, `root`,
`noWorktree`, `noStaleCheck`, `replace`, `detach`, `mode`, `pull`, `sort`, `network`, `build`,
and `resolution`. `build` takes `true` or `false` as well as a policy name. `gameArgs` from the
file only applies when the command line has no `--` of its own. An unknown key fails the load.

Five keys are not flags:

| Key | What it does |
| --- | --- |
| `game` | The game the rest of the file talks about. `profiles`, `settings` and `library` all need it, and it settles which game a command acts on when no profile says. |
| `defaultProfile` | The profile to use when you name none. Without it, the first key in `profiles` wins. With neither, a launch stops and lists the profiles it knows, rather than guessing. |
| `profiles` | Profiles for `game`, written exactly like the ones in the global config. |
| `settings` | A settings block merged into `games.<game>.settings` at load time. |
| `library` | Mod pins for `game`. [Mod sources](mod-sources.md) explains the entries. |

**A repo `settings:` block is merged into `games.<game>.settings` when the config loads**,
before anything resolves. It is not a sixth layer: by the time the ladder runs, there is one game
block holding whatever the repo supplied. That merge is key by key. An array in it replaces the
game's array rather than concatenating, because the ladder has not started yet.

**A repo profile replaces a global profile of the same name outright.** It does not merge, so
the global profile's `instances` and `aliases` are gone for that run. This is deliberate: a
merge would leave the global profile's `mods` showing through the repo's shorter list. Give the
repo profile a name of its own when you want both.

A repo `library` pin replaces a global pin of the same id outright, and the match ignores case.

`gamecrate list` marks a profile that came from the repo file with `from <filename>`, so you
can tell the two apart.

The file is untrusted input. It ships inside any repo you clone, and `mods`, `use`, `worktree`,
`profiles`, and `library` can all name directories anywhere on your disk to bind-mount into the
container. Read a stranger's `.gamecrate.yml` before you run gamecrate in their repo.
