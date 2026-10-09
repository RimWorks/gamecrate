import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fixtureGame, fixturePlugin } from './fixture-plugin'
import { cloneDir } from '../src/mods/source'
import { Exit, GamecrateError } from '../src/types'
import type {
  GameConfig,
  LaunchPlan,
  ModIndex,
  ModRecord,
  Problem,
  ProfileConfig,
  RootConfig,
} from '../src/types'

let index: ModIndex = emptyIndex()

const { resolvePlan } = await import('../src/launch/resolve')
const { globToRegExp } = await import('../src/config/load')
const { planWarnings } = await import('../src/cli/output')
const { stageMods, ensureProfileTree, detectForeignOwnership } = await import('../src/launch/stage')
const { generateModsConfig, mergePrefs } = await import('../src/launch/generate')

function emptyIndex(): ModIndex {
  return {
    game: 'test',
    plugin: fixturePlugin(),
    byPackageId: new Map(),
    byWorkshopId: new Map(),
    byShortName: new Map(),
    problems: [],
  }
}

interface ModSpec {
  id: string
  dir: string
  kind?: ModRecord['kind']
  workshopId?: number
  dependencies?: (string | { packageId: string; steamWorkshopUrl: string })[]
  loadAfter?: string[]
  loadBefore?: string[]
  forceLoadAfter?: string[]
  forceLoadBefore?: string[]
  incompatibleWith?: string[]
}

function makeIndex(specs: ModSpec[]): ModIndex {
  const built = emptyIndex()
  for (const spec of specs) {
    const record: ModRecord = {
      packageId: spec.id,
      dir: spec.dir,
      kind: spec.kind ?? 'local',
      manifest: {
        packageId: spec.id,
        modDependencies: (spec.dependencies ?? []).map((dep) => (typeof dep === 'string' ? { packageId: dep } : dep)),
        loadAfter: spec.loadAfter ?? [],
        loadBefore: spec.loadBefore ?? [],
        forceLoadAfter: spec.forceLoadAfter ?? [],
        forceLoadBefore: spec.forceLoadBefore ?? [],
        incompatibleWith: spec.incompatibleWith ?? [],
      },
      ...(spec.workshopId === undefined ? {} : { workshopId: spec.workshopId }),
      linkedWorktree: false,
      rootIndex: 0,
    }
    built.byPackageId.set(spec.id.toLowerCase(), [record])
    if (record.workshopId !== undefined) built.byWorkshopId.set(record.workshopId, record)
  }
  return built
}

let tmp = ''

function atlas(profiles: Record<string, ProfileConfig>): GameConfig {
  return {
    gameFiles: { source: 'mount', host: join(tmp, 'Atlas'), container: '/game' },
    dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
    modsDir: { container: '/game/Mods' },
    logFile: { mode: 'arg', arg: '-logfile' },
    image: { ref: 'atlas-build:latest' },
    executable: './AtlasLinux',
    steamAppId: 294100,
    workshopRoot: null,
    scanRoots: [],
    manifest: { file: 'About/About.txt' },
    modsConfig: { file: 'Config/ModsConfig.txt' },
    prefs: { file: 'Config/Prefs.txt' },
    version: { file: 'Version.txt' },
    steamBuild: { branches: [{ name: 'public' }], variants: [{ name: 'linux', base: 'linux', include: [] }] },
    saveExtensions: ['sav'],
    core: 'Atlasco.Atlas',
    dlc: ['Atlasco.Atlas.Royalty', 'Atlasco.Atlas.Ideology'],
    base: ['Patchlib.Patch'],
    modes: ['headed', 'headless', 'screenshot'],
    profiles,
  }
}

function beacon(profiles: Record<string, ProfileConfig>): GameConfig {
  return {
    gameFiles: { source: 'mount', host: join(tmp, 'Beacon'), container: '/opt/beacon' },
    dataDir: { container: '/data/Beacon Studios/Beacon', mode: 'env', env: { XDG_DATA_HOME: '/data' } },
    modsDir: { container: '/data/Beacon Studios/Beacon/SaveData/Mods', mask: ['/opt/beacon/Mods'] },
    logFile: { mode: 'copy-out', from: 'Logs/' },
    image: { ref: 'beacon-game-play-base:latest' },
    executable: './Beacon',
    steamAppId: 294100,
    workshopRoot: null,
    scanRoots: [],
    manifest: { file: 'About/About.txt' },
    modsConfig: { file: 'SaveData/Config/ModsConfig.txt' },
    prefs: { file: 'SaveData/Prefs.txt' },
    version: { file: 'Version.txt' },
    steamBuild: { branches: [{ name: 'public' }], variants: [{ name: 'linux', base: 'linux', include: [] }] },
    saveExtensions: ['sav'],
    core: 'Atlasco.Beacon',
    dlc: [],
    preCore: ['Lib.Bridge.Beacon'],
    base: ['Example.ModManager'],
    modes: ['headed', 'headless', 'screenshot'],
    profiles,
  }
}

const ATLAS_PLUGIN = fixturePlugin('atlas')
const BEACON_PLUGIN = {
  ...fixturePlugin('beacon'),
  windowedPrefs: { displayMode: 'Windowed' },
  parseVersion: (text: string) => {
    const dotted = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(text)
    return dotted ? { version: `${dotted[1]} rev${dotted[2]}`, buildNumber: Number(dotted[2]) } : null
  },
}
const PLUGINS = new Map([
  ['atlas', ATLAS_PLUGIN],
  ['beacon', BEACON_PLUGIN],
])

function rootFor(game: string, config: GameConfig): RootConfig {
  return { dataRoot: join(tmp, 'data'), defaults: { settings: {} }, games: { [game]: config } }
}

