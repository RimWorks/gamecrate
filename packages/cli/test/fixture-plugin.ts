import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { GamePlugin, ModsConfigInput } from '../src/plugin'
import type { GameConfig, ModManifest } from '../src/types'

/**
 * A deliberately boring format so core tests never depend on a real game's codec: one
 * `key value` per line, `key [a b c]` for a list, `#` for a comment.
 */
export function parseFixtureManifest(text: string): ModManifest | null {
  const fields = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const gap = line.indexOf(' ')
    if (gap < 1) throw new Error(`malformed fixture manifest line: ${line}`)
    fields.set(line.slice(0, gap).toLowerCase(), line.slice(gap + 1).trim())
  }
  const packageId = fields.get('packageid')
  if (packageId === undefined || packageId === '') return null

  const list = (key: string): string[] => {
    const value = fields.get(key.toLowerCase())
    if (value === undefined) return []
    return value.replaceAll(/^\[|\]$/g, '').split(/\s+/).filter((item) => item !== '')
  }
  const manifest: ModManifest = {
    packageId,
    modDependencies: list('modDependencies').map((id) => ({ packageId: id })),
    loadAfter: list('loadAfter'),
    loadBefore: list('loadBefore'),
    forceLoadAfter: list('forceLoadAfter'),
    forceLoadBefore: list('forceLoadBefore'),
    incompatibleWith: list('incompatibleWith'),
  }
  const name = fields.get('name')
  if (name !== undefined) manifest.name = name
  return manifest
}

export function renderFixtureModsConfig(input: ModsConfigInput): string {
  return [
    `version ${input.version}`,
    `buildNumber ${input.buildNumber}`,
    `activeMods [${input.activeMods.join(' ')}]`,
    `knownExpansions [${input.knownExpansions.join(' ')}]`,
    '',
  ].join('\n')
}

export function mergeFixturePrefs(existing: string | null, owned: Record<string, string>): string {
  const entries = new Map<string, string>()
  for (const raw of (existing ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const gap = line.indexOf(' ')
    if (gap > 0) entries.set(line.slice(0, gap), line.slice(gap + 1))
  }
  for (const [key, value] of Object.entries(owned)) entries.set(key, value)
  const body = [...entries].map(([k, v]) => `${k} ${v}`).join('\n')
  return `${body}\n`
}

export const FIXTURE_DEFAULTS: Partial<GameConfig> = {
  gameFiles: { source: 'mount', host: '/fixtures/games/Atlas', container: '/game' },
  dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
  modsDir: { container: '/game/Mods' },
  logFile: { mode: 'arg', arg: '-logfile' },
  executable: './AtlasLinux',
  steamAppId: 294100,
  workshopRoot: null,
  scanRoots: [],
  manifest: { file: 'About/About.txt' },
  modsConfig: { file: 'Config/ModsConfig.txt' },
  prefs: { file: 'Config/Prefs.txt' },
  saveExtensions: ['sav'],
  core: 'atlasco.atlas',
  dlc: [],
  modes: ['headed', 'headless', 'screenshot'],
  profiles: {},
}

/** The minimal GameConfig validateConfig accepts. FIXTURE_DEFAULTS plus the one key it lacks. */
export function fixtureGame(): GameConfig {
  return structuredClone({
    ...FIXTURE_DEFAULTS,
    image: { ref: 'atlas:latest', acquire: 'pull' },
  }) as GameConfig
}

export function fixturePlugin(game = 'atlas', defaults: Partial<GameConfig> = {}): GamePlugin {
  return {
    apiVersion: 1,
    game,
    defaults: { ...FIXTURE_DEFAULTS, ...defaults },
    parseManifest: parseFixtureManifest,
    renderModsConfig: renderFixtureModsConfig,
    mergePrefs: mergeFixturePrefs,
    windowedPrefs: { fullscreen: 'False' },
    parseVersion: (text) => {
      if (text === '') return null
      const rev = /^(.+) rev(\d+)$/.exec(text)
      return rev ? { version: text, buildNumber: Number(rev[2]) } : { version: text, buildNumber: -1 }
    },
  }
}

export function pluginMap(...games: string[]): Map<string, GamePlugin> {
  return new Map(games.map((game) => [game, fixturePlugin(game)]))
}

/**
 * A plugin package on disk, entry under dist/ with a decoy index.js beside it, so anything that
 * ignores the package's own exports or main loads apiVersion 0 and fails loudly.
 */
export async function writePluginPackage(dir: string, exports: unknown, game = 'atlas'): Promise<void> {
  const defaults = {
    ...FIXTURE_DEFAULTS,
    image: { ref: 'atlas-build:latest', acquire: 'build', context: '/fixtures/docker' },
  }
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: basename(dir), type: 'module', exports }))
  await writeFile(join(dir, 'index.js'), 'export default { apiVersion: 0 }\n')
  await writeFile(
    join(dir, 'dist', 'plugin.js'),
    `export default {
      apiVersion: 1,
      game: ${JSON.stringify(game)},
      defaults: ${JSON.stringify(defaults)},
      parseManifest: () => null,
      renderModsConfig: () => '',
      mergePrefs: () => '',
      windowedPrefs: {},
      parseVersion: () => null,
    }\n`,
  )
}
