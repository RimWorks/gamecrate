# Configuration

Back to the [`@gamecrate/cli` README](../README.md).

## Where the file lives

Your config is `~/.config/gamecrate/config.<ext>`, or the same path under `XDG_CONFIG_HOME`. The
suffixes are `.yml`, `.yaml`, `.json`, and `.jsonc`, and the JSON reader takes comments and
trailing commas.

`gamecrate init` writes this, and `gamecrate config edit` opens it in `$VISUAL` or `$EDITOR`. The
placeholder path points nowhere, so `doctor` and `run` fail until you replace it:

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

## Root keys

`games` is required, and holds one block per game, keyed by the name a plugin claims. A nested
key is required only once its parent is present.

<!-- generated:root-keys -->

| Key | Type | Default | What it means |
| --- | --- | --- | --- |
| `plugins` | array of `string` |  | Plugins to load before the rest of the file. A `~`, `.` or `/` prefix is a path; anything else is a package name. |
| `dataRoot` | `string` | `~/.local/share/gamecrate` | Where saves, logs, locks, clones, and downloads go. |
| `defaults` | `object` |  | The bottom of the settings ladder, under the built-in values. |
| `defaults.settings` | settings |  | Settings for every game. |
| `buildConcurrency` | `number` |  | How many `dotnet build` runs go at once when a launch rebuilds stale mods. Default `3`. |
| `steamcmd` | `object` |  | Which `steamcmd` downloads workshop items. Absent looks on `PATH`, then runs the `steamcmd/steamcmd` image. |
| `steamcmd.path` | `string` |  | A steamcmd executable. One that is not fails with exit `5`, rather than falling back. |
| `prune` | `object` |  | What `gamecrate prune` deletes. Every key has a flag that overrides it for one run. |
| `prune.keepRuns` | `number` |  | How many run log directories a profile keeps. Every launch trims to this, and so does `prune`. Default `10`. |
| `prune.maxAgeDays` | `number` |  | How old something has to be before `prune` deletes it. Default `30`. |
| `prune.locks` | `boolean` |  | Delete a lock file whose process and container are both gone. Default `true`. |
| `prune.downloads` | `boolean` |  | Delete workshop downloads nothing touched in `maxAgeDays`. They come back on the next launch that needs them. Default `true`. |
| `prune.containers` | `boolean` |  | Delete exited containers gamecrate started. Default `true`. |

<!-- /generated:root-keys -->

## Where the game comes from

A `mount` game binds your own install into a runtime image that doesn't have the game in it, so it needs
`gameFiles.host`. An `image` game reads the game out of the image that
[`steam build`](images.md) produces, so it needs `image.ref` and nothing on this machine:

```yaml
games:
  rimworld:
    gameFiles:
      source: image
    image:
      ref: ghcr.io/you/rimworld-game:1.6
      acquire: pull
```

### Game config reference

<!-- generated:own-game-keys -->

| Key | Required | Type | What it means |
| --- | --- | --- | --- |
| `image` | yes | `object` | The image a launch runs. A `mount` game gets a runtime holding no game. |
| `image.ref` | yes | `string` | The image to run. A `mount` game that names none gets the published runtime base. |
| `image.context` | no | `string` | The docker build context. Naming one builds `ref`; leaving it out pulls `ref`. |
| `image.updates` | no | `object` | The staleness check a launch runs against the image registry. |
| `image.updates.check` | no | `boolean` | Whether a launch looks for a newer game build. Default `true`. |
| `image.updates.everyHours` | no | `number` | How long one answer lasts. Default `6`. `0` checks every launch. |
| `scanRoots` | yes | array of `object` | The directories walked to index local mods. It ships empty, so nothing is indexed until you add one. |
| `scanRoots[].path` | yes | `string` | The directory to walk. |
| `scanRoots[].maxDepth` | yes | `number` | How many levels below `path` a mod may sit. |
| `scanRoots[].exclude` | no | array of `string` | Globs skipped during the walk. |
| `library` | no | object of library entry | Where to get a mod from, keyed by `packageId`. |
| `aliases` | no | object of `string` | Maps a name you type to a `packageId`. It runs after an exact id match and before the short-name match. |
| `settings` | no | settings | Settings for this game, over the top-level `defaults`. |
| `profiles` | yes | object of profile | The mod sets you can launch, keyed by profile name. |

<!-- /generated:own-game-keys -->

### What the plugin already sets

