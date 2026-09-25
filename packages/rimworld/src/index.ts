import type { GamePlugin } from '@gamecrate/cli'
import { mergePrefsXml, parseAboutXml, writeModsConfigXml } from './xml'

/** RimWorld ships "1.6.4871 rev598"; the number after rev is what ModsConfig calls the build. */
function parseVersion(text: string): { version: string; buildNumber: number } | null {
  if (text === '') return null
  const rev = /^(.+) rev(\d+)$/.exec(text)
  return rev ? { version: text, buildNumber: Number(rev[2]) } : { version: text, buildNumber: -1 }
}

const plugin: GamePlugin = {
  apiVersion: 2,
  game: 'rimworld',
  // Only what is true of the game itself. The install path, workshop root, scan roots and
  // image belong to whoever is running it, so they stay in profiles.json.
  defaults: {
    gameFiles: { source: 'mount', container: '/game' },
    dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
    modsDir: { container: '/game/Mods' },
    logFile: { mode: 'arg', arg: '-logfile' },
    executable: './RimWorldLinux',
    managed: ['RimWorldLinux_Data/Managed', '.'],
    // Verified on a native launch too, so this is the engine and not the container.
    ignoresWmDelete: true,
    steamAppId: 294100,
    // Where Steam put the workshop is this machine's business, so a profile has to say.
    workshopRoot: null,
    scanRoots: [],
    manifest: { file: 'About/About.xml' },
    modsConfig: { file: 'Config/ModsConfig.xml' },
    prefs: { file: 'Config/Prefs.xml' },
    version: { file: 'Version.txt' },
    steamBuild: {
      branches: [{ name: 'public' }],
      variants: [
        { name: 'linux', base: 'xvfb', include: [] },
        {
          name: 'windows',
          base: 'proton',
          include: [],
          depot: 'windows',
          executable: 'RimWorldWin64.exe',
        },
        {
          name: 'linux-ref',
          base: 'none',
          include: ['RimWorldLinux_Data/Managed', 'Version.txt'],
        },
      ],
    },
    saveExtensions: ['rws'],
    core: 'ludeon.rimworld',
    dlc: [
      'ludeon.rimworld.royalty',
      'ludeon.rimworld.ideology',
      'ludeon.rimworld.biotech',
      'ludeon.rimworld.anomaly',
      'ludeon.rimworld.odyssey',
    ],
    modes: ['headed', 'headless', 'screenshot'],
    // A mod's own server binds loopback inside the container, where -p cannot reach it.
    // Sharing the host netns is what makes RimObs' dashboard openable.
    settings: { network: 'host' },
    profiles: {},
  },
  parseManifest: parseAboutXml,
  renderModsConfig: ({ version, activeMods, knownExpansions }) =>
    writeModsConfigXml({ version, activeMods, knownExpansions }),
  mergePrefs: mergePrefsXml,
  windowedPrefs: { fullscreen: 'False' },
  parseVersion,
}

export default plugin
