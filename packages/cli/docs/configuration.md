# Configuration

Back to the [`@gamecrate/cli` README](../README.md).

One global file names your games and profiles. A per-repository `.gamecrate` file can add
profiles, pins, and flag defaults on top. This page covers both, and how gamecrate merges your
file over a plugin's defaults.

## Where the file lives

Your config lives in `~/.config/gamecrate/`. If you set `XDG_CONFIG_HOME`, the directory moves
with it. The file is named `profiles`, and gamecrate reads four suffixes:

| Suffix | Format |
| --- | --- |
| `.yml` | YAML |
| `.yaml` | YAML |
| `.json` | JSON with comments and trailing commas |
| `.jsonc` | JSON with comments and trailing commas |

Keep one. Two config files in the same directory fail with `two configs in <dir>` and exit `3`,
because silent precedence is how you edit the wrong file for twenty minutes. gamecrate probes
`.yml` first, so that is the name an error message uses when nothing is on disk yet.

An absent file and an empty file both mean no config. Every subcommand that does not launch
survives that, so `gamecrate help` works before you have written anything.

Run `gamecrate config edit` to open the file in `$VISUAL`, or `$EDITOR` when `$VISUAL` is
unset, and validate it on save. With neither variable set it fails with `no $EDITOR or $VISUAL
set`. With nothing on disk yet, it creates `profiles.yml` holding `plugins: []` and `games: {}`.
That `games: {}` is a YAML flow map, and the YAML writer keeps a flow map flow. So a
[`mods add --global`](mods-commands.md) into that untouched file comes out as one long line.
Write the `games` block by hand first, or reflow the file after the first write.

## How plugins resolve

`plugins` is an array of strings. gamecrate loads each one before it reads the rest of the
file, because a plugin decides what a valid game block looks like.

A string that starts with `.` or `/` is a path. gamecrate resolves it against the directory
holding your config, so `./plugins/mygame` means `~/.config/gamecrate/plugins/mygame`. A `~`
at the front expands to your home directory. A path to a directory loads that directory's
entry point, read from its `package.json`.

Anything else is a package name. gamecrate walks `node_modules` upward from the config
directory, the same way Node does. To use a bare name such as `@gamecrate/rimworld`, install it
where that walk can find it:

```sh
cd ~/.config/gamecrate
npm init -y
npm install @gamecrate/rimworld
```

A name the walk cannot find fails with `plugin "<name>": cannot be resolved from <dir>` and
exit `3`.

Each plugin claims one game name. Two plugins claiming the same name is a config error. A
`games` block whose name no plugin claims fails validation too, because nothing supplies the
required keys that a plugin's defaults normally fill in.

## The steamcmd binary

