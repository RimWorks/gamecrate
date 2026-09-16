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

Your config lives at `~/.config/gamecrate/profiles.json`. If you set `XDG_CONFIG_HOME`, the
path moves with it. The file accepts JSONC, so comments and trailing commas are fine.

A minimal config for RimWorld:

```jsonc
{
  "plugins": ["@gamecrate/rimworld"],
  "games": {
    "rimworld": {
      // The plugin already says source: "mount" and container: "/game".
      "gameFiles": { "host": "~/games/RimWorld" },
      "image": { "ref": "ghcr.io/your-org/rimworld:1.6", "acquire": "pull" },
      "workshopRoot": "~/.steam/steam/steamapps/workshop/content/294100",
      "scanRoots": [{ "path": "~/projects/mods", "maxDepth": 2 }],
      "profiles": {
        "dev": { "mods": ["brrainz.harmony", "yourname.yourmod"] }
      }
    }
  }
}
```

Run `gamecrate config edit` to open the file in `$EDITOR` and validate it on save.

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
Arrays inside `settings`, which means `gameArgs` and `dockerArgs`, concatenate at every layer.

When a config error points at a key you never wrote, the message says which plugin's defaults
supplied it.

### Profiles

A profile names a mod set. `extends` inherits a parent profile's mods and appends its own.
`exclude` drops entries by glob. `alias` and `aliases` give one profile extra names, and they
share the parent's data directory. `instances` splits one profile into named sub-runs, each
with its own saves, logs, lock, and container.

gamecrate ships one profile of its own, `modless`. It resolves to the core game plus its
official DLC, and you cannot redefine it.

### Per-directory defaults

gamecrate looks for a `.gamecrate.yml` file in the current directory and every parent. Keys in
it stand in for flags you would otherwise type, so a mod repo can pin its own game, profile,
and extra Docker arguments:

```yaml
game: rimworld
profile: dev
mode: headed
```

A flag on the command line beats the file.

## Subcommands

The subcommand slot defaults to `run`, so `gamecrate rimworld dev` and
`gamecrate run rimworld dev` do the same thing.

| Subcommand | What it does |
| --- | --- |
| `run <game> [profile]` | Resolve, stage, and launch |
| `list [game]` | Games, profiles, and where each profile came from |
| `mods <game> [profile]` | The resolved mod set: source kind plus absolute path |
| `doctor` | Preflight: Docker, CDI, registry auth, game dirs, scan roots, permissions |
| `clean <game> <profile>` | Tiered wipe of a profile |
| `clone <game> <src> <dst>` | Reflink-copy a profile's precious tier |
| `logs <game> <profile>` | Print the last run's captured logs |
| `build <game>` | Build or pull the runtime image, no launch |
| `shell <game> [profile]` | Same mounts, bash instead of the game |
| `verify <game> [profile]` | What the running container bound, and whether it looks current |
| `config edit` | Open `profiles.json` in `$EDITOR`, validate on save |
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

Worktrees and instances:

- `--worktree <path>` promotes mods from a linked git worktree, in its own instance. Repeatable,
  and earlier flags outrank later ones.
- `--no-worktree` ignores the current directory and `$GAMECRATE_WORKTREE`.
- `--instance <name>` runs under a named sub-profile with its own saves, logs, and container.

Display and lifetime:

- `--mode <headed|headless|screenshot>` chooses how the game displays.
- `--resolution <width>x<height>` overrides the game resolution.
- `--marker <str>` exits 0 as soon as that string appears in the log.
- `--timeout <seconds>` kills the container after that long.
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

Output and dry runs:

- `--dry-run` resolves and validates fully, then writes nothing.
- `--print-plan` prints the resolved launch plan instead of launching.
- `--log <path>` routes launch output to one file.
- `--json` switches to machine-readable output.

`clean` adds three tier flags: `--staging` (the default), `--logs`, and `--all`. `--all` deletes
saves, so it needs `--yes`.

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

```jsonc
{
  "plugins": ["~/projects/gamecrate-mygame/dist/index.js"]
}
```

[`@gamecrate/rimworld`](../rimworld) is a complete example in about fifty lines.
