# Writing a plugin

Back to the [`@gamecrate/cli` README](../README.md).

A plugin is an ES module with a default export that satisfies `GamePlugin`. It takes plain data
and throws plain `Error` objects, so it never imports the gamecrate runtime at run time.

```ts
import type { GamePlugin } from '@gamecrate/cli'

const plugin: GamePlugin = {
  apiVersion: 3,
  game: 'mygame',
  defaults: { /* Partial<GameConfig> */ },
  parseManifest: (text) => null,
  renderModsConfig: (input) => '',
  mergePrefs: (existing, owned) => '',
  renderModSettings: (existing, block) => '',
  windowedPrefs: { fullscreen: 'False' },
  parseVersion: (text) => null,
}

export default plugin
```

`GameConfig` and `ModManifest` are exported from `@gamecrate/cli` beside `GamePlugin`.

The members:

| Member | What it holds |
| --- | --- |
| `apiVersion` | Must equal `PLUGIN_API_VERSION`, which is `3` |
| `game` | The word the command line answers to, such as `rimworld`. It cannot be a subcommand name |
| `defaults` | A `Partial<GameConfig>` of facts about the game itself, never about one machine |
| `parseManifest` | Reads one mod manifest into a `ModManifest` |
| `renderModsConfig` | Returns the load-order file the engine reads |
| `mergePrefs` | Folds the keys gamecrate owns into the player's prefs file |
| `renderModSettings` | Optional. Returns one mod's settings file |
| `windowedPrefs` | The prefs keys that put the game in a window rather than fullscreen |
| `parseVersion` | Reads the engine's own version file |

Leave install paths, workshop roots, scan roots, and images out of `defaults`. Those belong to
the user.

`parseManifest` returns `null` when the file is not a manifest at all. A malformed manifest
throws, and the launch reports the file. `parseVersion` returns `null` on text it cannot read.

`renderModsConfig` takes a version, a build number, the active package ids in load order,
lowercased, and the known expansions.

`mergePrefs` takes `existing`, which is `null` on the first run, and `owned`. `owned` always
holds the screen size, `devMode`, `runInBackground`, `resetModsConfigOnCrash` as `False`, your
`windowedPrefs`, and the user's `prefsExtra`.

`renderModSettings` takes the file's current text, or `null`, and one settings block. The
block's `replace` names the keys that overwrite rather than merge. A plugin that leaves this
out, or a game config with no `modSettingsDir`, writes no mod settings at all.

A wrong `apiVersion` fails the load with `speaks apiVersion <n>, this build speaks 3`. A
missing `parseManifest`, `renderModsConfig`, `mergePrefs` or `parseVersion` fails too, and so
does an empty `game`, a `defaults` that is not an object, or a `windowedPrefs` that is not an
object. All of them print `plugin "<spec>": ...` and exit `3`.

Load your plugin by path while you develop it. A spec that starts with `~`, `.` or `/` is a
path, and `~` expands to your home directory:

```yaml
plugins: [~/projects/gamecrate-mygame/dist/index.js]
```

[`@gamecrate/rimworld`](../../rimworld) is a complete example. Its
[README](../../rimworld/README.md) lists which facts it ships and which it leaves to you.