A plugin's `defaults` fill these in, so a config writes only what is its own.

<!-- generated:plugin-game-keys -->

| Key | Required | Type | What it means |
| --- | --- | --- | --- |
| `gameFiles` | yes | `object` | Where the game files come from. |
| `gameFiles.source` | yes | `mount` or `image` | `mount` binds your own install read-only into a runtime image. `image` takes the game baked into the image, which `steam build` produces. |
| `gameFiles.host` | no | `string` | Your game install on this machine. Required while `source` is `mount`. |
| `gameFiles.container` | yes | `string` | Where the game files appear inside the container. |
| `dataDir` | yes | `object` | The directory the game writes saves, config, and logs into. |
| `dataDir.container` | yes | `string` | Where the data directory appears inside the container. |
| `dataDir.mode` | yes | `arg` or `env` | How the engine is told where its data is: a command-line `arg`, or `env` variables. |
| `dataDir.arg` | no | `string` | The argument carrying the data path. Required while `mode` is `arg`. |
| `dataDir.env` | no | object of `string` | Environment variables carrying the data path. Required while `mode` is `env`. |
| `modsDir` | yes | `object` | Where the staged mods land inside the container. |
| `modsDir.container` | yes | `string` | Where the staged mod tree is bind-mounted. Not necessarily under `dataDir`. |
| `modsDir.mask` | no | array of `string` | Extra mod roots inside the image, hidden with a `tmpfs` so the game cannot load them. |
| `logFile` | yes | `object` | Where the game's log comes from. |
| `logFile.mode` | yes | `arg` or `copy-out` | `arg` hands the game a log path. `copy-out` reads a log the game chose. |
| `logFile.arg` | no | `string` | The argument carrying the log path. Required while `mode` is `arg`. |
| `logFile.from` | no | `string` | The log path, relative to the data directory. Required while `mode` is `copy-out`. |
| `executable` | yes | `string` | The game binary, relative to the game files. |
| `managed` | no | array of `string` | The directories holding the assemblies `mods refs` points a csproj at. |
| `steamAppId` | yes | `number` | The game's steam app id, used for workshop downloads and `steam build`. |
| `workshopRoot` | yes | `string` or `null` | Your steam client's own workshop directory, or `null` when there is none to read. |
| `manifest` | yes | `object` | Where a mod declares its `packageId`, name, and dependencies. |
| `manifest.file` | yes | `string` | The manifest path inside a mod directory, parsed by the plugin. |
| `modsConfig` | yes | `object` | The game's own active-mod list, written before every launch. |
| `modsConfig.file` | yes | `string` | Path relative to the data directory. |
| `prefs` | yes | `object` | The game's own preferences file, merged before every launch. |
| `prefs.file` | yes | `string` | Path relative to the data directory. |
| `modSettingsDir` | no | `string` | Where mod settings files live, relative to the data directory. Absent means this game has none. |
| `version` | yes | `object` | Where the engine writes its version string. |
| `version.file` | yes | `string` | Path relative to the game files. |
| `steamBuild` | yes | `object` | How `steam build` turns a steam depot into images. |
| `steamBuild.branches` | yes | array of `object` | The branches to download from. The first is the default. Concatenated, matched on `name`. |
| `steamBuild.branches[].name` | yes | `string` | The steam branch name. |
| `steamBuild.branches[].password` | no | `boolean` | The branch needs a beta password, asked for at build time. |
| `steamBuild.branches[].tags` | no | array of `string` | Extra moving tags for this branch, beside the version and `latest` forms. |
| `steamBuild.branches[].executable` | no | object of `string` | Executable per variant name, when this branch ships a different one. |
| `steamBuild.variants` | yes | array of `object` | The images to build. The first is the default. |
| `steamBuild.variants[].name` | yes | `string` | The variant name, which becomes part of the image tag. |
| `steamBuild.variants[].depot` | no | `linux`, `windows` or `macos` | The platform depot to download. Defaults to `linux`. |
| `steamBuild.variants[].base` | yes | `linux`, `windows` or `none` | The runtime this build runs on. `windows` is the only base with wine, and `none` builds an image that cannot run. |
| `steamBuild.variants[].include` | yes | array of `string` | The paths to put in the image. Empty takes the whole depot. |
| `steamBuild.variants[].executable` | no | `string` | The binary for this variant, when it differs from the game default. |
| `records` | no | `object` | Where a mod writes the NDJSON records a run reads instead of raw container output. |
| `records.dir` | yes | `string` | Relative to the profile's config directory. |
| `records.mods` | yes | array of `string` | `packageIds` that write records there. |
| `records.enable` | no | mod settings file | Settings written before launch when one of `mods` is loaded, to turn record output on. |
| `saveExtensions` | yes | array of `string` | Filename suffixes that mean a save. `clean --all` counts them before it deletes. |
| `core` | yes | `string` | The base game's `packageId`. |
| `dlc` | yes | array of `string` | The official expansions, loaded after `core`. |
| `steamlessMod` | no | `string` | The `packageId` loaded in place of the steam client when steam is off. |
| `preCore` | no | array of `string` | Mods that must load before the base game. |
| `base` | no | array of `string` | Mods every profile of this game needs, loaded after the DLC. |
| `modes` | yes | array of `any` | The run modes this game supports: `headed`, `headless` or `screenshot`. |
| `ignoresWmDelete` | no | `boolean` | The engine claims WM_DELETE_WINDOW and drops it, so the titlebar X does nothing. |

