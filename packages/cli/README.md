# @gamecrate/cli

The `gamecrate` command. It resolves a profile to a mod set, stages that set, and launches the
game in a Docker container.

The core knows nothing about any one game. A plugin supplies the file formats and the engine
facts. Without at least one plugin, `gamecrate` has no games to run.

## Install

The package is not on npm yet, so build it from a clone of the monorepo:

```sh
git clone https://github.com/RimWorks/gamecrate.git
cd gamecrate
npm install
npm run build
npm install -g ./packages/cli
```

The build needs [bun](https://bun.sh) and Node 22 or newer.

## Configuration

Your config lives in `~/.config/gamecrate/`. If you set `XDG_CONFIG_HOME`, the directory moves
with it. The file is named `profiles`, and gamecrate reads four suffixes:

| Suffix | Format |
| --- | --- |
| `.yml` | YAML |
| `.yaml` | YAML |
| `.json` | JSON with comments and trailing commas |
| `.jsonc` | JSON with comments and trailing commas |

Keep one. Two config files in the same directory is an error, because silent precedence is how
you edit the wrong file for twenty minutes.

A minimal config for RimWorld:

```yaml
plugins: ['@gamecrate/rimworld']
games:
  rimworld:
    # The plugin already says source: mount and container: /game.
    gameFiles:
      host: ~/games/RimWorld
    image:
      ref: ghcr.io/your-org/rimworld:1.6
      acquire: pull
    workshopRoot: ~/.steam/steam/steamapps/workshop/content/294100
    scanRoots:
      - path: ~/projects/mods
        maxDepth: 2
    profiles:
      dev:
        mods: [brrainz.harmony, yourname.yourmod]
```

Run `gamecrate config edit` to open the file in `$VISUAL`, or `$EDITOR` when `$VISUAL` is
unset, and validate it on save. With nothing on disk yet, it creates `profiles.yml`.

### How plugins resolve

`plugins` is an array of strings. gamecrate loads each one before it reads the rest of the
file, because a plugin decides what a valid game block looks like.

A string that starts with `.` or `/` is a path. gamecrate resolves it against the directory
holding your config, so `./plugins/mygame` means `~/.config/gamecrate/plugins/mygame`. A `~`
at the front expands to your home directory.

Anything else is a package name. gamecrate walks `node_modules` upward from the config
directory, the same way Node does. To use a bare name such as `@gamecrate/rimworld`, install it
where that walk can find it:

```sh
cd ~/.config/gamecrate
npm init -y
npm install @gamecrate/rimworld
```

Each plugin claims one game name. Two plugins claiming the same name is a config error, and so
is a `games` block whose name no plugin claims.

### An array you write replaces the plugin's array

A plugin ships defaults for its game. Your `games.<name>` block merges on top of those
defaults, key by key. Objects merge. Scalars overwrite.

**Arrays do not concatenate.** The array you write replaces the plugin's array outright. Write
three entries under `dlc` and the game has three, not the plugin's five plus your three. The
same holds for `modes`, `scanRoots`, and `saveExtensions`. To add one DLC, copy the plugin's
full list and append to it.

The settings ladder is the one exception. `settings` merges through five layers: the top-level
`defaults`, then `games.<game>`, then the profile, then the instance, then the command line.
Arrays inside `settings`, which means `gameArgs` and `dockerArgs`, concatenate at every layer,
unlike the `dlc`, `modes` and `scanRoots` lists in the preceding section, which replace.

When a config error points at a key you never wrote, the message says which plugin's defaults
supplied it.

### Profiles

A profile names a mod set. `extends` inherits a parent profile's mods and appends its own.
`exclude` drops entries by glob. `alias` and `aliases` give one profile extra names, and they
share the parent's data directory. `instances` splits one profile into named sub-runs, each
with its own saves, logs, lock, and container.

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

gamecrate ships one profile of its own, `modless`. It resolves to the core game plus its
official DLC, and you cannot redefine it.

### Per-directory defaults

gamecrate looks for a `.gamecrate` file in the current directory and every parent. It takes the
same four suffixes as the global config. `.gamecrate.yml`, `.gamecrate.yaml`,
`.gamecrate.json`, and `.gamecrate.jsonc` all work, and two of them in one directory is the same
error. Most keys stand in for a flag of the same name, camel-cased. A mod repo can pin its own
game, profile, and extra Docker arguments:

```yaml
game: rimworld
defaultProfile: dev
mode: headed
detach: true
dockerArgs: ['--cpus', '4']
```

A flag on the command line beats the file.

Four keys are not flags:

| Key | What it does |
| --- | --- |
| `game` | The game the rest of the file talks about. `profiles` and `settings` both need it. |
| `defaultProfile` | The profile to use when you name none. Without it, the first key in `profiles` wins, and with neither, `modless` does. |
| `profiles` | Profiles for `game`, written exactly like the ones in the global config. |
| `settings` | A settings block assigned over `games.<game>.settings` at load time. |

**A repo `settings:` block is assigned over `games.<game>.settings` when the config loads**,
before anything resolves. It is not a sixth layer: by the time the ladder runs, there is one game
block holding whatever the repo supplied.

**A repo profile replaces a global profile of the same name outright.** It does not merge, so
the global profile's `instances` and `aliases` are gone for that run. This is deliberate: a
merge would leave the global profile's `mods` showing through the repo's shorter list. Give the
repo profile a name of its own when you want both.

The file is untrusted input. It ships inside any repo you clone, and `mods`, `use`, `worktree`,
and now `profiles` can all name directories anywhere on your disk to bind-mount into the
container.
Read a stranger's `.gamecrate.yml` before you run gamecrate in their repo.

## Mod sources

A `library` block under a game says where one mod lives. Profiles then name that mod by its
package id alone, and the library supplies the rest.

```yaml
games:
  rimworld:
    library:
      brrainz.harmony:
        workshop: 2009463077
      yourname.yourmod:
        path: ~/projects/yourmod
      someone.theirmod:
        git: https://github.com/someone/theirmod.git
        tag: v1.4.2
        subdir: Mod
```

Each entry carries exactly one of `path`, `workshop`, or `git`. Two of them is a config error
that names both keys. An entry with none of the three fails the same way.

`branch`, `tag`, and `commit` pin a git entry to one ref. An entry takes at most one of the
three. `subdir` names the mod folder inside the repository, for a repo that holds the mod
somewhere below its root. All four keys need a `git` URL beside them, so a `path` or `workshop`
entry that carries one fails with `"tag" needs a "git" url`. A `subdir` starting with `/`, or
holding a `..` segment, fails as well.

A repo config declares its own `library` at the top level, without the `games` wrapper. A repo
pin replaces a global pin of the same id outright.

### `workshopRoot`

`workshopRoot` is the directory Steam downloads workshop items into. The path is
`<steam library>/steamapps/workshop/content/<appId>`, and RimWorld's `appId` is `294100`:

```yaml
workshopRoot: ~/.steam/steam/steamapps/workshop/content/294100
```

**A plugin leaves it `null`.** Where Steam put your library is a fact about your machine, not
about the game, so no plugin guesses it. The key still has to appear in the merged config, and
`null` is the value a plugin ships.

With a null root, every workshop reference fails, and the message names the missing key rather
than the missing mod:

```
rimworld has no workshopRoot, so workshop:2009463077 cannot resolve
```

`gamecrate doctor` reports the same problem without a launch. It reads the library and every
profile, then lists up to three of the workshop ids it found. `gamecrate mods add --workshop`
refuses ahead of its write, so a null root never leaves a half-written config behind.

### Git sources

gamecrate clones a git entry into a cache under the data root, one directory per repository and
ref:

```
~/.local/share/gamecrate/sources/<repo>-<hash>/<kind>-<ref>-<hash>/
```

**That cache belongs to gamecrate.** A fetch runs `git reset --hard` inside it, which throws
away whatever you changed there, with no prompt, no warning, and no copy. To work on a mod,
clone it yourself and pin that checkout with `path:`.

Only one gamecrate touches a clone at a time. A second one waits up to 30 seconds for the lock,
then gives up and names the lock file it waited on.

#### Moving pins and fixed pins

An entry with no `branch`, `tag`, or `commit` follows the remote's default branch. Every launch
asks the remote for that branch, fetches it, and resets the clone onto it. So an unpinned entry
re-resolves on every run, and a push upstream reaches your next launch.

A `tag` or `commit` pin clones once and then sits still. No launch fetches it again.
`gamecrate mods sync` is the only thing that moves a fixed pin.

A fetch that fails is a warning, not a failure. gamecrate keeps the clone already on disk and
says how old it is:

```
warning: could not fetch https://example.com/mod.git, using 4f9c21e from 3 days ago
```

**A commit pin needs the server's cooperation.** gamecrate runs `git fetch origin <sha>`, which
asks for one commit by name. That works over `file://` and against GitHub. Other hosts answer
it only with `uploadpack.allowReachableSHA1InWant` turned on. A forge without that setting
turns every sync of the pin into the preceding warning, even while the remote is healthy. Pin a
`tag` instead when your forge refuses.

`--dry-run` and `--print-plan` never fetch and never clone. They do still ask a remote for one
thing: the default branch of an unpinned entry, through `git ls-remote`. A remote that cannot
answer fails the command with `could not read the default branch of <url>` and exit `5`. Past
that point, with no clone on disk, they stop with `no clone of <url> on disk`.
`gamecrate mods` asks no remote at all. It resolves through the mod index, so a git pin with no
clone yet reads as `no mod matches "<id>"`.

#### A clone is source, not a release

Most mod repositories keep their build output out of git. A clone of one carries `.cs` sources
and no assembly, which is exactly what the stale check looks for. Under the default
`--build auto`, the first launch runs `dotnet build` against the mod's `.csproj` or `.slnx`.
A mod with no C# at all is never stale, so nothing builds.

**So a git-pinned C# mod needs a working `dotnet` SDK on the host.** A failed build stops the
launch and exits `5`. gamecrate never starts a game whose mod failed to compile.

Two ways out when you have no compiler. Set `build: never` on the profile, or pass `--no-build`
for one run. The mod then loads with whatever assemblies the repository ships, which may be
none.

### Writing the library with `mods`

`mods add`, `mods rm`, and `mods sync` edit the library for you.

```sh
gamecrate mods add rimworld --path ~/projects/yourmod --project
gamecrate mods add rimworld --workshop 2009463077 --global
gamecrate mods add rimworld --git https://github.com/someone/theirmod --tag v1.4.2 --global
gamecrate mods rm rimworld yourname.yourmod --project
gamecrate mods sync rimworld
```

`add` and `rm` each need `--global` or `--project`, because one write lands in one file.
`--project` means the nearest `.gamecrate` file, which needs a top-level `game:` matching the
game you named.

`add` reads the mod's own manifest for its package id, so you never type an id. A `--path`
source lands in the config as an absolute path. A `--git` source clones the repo first, then
walks it for manifests, and pins every mod it finds. The walk stops at the first manifest down
each branch of the tree, so per-version `About` folders under one parent manifest stay one
entry. Two separate directories that declare the same package id are a different case. `add`
refuses the whole batch and names both directories, because nothing tells it which one you
meant. Start the walk lower down with `--subdir` to pick one. `--force` does not apply here; it
only overwrites a pin that is already in the target file.

An id already in the target library stops the whole write, listing every clash. `--force`
overwrites those entries instead.

`rm` takes package ids and reports any it cannot find. Emptying a `library` map deletes the map
too, and any parent the delete leaves empty. An empty YAML map re-emits as `{}`, which corrupts
the next write into it.

`sync` takes an optional game, then any number of package ids. The first word after `sync` is
always the game name, so `gamecrate mods sync some.mod` reads `some.mod` as a game and fails
with `unknown game some.mod`. With no game, it walks every game. An id you name that has no
`git` entry stops the whole sync with exit `4`, listing every id it could not find. It fetches
with force, so it moves tag and commit pins that a launch leaves alone.

**A YAML write rewrites the whole file.** Comments, values, and quote style all survive, but the
original indentation and blank lines do not. A JSON or JSONC write changes only the bytes it
has to.

## Subcommands

The subcommand slot defaults to `run`, so `gamecrate rimworld dev` and
`gamecrate run rimworld dev` do the same thing.

| Subcommand | What it does |
| --- | --- |
| `run <game> [profile]` | Resolve, stage, and launch |
| `list [game]` | Games, profiles, and where each profile came from |
| `mods <game> [profile]` | The resolved mod set: source kind plus absolute path |
| `mods add <game> <source>` | Pin a mod into a library from a path, a workshop id, or a git URL |
| `mods rm <game> <id>...` | Drop library pins by package id |
| `mods sync [game] [id]...` | Fetch every git-pinned clone, fixed pins too |
| `doctor` | Preflight: Docker, CDI, registry auth, game dirs, scan roots, permissions |
| `clean <game> [profile]` | Tiered wipe of a profile |
| `clone <game> <src> <dst>` | Reflink-copy a profile's precious tier |
| `logs <game> [profile]` | Print the last run's captured logs. `-f` follows the live run instead |
| `attach <game> [profile]` | Stream a detached run's output from the start. Ctrl-C leaves the game running |
| `wait <game> [profile]` | Block until a detached run ends, then exit with its code |
| `ps` | Every live run: game, profile/instance, mode, pid, container, then uptime or status |
| `stop <game> [profile]` | Stop a detached run and release its lock |
| `build <game>` | Build or pull the runtime image, no launch |
| `shell <game> [profile]` | Same mounts, bash instead of the game |
| `verify <game> [profile]` | What the running container bound, and whether it looks current |
| `config edit` | Open the global config in `$VISUAL` or `$EDITOR`, validate on save |
| `fix-perms <game> [profile]` | Chown foreign-owned files back to the caller |
| `help [topic]` | Help for a subcommand or a game |
| `version` | Print the version |

`gamecrate help <game>` lists that game's profiles and modes. `gamecrate help completion bash`
and `gamecrate help completion zsh` print a shell completion script.

Game arguments go after a bare `--` and nowhere else.

## Flags

Mod set:

- `--mod <id>` adds a mod to the profile set. Repeatable.
- `--without <id>` drops a mod from the resolved set. Repeatable.
- `--only <id>` restricts the resolved set to these mods. Repeatable.
- `--use <packageId>=<path>` forces one mod to load from a directory. Repeatable.
- `--sort <topo|none>` picks the profile order or a topological sort.

Library writes. Only `--global` and `--project` reach `mods rm`; the rest are `mods add` only:

- `--path <dir>`, `--workshop <id>`, and `--git <url>` are the three source kinds. `mods add`
  takes exactly one.
- `--branch <name>`, `--tag <name>`, and `--commit <sha>` pin a `--git` source. Pick one.
- `--subdir <path>` starts the manifest walk below the repository root.
- `--global` writes the global config, `--project` the nearest `.gamecrate` file. `add` and `rm`
  need one of the two.
- `--force` overwrites a pin that is already there. `mods rm` has no force: a missing id always
  fails.

Worktrees and instances:

- `--worktree <path>` promotes mods from a linked git worktree, in its own instance. Repeatable,
  and earlier flags outrank later ones.
- `--no-worktree` turns worktree promotion off completely. It ignores the current directory,
  `$GAMECRATE_WORKTREE`, any `--worktree` flag you also typed, and an instance's configured
  `worktree`.
- `--instance <name>` runs under a named sub-profile with its own saves, logs, and container.

Display and lifetime:

- `--mode <headed|headless|screenshot>` chooses how the game displays.
- `--resolution <width>x<height>` overrides the game resolution.
- `--marker <str>` exits 0 as soon as that string appears in the log.
- `--timeout <seconds>` bounds a run with a `--marker`, in any mode, and a `--mode headless`
  run without one. A `--mode screenshot` run with no marker is bounded by `--render-wait`
  instead, and a headed run by its window, so neither of those reads this.
- `--render-wait <seconds>` sets the settle time before a screenshot.

Container and build:

- `--network <none|bridge|host>` sets the container network mode.
- `--pull <always|missing|never>` decides when to pull the runtime image.
- `--build` compiles local C# mods first. `--no-build` never compiles, even when an assembly
  looks stale.
- `--no-stale-check` drops the warning about sources newer than assemblies. The check still runs.
- `--docker-arg <arg>` adds one argv element to `docker run`. Repeatable.
- `--root` runs as root instead of mapping your uid.
- `--replace` stops whatever holds this profile and instance, then launches. `--no-replace`
  refuses instead.
- `--detach` launches in the background. `--no-detach` stays in the foreground, whatever the
  profile or the repo config asks for.

Output and dry runs:

- `--dry-run` resolves and validates fully, then writes nothing.
- `--print-plan` prints the resolved launch plan instead of launching.
- `--log <path>` routes launch output to one file.
- `--json` switches to machine-readable output.
- `-f`, `--follow` keeps printing as the run writes. `logs` takes it.

`clean` adds three tier flags: `--staging` (the default), `--logs`, and `--all`. `--all` deletes
saves, so it needs `--yes`.

## Detached runs

`--detach` re-executes gamecrate as a background supervisor. It writes the lock with that
supervisor's pid, prints the container name, and gives you the prompt back. The
supervisor owns the run from there. It pulls or builds the image, stages the mods, starts the
container, and records the exit.

Three things refuse a `--detach` you typed, and each says so:

- `shell` needs the terminal that `--detach` gives up.
- `--dry-run` has no run to supervise.
- `--print-plan` has no run to supervise.

The refusal is for the flag, not for detaching. A `detach: true` in a profile or a repo config
is a default, so `shell`, `--dry-run` and `--print-plan` ignore it and run in the foreground
without a word.

A profile or a repo config can set `detach: true`. `--no-detach` is the way past that.

### Read the result with `wait`

A detached launch returns `0` to your shell as soon as gamecrate writes the lock. That says
the supervisor started, and nothing about how the game ended. **`wait` is how a script gets the
real exit code.** It blocks until the run ends, then exits with that code:

```sh
gamecrate rimworld dev --detach
gamecrate wait rimworld dev
echo $?
```

gamecrate sends no desktop notification when a detached run fails. Nothing pops up and nothing
writes to your terminal, so `wait`, `ps`, and the `last-exit.json` file are the only ways to
learn about it. That file sits at `.gamecrate/last-exit.json` inside the instance directory,
whose name depends on how gamecrate hashes the worktree path, so a script cannot compute it.
Use `wait`.

`wait` exits `2` when no run was ever recorded, and `7` when the lock holder died without
recording an exit. `7` means the lock is stale: `gamecrate stop <game> <profile>` clears it.

### Watch a run that is already going

```sh
gamecrate ps
```

```
rimworld  mpf/simulator-test  headless  1474870  gamecrate-rimworld-mpf-simulator-test  Up 7 minutes
```

The columns are game, profile with its instance, mode, supervisor pid, container, and
uptime. A run that holds a lock but has no container yet reads `starting`, because staging and
the image come before `docker run`. A lock with no live supervisor reads `orphaned`, and
`ps` tells you to run `stop`.

`gamecrate attach <game> <profile>` streams that run's captured output from the beginning of
the log. Ctrl-C stops the stream and leaves the game running. `gamecrate logs <game> <profile>
-f` follows the same log from the end instead.

`gamecrate stop <game> <profile>` signals the supervisor and waits for the lock to be released.
It clears the lock itself only when the holder died first; a live supervisor releases its own.
It exits `7` when the lock still names a live process after the wait, and it does not look at
the container to decide that.

A run whose supervisor is already dead takes a different path: `stop` stops the container
itself, clears the stale lock, and exits `0`.

## Headed runs on X11

A headed run retitles its own window and fixes what the window manager knows about it. That
needs two programs on the host.

**`xprop` is load-bearing.** gamecrate writes its own pid onto the window it adopts, then reads
that pid back. That is how it tells its window apart from another run's. Without `xprop` it can
do neither, so two concurrent headed runs adopt the same window. Destroying that one window
tears down both containers, and the second run loses an unsaved game.

The titlebar X is the one close route that stays harmless without `xprop`. RimWorld claims
`WM_DELETE_WINDOW` and then ignores it, so that button does nothing until gamecrate strips the
claim. Stripping it takes `xprop`. Every other route to destroying the window, such as a window
manager shortcut or `xkill`, fires both teardowns.

With `xprop` installed, the strip is what makes the titlebar X end the run. The window manager
destroys the window, gamecrate sees it go, and stops that run's container.

A missing `wmctrl` costs more than the title. gamecrate warns and then skips the whole window
step, because the snapshot it needs comes from `wmctrl`. So the `WM_DELETE_WINDOW` strip never
runs even with `xprop` installed, the titlebar X goes back to doing nothing, and closing the
window no longer stops the container.

## Environment variables

Each variable stands in for one flag, and only when you leave that flag off:

`GAMECRATE_INSTANCE`, `GAMECRATE_MODE`, `GAMECRATE_MARKER`, `GAMECRATE_TIMEOUT`,
`GAMECRATE_RENDER_WAIT`, `GAMECRATE_NETWORK`, `GAMECRATE_PULL`, `GAMECRATE_BUILD`,
`GAMECRATE_SORT`, `GAMECRATE_ROOT`.

`GAMECRATE_WORKTREE` names a worktree to promote, and `--no-worktree` cancels it.

## Exit codes

- `0` success
- `1` the game itself failed
- `2` usage error
- `3` config error
- `4` resolution error
- `5` environment problem, such as a missing Docker
- `6` the marker never appeared before the timeout
- `7` refused, because this profile and instance already run
- `8` `verify` found a stale mod
- `130` interrupted

`wait` exits with whatever code the detached run recorded, which is any code in this list
except `8`, since only `verify` returns that and `verify` is never supervised.
A supervisor that fails before Docker records `3`, `4`, `5` or `7`.
`wait` hands that code back unchanged.
So a script must handle the whole list, not only the four codes a finished game uses.

## Write a plugin

A plugin is an ES module with a default export that satisfies `GamePlugin`. It takes plain data
and throws plain `Error` objects, so it never imports the gamecrate runtime at run time.

```ts
import type { GamePlugin } from '@gamecrate/cli'

const plugin: GamePlugin = {
  apiVersion: 1,
  game: 'mygame',
  defaults: { /* Partial<GameConfig> */ },
  parseManifest: (text) => null,
  renderModsConfig: (input) => '',
  mergePrefs: (existing, owned) => '',
  windowedPrefs: { fullscreen: 'False' },
  parseVersion: (text) => null,
}

export default plugin
```

The members:

- `apiVersion` must equal `PLUGIN_API_VERSION`, which is `1`. A mismatch fails the load with a
  message naming both numbers.
- `game` is the word the command line answers to, such as `rimworld`.
- `defaults` is a `Partial<GameConfig>`. It holds facts about the game itself, never about one
  machine. Leave install paths, workshop roots, scan roots, and images to the user.
- `parseManifest(text)` reads one mod manifest and returns a `ModManifest`, or `null` when the
  file is not a manifest at all. A malformed manifest throws.
- `renderModsConfig(input)` takes a version, a build number, the active package ids in load
  order, and the known expansions, then returns the file the engine reads.
- `mergePrefs(existing, owned)` folds the keys gamecrate owns into the player's own prefs file.
  `existing` is `null` on the first run.
- `windowedPrefs` lists the prefs keys that put the game in a window rather than fullscreen.
- `parseVersion(text)` reads the engine's own version file and returns a version string and a
  build number, or `null` when the text does not parse.

Load your plugin by path while you develop it:

```yaml
plugins: [~/projects/gamecrate-mygame/dist/index.js]
```

[`@gamecrate/rimworld`](../rimworld) is a complete example in about fifty lines.