gamecrate downloads [workshop items](mod-sources.md#workshop-items) with `steamcmd`. The
optional top-level `steamcmd` key says which one to run:

```yaml
steamcmd:
  path: /usr/bin/steamcmd
```

A `~` at the front expands to your home directory. A `path` that is not an executable file
fails with `steamcmd.path is not an executable file: <path>` and exit `5`. That is an error,
not a fallback, because a typo there would otherwise download through a tool you did not choose.

With the key absent, gamecrate looks for `steamcmd` on your `PATH`. Failing that, it runs the
`steamcmd/steamcmd` Docker image. That run binds the download directory in at the same path it
has on the host, and maps your own user into the container. With no `steamcmd` and no `docker`, a
download fails with `steamcmd is not available` and exit `5`.

## An array you write replaces the plugin's array

A plugin ships defaults for its game. Your `games.<name>` block merges on top of those
defaults, key by key. Objects merge. Scalars overwrite.

**Arrays do not concatenate.** The array you write replaces the plugin's array outright. Write
three entries under `dlc` and the game has three, not the plugin's five plus your three. The
same holds for `modes`, `scanRoots`, and `saveExtensions`. To add one DLC, copy the plugin's
full list and append to it.

The `image.updates` block controls the staleness check a launch runs: `check` turns it on or off,
and `everyHours` sets how long one answer lasts. [Game images](images.md#checking-for-a-newer-build)
covers what it does.

Two arrays are exceptions. `steamBuild.branches` concatenates, matched on `name`, so you
add a private beta without copying the plugin's list. Your fields win on a name the plugin
already declares, and a new name lands at the end.

The settings ladder is the second. `settings` merges through five layers: the top-level
`defaults`, then `games.<game>`, then the profile, then the instance, then the command line.
Arrays inside `settings`, which means `gameArgs` and `dockerArgs`, concatenate at every layer,
unlike the `dlc`, `modes` and `scanRoots` lists in the preceding section, which replace.

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
| `gpu` | `true` | Passes the NVIDIA GPU into the container through CDI. `false` selects software rendering |
| `audio` | `true` | Mounts the host audio sockets |
| `input` | `false` | Mounts `/dev/input` |
| `network` | `bridge` | `none`, `bridge` or `host`. The RimWorld plugin sets `host` |
| `display` | `x11` | `x11` or `wayland`. Only X11 lets gamecrate retitle and close the window |
| `memory` | `8g` | The container memory limit |
| `cpus` | `6` | The container CPU limit |
| `pidsLimit` | `1024` | The container process limit |
| `prefsExtra` | unset | Extra keys written verbatim into the prefs file |
| `gameArgs` | unset | Arguments appended to the game command line. Concatenates across layers |
| `dockerArgs` | unset | Extra `docker run` arguments. Concatenates across layers |

## Profiles

A profile names a mod set. Each entry under `mods` takes one of three shapes:

| Shape | Meaning |
| --- | --- |
| `brrainz.harmony` | A package id. `workshop:2009463077` and `path:~/mods/x` name a source outright |
| `{ id: some.mod, optional: true }` | An object. `workshop` or `path` beside the `id` pins it. `optional` turns a miss into a warning |
| `{ match: 'Cosmere.*' }` | A glob over every indexed package id. `first` lists ids to load ahead of the rest, `sort` is `alpha` or `none`, and `minMatches` fails the launch below that count |

`extends` inherits a parent profile's mods and appends its own. `exclude` drops entries by glob,
and a child's list adds to its parent's. `includeBase: false` leaves out the game's `base` list.
`autoDependencies` inserts each mod's declared dependencies ahead of it, and it is on unless you
set it to `false`. A mod does not work without the dependencies it
declares. Gamecrate downloads the declared ones anyway, so leaving them out of the load order
only breaks the game.
Set it to `false` when you want the mod list taken literally. A dependency that is not installed
is a launch problem.

`alias` marks a profile as another name for an existing one, and it cannot carry `mods` or
`extends` of its own. `aliases` gives one profile extra names. Both share the parent's data
directory, so your saves never split by spelling. `instances` splits one profile into named
sub-runs, each with its own saves, logs, lock, and container. An instance can name a `worktree`
to promote and carry its own `settings`.

`description` is one line saying what the profile is for. `gamecrate list` prints it on its own
line under the profile, and `gamecrate list --json` carries it as a `description` field on that
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

A profile can also carry a default for three flags, so you stop typing them:

| Key | Stands in for |
| --- | --- |
| `detach` | `--detach`. `--no-detach` overrides it. |
| `replace` | `--replace`. `--no-replace` overrides it. |
| `build` | `--build` and `--no-build`. Takes `auto`, `always`, or `never`. |

A profile can pin the game version it runs against. `gameVersion` names a tag on the game's own
image repository, so `"1.6"` resolves to `<your repo>:1.6`, and `steam build` writes that tag for
you. `image` names a whole reference and gamecrate uses it as written. `image` beats
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
over the same path would hide what the image carries.

gamecrate ships one profile of its own, `modless`. It resolves to the core game plus its
official DLC, and you cannot redefine it. Subcommand names are reserved the same way: a game or
profile called `run`, `add` or `sync` fails validation.

Profile names, instance names and game names must match `[A-Za-z0-9][A-Za-z0-9._-]*`. Two
profiles that differ only in case fail validation, because they would share one data directory.
So do two profiles, or two instances, whose container names collide.

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
| `game` | The game the rest of the file talks about. `profiles`, `settings` and `library` all need it. |
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