<!-- /generated:plugin-game-keys -->

## Arrays replace instead of merging

Your `games.<name>` block merges over the plugin's defaults key by key. Objects merge, scalars
overwrite, and **an array you write replaces the plugin's array**. To add one DLC, copy the
plugin's full list and append to it.

Two arrays are exceptions. `steamBuild.branches` concatenates, matched on `name`. `gameArgs` and
`dockerArgs` concatenate at every settings layer.

### Settings

`settings` merges through five layers: the root `defaults`, then the game, the profile, the
instance, and the command line.

<!-- generated:settings-keys -->

| Key | Type | Default | What it means |
| --- | --- | --- | --- |
| `width` | `number` | `1920` | Window width in pixels. `--resolution` overrides it. |
| `height` | `number` | `1080` | Window height in pixels. `--resolution` overrides it. |
| `devMode` | `boolean` | `true` | Writes the game's own developer-mode preference. |
| `runInBackground` | `boolean` | `true` | Writes the game's own run-in-background preference. |
| `resetModsConfigOnCrash` | `boolean` | `false` | Forced to `false` when written, whatever you set. |
| `gpu` | `boolean` | `true` | Passes the card in. NVIDIA needs `/etc/cdi/nvidia.yaml`, AMD and Intel use `/dev/dri`, and a host with neither renders in software. |
| `audio` | `boolean` | `true` | Mounts the host audio sockets. |
| `input` | `boolean` | `false` | Mounts `/dev/input`. |
| `network` | `none`, `bridge` or `host` | `bridge` | The container network mode. |
| `display` | `x11` or `wayland` | `x11` | Only `x11` lets gamecrate retitle and close the window. |
| `memory` | `string` | `8g` | Container memory limit. |
| `cpus` | `number` | `6` | Container CPU limit. |
| `pidsLimit` | `number` | `1024` | Container process limit. |
| `prefsExtra` | object of `string` |  | Written into the prefs file verbatim. |
| `gameArgs` | array of `string` |  | Appended to the game command line. Concatenates across layers. |
| `dockerArgs` | array of `string` |  | Appended to `docker run`. Concatenates across layers. |

<!-- /generated:settings-keys -->

## Profiles

A profile is a mod set you launch by name. Every key is optional.

<!-- generated:profile-keys -->

| Key | Type | What it means |
| --- | --- | --- |
| `mods` | array of `any` | The mod set. Each entry is a `packageId` string, a mod entry object, or a match entry. |
| `extends` | `string` | Inherits a parent profile's mods, then appends its own. |
| `exclude` | array of `string` | Globs dropping entries from the resolved list. A child's list adds to its parent's. |
| `includeBase` | `boolean` | `false` leaves out the game's `base` list. |
| `autoDependencies` | `boolean` | Inserts each mod's declared dependencies ahead of it. On unless you set `false`. |
| `settings` | settings | Settings for this profile, over the game block. |
| `instances` | object of `object` | Named sub-runs of this profile, each with its own saves, logs, lock, and container. |
| `instances.<name>.worktree` | `string` | Wins over every other worktree request when you name this instance. |
| `instances.<name>.settings` | settings | Settings for this instance, over the profile. |
| `modSettings` | array of mod settings file | Mod settings files written before launch. |
| `alias` | `string` | Marks this profile as another name for an existing one. It cannot also set `mods` or `extends`. |
| `aliases` | array of `string` | Extra names this profile answers to. Every name shares one data directory. |
| `description` | `string` | A one-line note for `gamecrate list`. Never read by the launcher. |
| `gameVersion` | `string` | A tag on the game's own image repository, so `1.6` means `<repo>:1.6`. Reads the game out of the image. |
| `image` | `string` | A whole image reference, used verbatim. It beats `gameVersion`, and `--image` beats both. |
| `windowTitle` | `string` | The caption the window takes, instead of `<game> <profile>`. X11 only. |
| `windowIcon` | `string` | An icon path relative to the config file it appears in, read by ImageMagick. X11 only. |
| `detach` | `boolean` | Stands in for `--detach`. `--no-detach` overrides it. |
| `replace` | `boolean` | Stands in for `--replace`. `--no-replace` overrides it. |
| `steam` | `boolean` | Stands in for `--steam`. `--no-steam` overrides it. |
| `build` | `auto`, `always` or `never` | Stands in for `--build` and `--no-build`. |

