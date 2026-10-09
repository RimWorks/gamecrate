import { join } from 'node:path'

import type { GamePlugin } from '@gamecrate/cli'
import { mergePrefsXml, parseAboutXml, writeModsConfigXml, renderModSettings } from './xml'

function parseVersion(text: string): { version: string; buildNumber: number } | null {
  if (text === '') return null
  const rev = /^(.+) rev(\d+)$/.exec(text)
  return rev ? { version: text, buildNumber: Number(rev[2]) } : { version: text, buildNumber: -1 }
}

const plugin: GamePlugin = {
  apiVersion: 3,
  game: 'rimworld',
  defaults: {
    gameFiles: { source: 'mount', container: '/game' },
    dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
    modsDir: { container: '/game/Mods' },
    logFile: { mode: 'arg', arg: '-logfile' },
    executable: './RimWorldLinux',
    managed: ['RimWorldLinux_Data/Managed', '.'],
    ignoresWmDelete: true,
    steamAppId: 294100,
    workshopRoot: null,
    scanRoots: [],
    manifest: { file: 'About/About.xml' },
    modsConfig: { file: 'Config/ModsConfig.xml' },
    prefs: { file: 'Config/Prefs.xml' },
    modSettingsDir: 'Config',
    version: { file: 'Version.txt' },
    records: {
      dir: 'config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios/RimLogging',
      mods: ['RimWorks.RimLogging'],
      enable: {
        file: 'Mod_RimLogging_LoggingMod.xml',
        class: 'RimWorks.RimLogging.Settings.LoggingSettings',
        values: { sinkOverrideNames: ['RollingJson'], sinkOverrideStates: [true] },
        replace: ['sinkOverrideNames', 'sinkOverrideStates'],
      },
    },
    steamBuild: {
      branches: [{ name: 'public' }],
      variants: [
        { name: 'linux', base: 'linux', include: [] },
        {
          name: 'windows',
          base: 'windows',
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
    steamlessMod: 'CryptikLemur.NoSteamPopup',
    library: {
      'CryptikLemur.NoSteamPopup': { path: join(import.meta.dirname, '..', 'mods', 'NoSteamPopup') },
      'concordlib.concord': { workshop: 3758333473 },
    },
    modes: ['headed', 'headless', 'screenshot'],
    settings: { network: 'host' },
    profiles: {},
  },
  parseManifest: parseAboutXml,
  renderModsConfig: ({ version, activeMods, knownExpansions }) =>
    writeModsConfigXml({ version, activeMods, knownExpansions }),
  mergePrefs: mergePrefsXml,
  renderModSettings,
  windowedPrefs: { fullscreen: 'False' },
  parseVersion,
}

export default plugin
