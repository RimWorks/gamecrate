import type { GamePlugin } from '@gamecrate/cli'

function unsupported(): never {
  throw new Error("elin's mod formats are not supported yet")
}

/** Elin on steam (app 2135150). Only the windows reference variant exists: managed dlls and BepInEx core. */
const plugin: GamePlugin = {
  apiVersion: 3,
  game: 'elin',
  defaults: {
    gameFiles: { source: 'image', container: '/game' },
    executable: 'Elin.exe',
    steamAppId: 2135150,
    version: { file: 'version.json' },
    steamBuild: {
      branches: [{ name: 'public' }],
      variants: [
        {
          name: 'windows-ref',
          base: 'none',
          depot: 'windows',
          include: [
            'Elin_Data/Managed',
            'BepInEx/core',
            'version.json',
            'Package/_ModdingKit/package.xml',
          ],
        },
      ],
    },
  },
  parseManifest: unsupported,
  renderModsConfig: unsupported,
  mergePrefs: unsupported,
  parseVersion: unsupported,
  windowedPrefs: {},
}

export default plugin