<!-- /generated:profile-keys -->

gamecrate ships `modless`, and you cannot redefine it: `core` plus `dlc`, skipping `preCore` and
`base`. Every profile, instance, and game name must match `[A-Za-z0-9][A-Za-z0-9._-]*`, because
each name becomes a directory under `dataRoot`.

### A mod entry

An entry under `mods` is a `packageId` string, an object, or a match. A string can name a source
outright, as `workshop:2009463077` or `path:~/mods/x`. The object form:

<!-- generated:mod-entry-keys -->

| Key | Required | Type | What it means |
| --- | --- | --- | --- |
| `id` | yes | `string` | The `packageId` to load. |
| `workshop` | no | `number` | Pins the mod to this workshop item id. |
| `path` | no | `string` | Pins the mod to this directory. |
| `optional` | no | `boolean` | Turns a miss into a warning instead of a failed launch. |

<!-- /generated:mod-entry-keys -->

The match form takes a whole family at once:

<!-- generated:match-entry-keys -->

| Key | Required | Type | What it means |
| --- | --- | --- | --- |
| `match` | yes | `string` | A glob over every indexed `packageId`. |
| `first` | no | array of `string` | `packageIds` to load ahead of the rest of the match. |
| `sort` | no | `alpha` or `none` | How the rest of the match is ordered. |
| `minMatches` | no | `number` | Fails the launch when the match lands below this count. |

<!-- /generated:match-entry-keys -->

### A mod's own settings

Each entry in a profile's `modSettings` writes one file before launch.

<!-- generated:mod-settings-keys -->

| Key | Required | Type | What it means |
| --- | --- | --- | --- |
| `file` | yes | `string` | Path relative to the game's `modSettingsDir`. Climbing out of it fails with exit `3`. |
| `class` | yes | `string` | The type the engine writes on the settings block. |
| `values` | yes | object of `any` | The keys to write. A key already in the file keeps its value unless `replace` names it. |
| `replace` | no | array of `string` | Keys in `values` rewritten on every launch, instead of merged. |

<!-- /generated:mod-settings-keys -->

## Per-directory defaults

A `.gamecrate.<ext>` file in the current directory, or any parent, sets defaults for that tree.
It takes the same four suffixes, and two of them in one directory is the same error. A flag on
the command line beats the file, and an unknown key fails the load.

```yaml
game: rimworld
defaultProfile: dev
mode: headed
detach: true
dockerArgs: ['--cpus', '4']
```

These keys stand in for the flag of the same name:

```text
mods without only dockerArgs gameArgs worktree use marker instance log timeout renderWait
dryRun printPlan json root noWorktree noStaleCheck replace detach mode pull sort network
build resolution
```

Five are not flags. `game` names the game the file talks about, and `profiles`, `settings`, and
`library` all need it. `defaultProfile` picks the profile when you name none. A repo `settings`
block merges into `games.<game>.settings` at load time, so it is not a sixth layer. A repo
profile, or `library` pin, replaces the global one of that name outright.

**A `.gamecrate` file is untrusted input.** `mods`, `use`, `worktree`, `profiles`, and `library`
can all name directories on your disk to bind-mount into the container.

## The steamcmd binary

gamecrate downloads [workshop items](mod-sources.md#workshop-items) with `steamcmd`, and the root
`steamcmd.path` key says which one to run. With no `steamcmd` on `PATH` and no `docker`, a
download fails with exit `5`.
