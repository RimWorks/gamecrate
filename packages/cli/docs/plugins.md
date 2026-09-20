# Writing a plugin

Back to the [`@gamecrate/cli` README](../README.md).

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
- `game` is the word the command line answers to, such as `rimworld`. It cannot be a
  subcommand name.
- `defaults` is a `Partial<GameConfig>`. It holds facts about the game itself, never about one
  machine. Leave install paths, workshop roots, scan roots, and images to the user.
- `parseManifest(text)` reads one mod manifest and returns a `ModManifest`, or `null` when the
  file is not a manifest at all. A malformed manifest throws, and the launch reports the file.
- `renderModsConfig(input)` takes a version, a build number, the active package ids in load
  order, lowercased, and the known expansions, then returns the file the engine reads.
- `mergePrefs(existing, owned)` folds the keys gamecrate owns into the player's own prefs file.
  `existing` is `null` on the first run. `owned` always carries the screen size, `devMode`,
  `runInBackground`, `resetModsConfigOnCrash` as `False`, your `windowedPrefs`, and the user's
  `prefsExtra`.
- `windowedPrefs` lists the prefs keys that put the game in a window rather than fullscreen.
- `parseVersion(text)` reads the engine's own version file and returns a version string and a
  build number, or `null` when the text does not parse.

The loader checks all of that up front. A missing function, an empty `game`, or a `defaults`
that is not an object fails with `plugin "<spec>": ...` and exit `3`.

Load your plugin by path while you develop it:

```yaml
plugins: [~/projects/gamecrate-mygame/dist/index.js]
```

[`@gamecrate/rimworld`](../../rimworld) is a complete example in about fifty lines. Its
[README](../../rimworld/README.md) lists which facts it ships and which it leaves to you.