async function modDir(name: string): Promise<string> {
  const dir = join(tmp, 'mods', name)
  await mkdir(dir, { recursive: true })
  return dir
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-resolve-'))
  await mkdir(join(tmp, 'Atlas', 'Data', 'Core', 'About'), { recursive: true })
  await mkdir(join(tmp, 'Atlas', 'Data', 'Royalty', 'About'), { recursive: true })
  await mkdir(join(tmp, 'Atlas', 'Data', 'Ideology', 'About'), { recursive: true })
  await writeFile(join(tmp, 'Atlas', 'Version.txt'), '1.6.4871 rev598\n')
  await writeFile(join(tmp, 'Atlas', 'Data', 'Core', 'About', 'About.txt'), 'packageId Atlasco.Atlas\n')
  await writeFile(
    join(tmp, 'Atlas', 'Data', 'Royalty', 'About', 'About.txt'),
    'packageId Atlasco.Atlas.Royalty\nmodDependencies [Patchlib.Patch]\n',
  )
  await writeFile(
    join(tmp, 'Atlas', 'Data', 'Ideology', 'About', 'About.txt'),
    'packageId Atlasco.Atlas.Ideology\n',
  )
  await mkdir(join(tmp, 'Beacon'), { recursive: true })
  await writeFile(join(tmp, 'Beacon', 'Version.txt'), '0.0.2145.1260\n')
})

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

describe('load-slot ordering', () => {
  test('preCore, core, dlc, base, then profile mods in written order', async () => {
    const game = beacon({ qol: { mods: ['Example.Tweaks', 'Example.ColonistBar'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Tweaks', dir: await modDir('QoLs') },
      { id: 'Example.ColonistBar', dir: await modDir('ColonistBar') },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Lib.Bridge.Beacon',
      'Atlasco.Beacon',
      'Example.ModManager',
      'Example.Tweaks',
      'Example.ColonistBar',
    ])
  })

  test('atlas puts every dlc after core and before base', async () => {
    const game = atlas({ dsd: { mods: ['Example.Storyteller'] } })
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('rw-royalty'), kind: 'official' },
      { id: 'Atlasco.Atlas.Ideology', dir: await modDir('rw-ideology'), kind: 'official' },
      { id: 'Patchlib.Patch', dir: await modDir('harmony'), kind: 'workshop', workshopId: 2009463077 },
      { id: 'Example.Storyteller', dir: await modDir('dsd') },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Atlasco.Atlas',
      'Atlasco.Atlas.Royalty',
      'Atlasco.Atlas.Ideology',
      'Patchlib.Patch',
      'Example.Storyteller',
    ])
    expect(plan.mods[3]!.workshopId).toBe(2009463077)
    expect(plan.mods[4]!.containerDir).toBe('/game/Mods/Example.Storyteller')
  })

  test('modless drops preCore and base but keeps core and dlc', async () => {
    const game = atlas({})
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('rw-royalty'), kind: 'official' },
      { id: 'Atlasco.Atlas.Ideology', dir: await modDir('rw-ideology'), kind: 'official' },
      { id: 'Patchlib.Patch', dir: await modDir('harmony'), kind: 'workshop' },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'modless',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Atlasco.Atlas',
      'Atlasco.Atlas.Royalty',
      'Atlasco.Atlas.Ideology',
    ])
  })
})

describe('a profile id is satisfied by a --mod path: ref', () => {
  test('an id the index never scanned resolves from the path ref alone', async () => {
    const dir = await modDir('Pickle')
    await mkdir(join(dir, 'About'), { recursive: true })
    await writeFile(join(dir, 'About', 'About.txt'), 'packageId Rimworks.Pickle\n')

    const game = beacon({ ci: { mods: ['Rimworks.Pickle'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'ci',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      args: { mods: [`path:${dir}`] },
    })

    expect(problems).toEqual([])
    expect(plan.mods.filter((m) => m.packageId === 'Rimworks.Pickle')).toHaveLength(1)
    expect(plan.mods.find((m) => m.packageId === 'Rimworks.Pickle')?.hostDir).toBe(dir)
  })

  test('a scanned copy still wins the bare id when a path ref names another dir', async () => {
    const scanned = await modDir('Scanned-Twin')
    const handed = await modDir('Handed-Twin')
    for (const dir of [scanned, handed]) {
      await mkdir(join(dir, 'About'), { recursive: true })
      await writeFile(join(dir, 'About', 'About.txt'), 'packageId Example.Twin\n')
    }

    const game = beacon({ ci: { mods: ['Example.Twin'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Twin', dir: scanned },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'ci',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      args: { mods: [`path:${handed}`] },
    })

    expect(problems).toEqual([])
    expect(plan.mods.find((m) => m.packageId === 'Example.Twin')?.hostDir).toBe(scanned)
  })
})

describe('CLI setting overrides', () => {
  test('resolution overrides profile settings', async () => {
    const game = beacon({ qol: { mods: [], settings: { width: 1280, height: 720 } } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
    ])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      args: { resolution: { width: 2560, height: 1440 } },
    })
    expect(plan.settings.width).toBe(2560)
    expect(plan.settings.height).toBe(1440)
  })
})

describe('dynamic match entries', () => {
  test('Kitted.* puts first entries ahead and sorts the rest', async () => {
    const game = beacon({
      kitted: { mods: [{ match: 'Kitted.*', first: ['Kitted.Core'], sort: 'alpha', minMatches: 1 }] },
    })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Kitted.Ridge', dir: await modDir('Ridge') },
      { id: 'Kitted.Core', dir: await modDir('KittedCore') },
      { id: 'Kitted.Roshar', dir: await modDir('Roshar') },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'kitted',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Lib.Bridge.Beacon',
      'Atlasco.Beacon',
      'Example.ModManager',
      'Kitted.Core',
      'Kitted.Ridge',
      'Kitted.Roshar',
    ])
  })

  test('alpha order is code-unit, not locale collation', async () => {
    const game = beacon({
      kitted: { mods: [{ match: 'Kitted.*', first: ['Kitted.Core'], sort: 'alpha', minMatches: 1 }] },
    })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Kitted.Ähr', dir: await modDir('Ahr') },
      { id: 'Kitted.Core', dir: await modDir('KittedCore') },
      { id: 'Kitted.Bee', dir: await modDir('Bee') },
      { id: 'Kitted.Zephyr', dir: await modDir('Zephyr') },
    ])
    const tail = ['Kitted.Bee', 'Kitted.Zephyr', 'Kitted.Ähr']
    expect([...tail].sort((a, b) => a.localeCompare(b))).not.toEqual(tail)

    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'kitted',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Lib.Bridge.Beacon',
      'Atlasco.Beacon',
      'Example.ModManager',
      'Kitted.Core',
      ...tail,
    ])
  })

  test('zero matches under minMatches is a problem, not a throw', async () => {
    const game = beacon({
      kitted: { mods: [{ match: 'Kitted.*', first: ['Kitted.Core'], minMatches: 1 }] },
    })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'kitted',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('matched 0 mod(s)')
    expect(plan.mods).toHaveLength(3)
  })

  test('glob matching ignores case and escapes dots', () => {
    expect(globToRegExp('Kitted.*').test('kitted.core')).toBe(true)
    expect(globToRegExp('Kitted.*').test('KittedXcore')).toBe(false)
  })
})

describe('autoDependencies', () => {
  test('inserts a missing dependency before its dependent, transitively', async () => {
    const game = beacon({
      sundial: { mods: ['Example.Sundial'], autoDependencies: true },
    })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Sundial', dir: await modDir('Sundial'), dependencies: ['Kitted.Core'] },
      { id: 'Kitted.Core', dir: await modDir('KittedCore'), dependencies: ['Lib.Bridge.Beacon'] },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toEqual([])
    const ids = plan.mods.map((m) => m.packageId)
    expect(ids).toEqual([
      'Lib.Bridge.Beacon',
      'Atlasco.Beacon',
      'Example.ModManager',
      'Kitted.Core',
      'Example.Sundial',
    ])
    expect(plan.mods.find((m) => m.packageId === 'Kitted.Core')!.explicit).toBe(false)
    expect(plan.mods.find((m) => m.packageId === 'Example.Sundial')!.explicit).toBe(true)
  })

  test('an unresolvable dependency is a problem, and the rest still resolve', async () => {
    const game = beacon({ sundial: { mods: ['Example.Sundial'], autoDependencies: true } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Sundial', dir: await modDir('Sundial'), dependencies: ['Nobody.Missing'] },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('Nobody.Missing')
    expect(plan.mods).toHaveLength(4)
  })

  test('dependencies stay uninserted when autoDependencies is off', async () => {
    const game = beacon({ sundial: { mods: ['Example.Sundial'], autoDependencies: false } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Sundial', dir: await modDir('Sundial'), dependencies: ['Kitted.Core'] },
      { id: 'Kitted.Core', dir: await modDir('KittedCore') },
    ])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(plan.mods.map((m) => m.packageId)).not.toContain('Kitted.Core')
  })

  test('a declared dependency is inserted by default', async () => {
    const game = beacon({ sundial: { mods: ['Example.Sundial'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Sundial', dir: await modDir('Sundial'), dependencies: ['Kitted.Core'] },
      { id: 'Kitted.Core', dir: await modDir('KittedCore') },
    ])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(plan.mods.map((m) => m.packageId)).toContain('Kitted.Core')
  })
})

describe('unfetched workshop items are labelled, not called missing', () => {
  const URL_FOR = (id: string): string => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`

  async function sundial(dependencies: ModSpec['dependencies']): Promise<GameConfig> {
    const game = beacon({ sundial: { mods: ['Example.Sundial'], autoDependencies: true } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Sundial', dir: await modDir('Sundial'), dependencies },
    ])
    return game
  }

  test('a dependency whose workshop item was not fetched reads as unfetched', async () => {
    const game = await sundial([{ packageId: 'Nobody.Missing', steamWorkshopUrl: URL_FOR('818773962') }])
    const { problems } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      unfetched: ['818773962'],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('818773962')
    expect(problems[0]!.message).toContain('fetching is off')
    expect(problems[0]!.message).not.toContain('not installed')
  })

  test('a dependency with no workshop url keeps the not-installed problem', async () => {
    const game = await sundial(['Nobody.Missing'])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      unfetched: ['818773962'],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('Nobody.Missing')
    expect(problems[0]!.message).toContain('not installed')
    expect(plan.warnings.filter((w) => w.includes('provisional'))).toHaveLength(1)
  })

  test('a workshop ref of an unfetched item is not a no-mod-matches', async () => {
    const game = atlas({ dsd: { mods: ['workshop:2009463077'] } })
    game.dlc = []
    game.base = []
    game.workshopRoot = join(tmp, 'workshop')
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('wsr-core'), kind: 'core' }])
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      unfetched: ['2009463077'],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('a real launch would fetch it')
    expect(problems[0]!.message).not.toContain('no mod matches')
  })

  test('an unfetched workshop ref says a real launch would fetch it', async () => {
    const game = atlas({ dsd: { mods: ['workshop:2009463077'] } })
    game.dlc = []
    game.base = []
    game.workshopRoot = null
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('wsr-null-core'), kind: 'core' }])
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      unfetched: ['2009463077'],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('a real launch would fetch it')
    expect(problems[0]!.message).not.toContain('cannot resolve')
  })

  test('the provisional notice leads the warnings once, however many ids', async () => {
    const game = await sundial([])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      unfetched: ['1', '2', '3'],
    })
    expect(plan.warnings.filter((w) => w.includes('provisional'))).toHaveLength(1)
    expect(plan.warnings[0]).toContain('3 workshop item(s)')
  })

  test('no unfetched ids means no notice, and dependencies resolve as before', async () => {
    const game = beacon({ sundial: { mods: ['Example.Sundial'], autoDependencies: true } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Sundial', dir: await modDir('Sundial'), dependencies: ['Kitted.Core'] },
      { id: 'Kitted.Core', dir: await modDir('KittedCore'), dependencies: ['Lib.Bridge.Beacon'] },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'sundial',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.warnings.filter((w) => w.includes('provisional'))).toEqual([])
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Lib.Bridge.Beacon',
      'Atlasco.Beacon',
      'Example.ModManager',
      'Kitted.Core',
      'Example.Sundial',
    ])
  })
})

describe('sorting, exclusion and warnings', () => {
  test('--sort topo honours forceLoadBefore against the written order', async () => {
    const game = beacon({ qol: { mods: ['Example.Tweaks'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern'), forceLoadBefore: ['Atlasco.Beacon'] },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      {
        id: 'Example.ModManager',
        dir: await modDir('ModManager'),
        loadAfter: ['Example.Tweaks'],
      },
      { id: 'Example.Tweaks', dir: await modDir('QoLs') },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      args: { sort: 'topo' },
    })
    expect(problems).toEqual([])
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Lib.Bridge.Beacon',
      'Atlasco.Beacon',
      'Example.Tweaks',
      'Example.ModManager',
    ])
  })

  test('a load-order cycle is a problem, and every mod still ships', async () => {
    const game = beacon({ qol: { mods: ['Example.Tweaks'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      {
        id: 'Example.ModManager',
        dir: await modDir('ModManager'),
        loadAfter: ['Example.Tweaks'],
      },
      {
        id: 'Example.Tweaks',
        dir: await modDir('QoLs'),
        loadAfter: ['Example.ModManager'],
      },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      args: { sort: 'topo' },
    })
    expect(problems.some((p) => p.message.includes('cycle'))).toBe(true)
    expect(plan.mods).toHaveLength(4)
  })

  test('exclude and --without subtract inherited entries', async () => {
    const game = beacon({ qol: { mods: ['Example.Tweaks'], exclude: ['Example.ModManager'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Tweaks', dir: await modDir('QoLs') },
    ])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
      args: { without: ['Lib.Bridge.*'] },
    })
    expect(plan.mods.map((m) => m.packageId)).toEqual(['Atlasco.Beacon', 'Example.Tweaks'])
  })

  test('incompatibleWith warns and never fails', async () => {
    const game = beacon({ qol: { mods: ['Example.Tweaks'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      {
        id: 'Example.Tweaks',
        dir: await modDir('QoLs'),
        incompatibleWith: ['Example.ModManager'],
      },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.warnings.some((w) => w.includes('incompatible'))).toBe(true)
    expect(plan.mods).toHaveLength(4)
  })

  test('a mutual incompatibility warns once whatever order the ids arrive in', async () => {
    const game = beacon({ qol: { mods: ['Kitted.Ähr', 'Kitted.Bee'] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Kitted.Ähr', dir: await modDir('Ahr'), incompatibleWith: ['Kitted.Bee'] },
      { id: 'Kitted.Bee', dir: await modDir('Bee'), incompatibleWith: ['Kitted.Ähr'] },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.warnings.filter((w) => w.includes('incompatible'))).toHaveLength(1)
  })

  test('an unknown mod is a problem, an optional one is only a warning', async () => {
    const game = beacon({
      qol: { mods: ['Nobody.Missing', { id: 'Nobody.Optional', optional: true }] },
    })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('Nobody.Missing')
    expect(plan.warnings.some((w) => w.includes('Nobody.Optional'))).toBe(true)
  })

  test('a declared dlc nobody owns is skipped, not a problem or a warning', async () => {
    const game = atlas({ dsd: { mods: [] } })
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('rw-royalty'), kind: 'official' },
      { id: 'Patchlib.Patch', dir: await modDir('harmony'), kind: 'workshop' },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Atlasco.Atlas',
      'Atlasco.Atlas.Royalty',
      'Patchlib.Patch',
    ])
    expect(plan.warnings.filter((w) => w.includes('Ideology'))).toEqual([])
  })

  test('a missing core is still fatal', async () => {
    const game = atlas({ dsd: { mods: [] } })
    index = makeIndex([{ id: 'Patchlib.Patch', dir: await modDir('harmony'), kind: 'workshop' }])
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems.map((p) => p.where)).toEqual(['/games/atlas/core'])
    expect(problems[0]!.message).toContain('Atlasco.Atlas')
  })

  test('a missing base mod is still fatal, unlike a dlc', async () => {
    const game = atlas({ dsd: { mods: [] } })
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
    ])
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems.map((p) => p.where)).toEqual(['/games/atlas/base/0'])
  })

  test('a ref naming an Object.prototype member is a miss, not a crash', async () => {
    const game = atlas({ dsd: { mods: [] } })
    game.dlc = []
    game.base = []
    game.aliases = { hugs: 'Patchlib.Patch' }
    game.library = { 'patchlib.patch': { workshop: 2009463077 } }
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' }])
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      args: { mods: ['constructor', 'toString', 'valueOf', '__proto__'] },
    })
    expect(problems.map((p) => p.message)).toEqual([
      'no mod matches "constructor"',
      'no mod matches "toString"',
      'no mod matches "valueOf"',
      'no mod matches "__proto__"',
    ])
  })

  test('a profile named after a prototype member is unknown, not empty', async () => {
    const game = atlas({ dsd: { mods: [] } })
    for (const name of ['toString', 'constructor']) {
      await expect(
        resolvePlan({ game: 'atlas', profile: name, plugins: PLUGINS, root: rootFor('atlas', game), index }),
      ).rejects.toThrow(/unknown profile/)
    }
  })

  test('a game named after a prototype member is unknown', async () => {
    const game = atlas({ dsd: { mods: [] } })
    await expect(
      resolvePlan({ game: 'toString', profile: 'dsd', plugins: PLUGINS, root: rootFor('atlas', game), index }),
    ).rejects.toThrow(/unknown game/)
  })

  test('a data path containing "=" is reported before anything runs', async () => {
    const game = atlas({})
    game.dataDir = { container: '/data=x', mode: 'arg', arg: '-savedatafolder=/data=x' }
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' }])
    game.dlc = []
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'modless',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems).toHaveLength(2)
    expect(problems.every((p) => p.message.includes('='))).toBe(true)
  })
})

describe('staleness', () => {
  test('a stale mod carries a report that names the file', async () => {
    const dir = await modDir('StaleMod')
    await mkdir(join(dir, 'Source'), { recursive: true })
    await mkdir(join(dir, 'Assemblies'), { recursive: true })
    await writeFile(join(dir, 'Assemblies', 'StaleMod.dll'), 'x')
    await writeFile(join(dir, 'Source', 'Main.cs'), 'class X {}')
    const old = new Date(Date.now() - 60_000)
    await utimes(join(dir, 'Assemblies', 'StaleMod.dll'), old, old)

    const game = atlas({ dev: { mods: ['Stale.Mod'] } })
    game.dlc = []
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
      { id: 'Patchlib.Patch', dir: await modDir('Harmony') },
      { id: 'Stale.Mod', dir },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dev',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })

    const mod = plan.mods.find((m) => m.packageId === 'Stale.Mod')!
    expect(mod.stale).toBe(true)
    expect(mod.staleReport?.newestSource).toBe(join('Source', 'Main.cs'))
    expect(mod.staleReport?.assembly).toBe(join('Assemblies', 'StaleMod.dll'))
    expect(mod.staleReport?.newerCount).toBe(1)

    const warning = planWarnings(plan).find((w) => w.startsWith('Stale.Mod '))!
    expect(warning).toContain('1 source file newer than Assemblies/StaleMod.dll')
    expect(warning).toContain(`newest: ${join('Source', 'Main.cs')}`)
    expect(warning).toContain('you are probably running a stale build')
  })

  test('--no-stale-check keeps the report but drops the warning', async () => {
    const dir = await modDir('QuietMod')
    await mkdir(join(dir, 'Source'), { recursive: true })
    await mkdir(join(dir, 'Assemblies'), { recursive: true })
    await writeFile(join(dir, 'Assemblies', 'QuietMod.dll'), 'x')
    await writeFile(join(dir, 'Source', 'Main.cs'), 'class X {}')
    const old = new Date(Date.now() - 60_000)
    await utimes(join(dir, 'Assemblies', 'QuietMod.dll'), old, old)

    const game = atlas({ dev: { mods: ['Quiet.Mod'] } })
    game.dlc = []
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
      { id: 'Patchlib.Patch', dir: await modDir('Harmony') },
      { id: 'Quiet.Mod', dir },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dev',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      args: { noStaleCheck: true },
    })

    expect(plan.mods.find((m) => m.packageId === 'Quiet.Mod')!.staleReport).toBeDefined()
    expect(planWarnings(plan).some((w) => w.includes('stale build'))).toBe(false)
  })

  test('only local mods are checked', async () => {
    const dir = await modDir('WorkshopStale')
    await mkdir(join(dir, 'Source'), { recursive: true })
    await mkdir(join(dir, 'Assemblies'), { recursive: true })
    await writeFile(join(dir, 'Assemblies', 'W.dll'), 'x')
    await writeFile(join(dir, 'Source', 'Main.cs'), 'class X {}')
    const old = new Date(Date.now() - 60_000)
    await utimes(join(dir, 'Assemblies', 'W.dll'), old, old)

    const game = atlas({ dev: { mods: ['Workshop.Stale'] } })
    game.dlc = []
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
      { id: 'Patchlib.Patch', dir: await modDir('Harmony') },
      { id: 'Workshop.Stale', dir, kind: 'workshop', workshopId: 42 },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dev',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })

    const mod = plan.mods.find((m) => m.packageId === 'Workshop.Stale')!
    expect(mod.stale).toBe(false)
    expect(mod.staleReport).toBeUndefined()
  })
})

describe('staging', () => {
  test('creates real directories, zero symlinks, and realpaths every source', async () => {
    const game = beacon({ qol: { mods: ['Example.Tweaks'] } })
    const real = await modDir('QoLs-real')
    const link = join(tmp, 'mods', 'QoLs-link')
    await rm(link, { force: true })
    await symlink(real, link)
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
      { id: 'Example.Tweaks', dir: link },
    ])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    await ensureProfileTree(plan)
    await writeFile(join(plan.stageDirHost, 'leftover.txt'), 'from the last launch')

    const mounts = await stageMods(plan)
    expect(mounts).toHaveLength(3)
    expect(mounts.every((m) => m.type === 'bind' && m.readonly === true)).toBe(true)

    const staged = await readdir(plan.stageDirHost, { withFileTypes: true })
    expect(staged.map((e) => e.name).sort()).toEqual(
      ['Example.Tweaks', 'Example.ModManager', 'Lib.Bridge.Beacon'].sort(),
    )
    for (const entry of staged) {
      expect(entry.isSymbolicLink()).toBe(false)
      expect(entry.isDirectory()).toBe(true)
      expect((await lstat(join(plan.stageDirHost, entry.name))).isSymbolicLink()).toBe(false)
    }

    const qol = mounts.find((m) => m.target.endsWith('Example.Tweaks'))!
    expect(qol.source).not.toBe(link)
    expect((await lstat(qol.source!)).isSymbolicLink()).toBe(false)
    expect(qol.target).toBe('/data/Beacon Studios/Beacon/SaveData/Mods/Example.Tweaks')
  })

  test('ensureProfileTree pre-creates the whole skeleton', async () => {
    const game = atlas({})
    game.dlc = []
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'modless',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      cwd: tmp,
    })
    await ensureProfileTree(plan)
    for (const dir of [
      plan.dataDirHost,
      join(plan.logsDirHost, 'runs'),
      plan.stageDirHost,
      join(plan.instanceDir, '.gamecrate'),
    ]) {
      expect((await lstat(dir)).isDirectory()).toBe(true)
    }
    expect(plan.profileDir.endsWith(join('data', 'atlas', 'modless'))).toBe(true)
  })

  test('detectForeignOwnership reports nothing for a tree the caller owns', async () => {
    const dir = await modDir('OwnedTree')
    await writeFile(join(dir, 'a.txt'), 'x')
    expect(await detectForeignOwnership(dir, process.getuid!())).toEqual([])
    expect(await detectForeignOwnership(dir, process.getuid!() + 1)).toContain(dir)
  })
})

describe('generated config files', () => {
  test('ModsConfig derives version and knownExpansions from the install', async () => {
    const game = atlas({ dsd: { mods: ['Example.Storyteller'] } })
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('rw-royalty'), kind: 'official' },
      { id: 'Atlasco.Atlas.Ideology', dir: await modDir('rw-ideology'), kind: 'official' },
      { id: 'Patchlib.Patch', dir: await modDir('harmony'), kind: 'workshop' },
      { id: 'Example.Storyteller', dir: await modDir('dsd') },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    await ensureProfileTree(plan)
    const written = await readFile(await generateModsConfig(plan), 'utf8')
    expect(written).toContain('version 1.6.4871 rev598')
    expect(written).toContain('example.storyteller')
    const expansions = written.split('knownExpansions ')[1]!
    expect(expansions).toContain('Atlasco.Atlas.Royalty')
    expect(expansions).not.toContain('Atlasco.Atlas ')
  })

  test('the version comes out of the image when the game is not mounted', async () => {
    const bin = await mkdtemp(join(tmp, 'fakedocker-'))
    await writeFile(join(bin, 'docker'), '#!/bin/sh\necho "1.9.9999 rev777"\n')
    await chmod(join(bin, 'docker'), 0o755)
    const game = {
      ...atlas({ dsd: { mods: [] } }),
      gameFiles: { source: 'image' as const, container: '/game' },
      image: { ref: 'ghcr.io/me/atlas:1' },
    }
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    await ensureProfileTree(plan)
    const path = process.env['PATH']
    process.env['PATH'] = bin
    try {
      const written = await readFile(await generateModsConfig(plan), 'utf8')
      expect(written).toContain('version 1.9.9999 rev777')
      expect(plan.warnings.some((w) => w.includes('Version.txt'))).toBe(false)
    } finally {
      process.env['PATH'] = path
    }
  })

  test('each plugin parses its own Version.txt; the formats are not shared', async () => {
    const game = beacon({ qol: { mods: [] } })
    index = makeIndex([
      { id: 'Lib.Bridge.Beacon', dir: await modDir('Lantern') },
      { id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' },
      { id: 'Example.ModManager', dir: await modDir('ModManager') },
    ])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    await ensureProfileTree(plan)
    const target = await generateModsConfig(plan)
    expect(target.endsWith(join('game', 'SaveData', 'Config', 'ModsConfig.txt'))).toBe(true)

    const written = await readFile(target, 'utf8')
    expect(written).toContain('buildNumber 1260')
    expect(written).toContain('version 0.0.2145 rev1260')
    expect(written).toContain('activeMods [lib.bridge.beacon atlasco.beacon example.modmanager]')

    expect(ATLAS_PLUGIN.parseVersion('0.0.2145.1260')?.buildNumber).toBe(-1)
    expect(BEACON_PLUGIN.parseVersion('1.6.4871 rev598')).toBeNull()
  })

  test('the version file name comes from the game, not from the core', async () => {
    const dir = join(tmp, 'BuildInfoGame')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'BuildInfo.txt'), '9.9.9 rev42\n')
    const game = fixtureGame()
    game.version = { file: 'BuildInfo.txt' }
    game.gameFiles = { source: 'mount', host: dir, container: '/game' }
    game.profiles = { solo: { mods: [] } }
    index = makeIndex([{ id: 'atlasco.atlas', dir: await modDir('bi-core'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'solo',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    await ensureProfileTree(plan)

    const written = await readFile(await generateModsConfig(plan), 'utf8')
    const result = {
      version: /version (.+)/.exec(written)![1],
      buildNumber: Number(/buildNumber (-?\d+)/.exec(written)![1]),
    }
    expect(result).toEqual({ version: '9.9.9 rev42', buildNumber: 42 })
  })

  test('a missing version file warns with the configured name', async () => {
    const dir = join(tmp, 'NoBuildInfoGame')
    await mkdir(dir, { recursive: true })
    const game = fixtureGame()
    game.version = { file: 'BuildInfo.txt' }
    game.gameFiles = { source: 'mount', host: dir, container: '/game' }
    game.profiles = { solo: { mods: [] } }
    index = makeIndex([{ id: 'atlasco.atlas', dir: await modDir('nbi-core'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'solo',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    await ensureProfileTree(plan)
    await generateModsConfig(plan)

    expect(plan.warnings.join('\n')).toContain('BuildInfo.txt')
  })

  test('a game with no dlc neither looks for Data/ nor warns about it', async () => {
    const game = beacon({ qol: { mods: [] } })
    index = makeIndex([{ id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    await ensureProfileTree(plan)
    expect(existsSync(join(tmp, 'Beacon', 'Data'))).toBe(false)

    const written = await readFile(await generateModsConfig(plan), 'utf8')
    expect(written).toContain('knownExpansions []')
    expect(plan.warnings.filter((w) => w.includes('Data'))).toEqual([])
  })

  test('prefs merge forces resetModsConfigOnCrash False and keeps tuned keys', async () => {
    const game = beacon({ qol: { mods: [] } })
    index = makeIndex([{ id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    plan.settings.resetModsConfigOnCrash = true
    await ensureProfileTree(plan)

    const prefsPath = join(plan.dataDirHost, 'SaveData', 'Prefs.txt')
    await mkdir(join(plan.dataDirHost, 'SaveData'), { recursive: true })
    await writeFile(prefsPath, 'volumeMaster 0.8\nlangFolderName English\nresetModsConfigOnCrash True\n')

    const merged = await readFile(await mergePrefs(plan), 'utf8')
    expect(merged).toContain('resetModsConfigOnCrash False')
    expect(merged).not.toContain('resetModsConfigOnCrash True')
    expect(merged).toContain('volumeMaster 0.8')
    expect(merged).toContain('langFolderName English')
    expect(merged).toContain('displayMode Windowed')
    expect(merged).toContain('screenWidth 1920')
  })

  test('the other plugin writes its own windowed key', async () => {
    const game = atlas({ dsd: { mods: [] } })
    game.dlc = []
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    await ensureProfileTree(plan)
    const merged = await readFile(await mergePrefs(plan), 'utf8')
    expect(merged).toContain('fullscreen False')
    expect(merged).toContain('screenHeight 1080')
  })

  test('prefsExtra passes through but cannot re-enable resetModsConfigOnCrash', async () => {
    const game = atlas({ dsd: { mods: [] } })
    game.dlc = []
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    plan.settings.prefsExtra = { uiScale: '1.25', resetModsConfigOnCrash: 'True' }
    await ensureProfileTree(plan)
    const merged = await readFile(await mergePrefs(plan), 'utf8')
    expect(merged).toContain('uiScale 1.25')
    expect(merged).toContain('resetModsConfigOnCrash False')
  })

  test('a Prefs that exists but cannot be read aborts instead of being overwritten', async () => {
    const plan = await prefsPlan()
    const prefsPath = join(plan.dataDirHost, 'SaveData', 'Prefs.txt')
    await rm(prefsPath, { force: true, recursive: true })
    await mkdir(prefsPath, { recursive: true })
    await expect(mergePrefs(plan)).rejects.toThrow(/EISDIR|illegal operation on a directory/i)
    expect((await lstat(prefsPath)).isDirectory()).toBe(true)
  })

  test.skipIf(process.getuid?.() === 0)('an unreadable Prefs leaves the tuned keys on disk', async () => {
    const plan = await prefsPlan()
    const prefsPath = join(plan.dataDirHost, 'SaveData', 'Prefs.txt')
    await rm(prefsPath, { force: true, recursive: true })
    await mkdir(join(plan.dataDirHost, 'SaveData'), { recursive: true })
    await writeFile(prefsPath, 'volumeMaster 0.8\n')
    await chmod(prefsPath, 0o222)
    await expect(mergePrefs(plan)).rejects.toThrow(/EACCES|permission denied/i)
    await chmod(prefsPath, 0o644)
    expect(await readFile(prefsPath, 'utf8')).toBe('volumeMaster 0.8\n')
  })

  test('a plugin that cannot parse the file fails as config, naming the path', async () => {
    const plan = await prefsPlan()
    const prefsPath = join(plan.dataDirHost, 'SaveData', 'Prefs.txt')
    const before = 'volumeMaster 0.8\nuiScale 1.25\n'
    await rm(prefsPath, { force: true, recursive: true })
    await mkdir(join(plan.dataDirHost, 'SaveData'), { recursive: true })
    await writeFile(prefsPath, before)
    plan.plugin = {
      ...plan.plugin,
      mergePrefs: () => {
        throw new Error('missing closing bracket (line 4, col 1)')
      },
    }
    const error = (await mergePrefs(plan).then(
      () => null,
      (e: unknown) => e,
    )) as GamecrateError
    expect(error).toBeInstanceOf(GamecrateError)
    expect(error.code).toBe(Exit.Config)
    expect(error.message).toContain('Prefs.txt')
    expect(error.message).toContain('missing closing bracket')
    expect((error.cause as Error).message).toBe('missing closing bracket (line 4, col 1)')
    expect(await readFile(prefsPath, 'utf8')).toBe(before)
  })

  test('a plugin that cannot render ModsConfig fails as config too', async () => {
    const plan = await prefsPlan()
    const configPath = join(plan.dataDirHost, 'Config', 'ModsConfig.txt')
    const before = 'active atlasco.beacon\n'
    await mkdir(join(plan.dataDirHost, 'Config'), { recursive: true })
    await writeFile(configPath, before)
    plan.plugin = {
      ...plan.plugin,
      renderModsConfig: () => {
        throw new Error("invalid config name 'my key'")
      },
    }
    const error = (await generateModsConfig(plan).then(
      () => null,
      (e: unknown) => e,
    )) as GamecrateError
    expect(error.code).toBe(Exit.Config)
    expect(error.message).toContain("invalid config name 'my key'")
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  async function prefsPlan(): Promise<LaunchPlan> {
    const game = beacon({ qol: { mods: [] } })
    index = makeIndex([{ id: 'Atlasco.Beacon', dir: await modDir('Beacon'), kind: 'core' }])
    const { plan } = await resolvePlan({
      game: 'beacon',
      profile: 'qol',
      plugins: PLUGINS,
      root: rootFor('beacon', game),
      index,
    })
    await ensureProfileTree(plan)
    return plan
  }
})

describe('git library pins', () => {
  async function subdirWith(clone: string, subdir: string, id: string): Promise<string> {
    const dir = join(clone, subdir)
    await mkdir(join(dir, 'About'), { recursive: true })
    await writeFile(join(dir, 'About', 'About.txt'), `packageId ${id}\nname ${id}\n`)
    return dir
  }

  async function planFor(
    library: GameConfig['library'],
    sources: Map<string, string>,
    mods: string[],
  ): Promise<{ plan: LaunchPlan; problems: Problem[] }> {
    const game = atlas({ dsd: { mods } })
    game.dlc = []
    game.base = []
    game.library = library
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('rw-core'), kind: 'core' }])
    return await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      sources,
    })
  }

  test('a git pin with a subdir resolves to that directory', async () => {
    const ref = { kind: 'tag' as const, value: 'v1.2.0' }
    const clone = cloneDir(join(tmp, 'data'), 'https://example.com/acme/pack.git', ref)
    const dir = await subdirWith(clone, 'Source/Mod', 'Acme.Pack')
    const { plan, problems } = await planFor(
      { 'acme.pack': { git: 'https://example.com/acme/pack', tag: 'v1.2.0', subdir: 'Source/Mod' } },
      new Map([['acme.pack', clone]]),
      ['Acme.Pack'],
    )
    expect(problems).toEqual([])
    expect(plan.mods.map((mod) => mod.hostDir)).toContain(dir)
  })

  test('subdir picks between two subdirs declaring one packageId', async () => {
    const ref = { kind: 'branch' as const, value: 'main' }
    const clone = cloneDir(join(tmp, 'data'), 'https://example.com/acme/twins', ref)
    await subdirWith(clone, 'Old', 'Acme.Twin')
    const wanted = await subdirWith(clone, 'New', 'Acme.Twin')
    const { plan, problems } = await planFor(
      { 'acme.twin': { git: 'https://example.com/acme/twins', branch: 'main', subdir: 'New' } },
      new Map([['acme.twin', clone]]),
      ['Acme.Twin'],
    )
    expect(problems).toEqual([])
    expect(plan.mods.map((mod) => mod.hostDir)).toContain(wanted)
  })

  test('a git pin missing from the sources map is a clean miss', async () => {
    const { problems } = await planFor(
      { 'acme.absent': { git: 'https://example.com/acme/absent', branch: 'main' } },
      new Map(),
      ['Acme.Absent'],
    )
    expect(problems.map((problem) => problem.message)).toEqual(['no mod matches "Acme.Absent"'])
  })
})

describe('a null workshopRoot is not a cause of failure', () => {
  async function bareAtlas(profiles: Record<string, ProfileConfig>): Promise<GameConfig> {
    const game = atlas(profiles)
    game.dlc = []
    game.base = []
    return game
  }

  test('an optional workshop mod stays a warning, never a problem', async () => {
    const game = await bareAtlas({
      dsd: { mods: [{ id: 'Acme.Optional', workshop: 2009463077, optional: true }] },
    })
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('wsr-core'), kind: 'core' }])
    const { plan, problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.warnings.filter((w) => w.includes('workshop:2009463077'))).toHaveLength(1)
  })

  test('a declared dlc pinned to workshop stays silent', async () => {
    const game = await bareAtlas({ dsd: { mods: [] } })
    game.dlc = ['Atlasco.Atlas.Royalty']
    game.library = { 'atlasco.atlas.royalty': { workshop: 2009463077 } }
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('wsr-core'), kind: 'core' }])
    const { plan, problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems).toEqual([])
    expect(plan.warnings.filter((w) => w.includes('2009463077'))).toEqual([])
  })

  test('a null workshopRoot is not blamed when a real launch could not resolve the item', async () => {
    const game = await bareAtlas({ dsd: { mods: ['workshop:2009463077'] } })
    game.workshopRoot = null
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('wsr-core'), kind: 'core' }])
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems.map((p) => p.message)).toEqual(['no mod matches "workshop:2009463077"'])
  })

  test('a real workshopRoot keeps the plain no-mod-matches message', async () => {
    const game = await bareAtlas({ dsd: { mods: ['workshop:2009463077'] } })
    game.workshopRoot = join(tmp, 'workshop')
    index = makeIndex([{ id: 'Atlasco.Atlas', dir: await modDir('wsr-core'), kind: 'core' }])
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(problems.map((p) => p.message)).toEqual(['no mod matches "workshop:2009463077"'])
  })
})


describe('steam', () => {
  test('steam off loads the game steamless mod, after the dlc', async () => {
    const game = { ...atlas({ dsd: { mods: [] } }), steamlessMod: 'Example.NoSteam' }
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('s-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('s-royalty'), kind: 'official' },
      { id: 'Atlasco.Atlas.Ideology', dir: await modDir('s-ideology'), kind: 'official' },
      { id: 'Example.NoSteam', dir: await modDir('s-nosteam') },
      { id: 'Patchlib.Patch', dir: await modDir('s-harmony') },
    ])
    const { plan, problems } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      args: { sort: 'none' },
    })
    expect(problems).toEqual([])
    expect(plan.steam).toBe(false)
    expect(plan.mods.map((m) => m.packageId)).toEqual([
      'Atlasco.Atlas',
      'Atlasco.Atlas.Royalty',
      'Atlasco.Atlas.Ideology',
      'Example.NoSteam',
      'Patchlib.Patch',
    ])
  })

  test('steam on leaves the steamless mod out and forces network host', async () => {
    const game = { ...atlas({ dsd: { mods: [] } }), steamlessMod: 'Example.NoSteam' }
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('s2-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('s2-royalty'), kind: 'official' },
      { id: 'Atlasco.Atlas.Ideology', dir: await modDir('s2-ideology'), kind: 'official' },
      { id: 'Example.NoSteam', dir: await modDir('s2-nosteam') },
      { id: 'Patchlib.Patch', dir: await modDir('s2-harmony') },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      args: { steam: true, network: 'bridge' },
    })
    expect(plan.steam).toBe(true)
    expect(plan.mods.map((m) => m.packageId)).not.toContain('Example.NoSteam')
    expect(plan.settings.network).toBe('host')
    expect(plan.warnings.some((w) => w.includes('steam needs network host'))).toBe(true)
  })

  test('a profile asking for steam is overridden by --no-steam', async () => {
    const game = { ...atlas({ dsd: { mods: [], steam: true } }), steamlessMod: 'Example.NoSteam' }
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('s3-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('s3-royalty'), kind: 'official' },
      { id: 'Atlasco.Atlas.Ideology', dir: await modDir('s3-ideology'), kind: 'official' },
      { id: 'Example.NoSteam', dir: await modDir('s3-nosteam') },
      { id: 'Patchlib.Patch', dir: await modDir('s3-harmony') },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
      args: { steam: true, noSteam: true },
    })
    expect(plan.steam).toBe(false)
    expect(plan.mods.map((m) => m.packageId)).toContain('Example.NoSteam')
  })

  test('a profile asking for steam needs no flag', async () => {
    const game = { ...atlas({ dsd: { mods: [], steam: true } }), steamlessMod: 'Example.NoSteam' }
    index = makeIndex([
      { id: 'Atlasco.Atlas', dir: await modDir('s4-core'), kind: 'core' },
      { id: 'Atlasco.Atlas.Royalty', dir: await modDir('s4-royalty'), kind: 'official' },
      { id: 'Atlasco.Atlas.Ideology', dir: await modDir('s4-ideology'), kind: 'official' },
      { id: 'Example.NoSteam', dir: await modDir('s4-nosteam') },
      { id: 'Patchlib.Patch', dir: await modDir('s4-harmony') },
    ])
    const { plan } = await resolvePlan({
      game: 'atlas',
      profile: 'dsd',
      plugins: PLUGINS,
      root: rootFor('atlas', game),
      index,
    })
    expect(plan.steam).toBe(true)
    expect(plan.mods.map((m) => m.packageId)).not.toContain('Example.NoSteam')
  })
})
