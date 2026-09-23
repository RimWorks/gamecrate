import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_DATA_ROOT, DEFAULT_SETTINGS } from '../src/config/builtin'
import { PLUGIN_API_VERSION } from '../src/plugin'
import { FIXTURE_DEFAULTS, fixtureGame, writePluginPackage } from './fixture-plugin'
import {
  canonicalProfile,
  findGlobalConfig,
  findProjectConfig,
  loadConfig,
  loadProjectDefaults,
  mergeUserConfig,
  profileDataDir,
  profileDirs,
  resolveProfile,
  resolveSettings,
  subtract,
} from '../src/config/load'
import { parseArgs } from '../src/cli/args'
import { list } from '../src/cli/list'
import { profileOf } from '../src/cli/profile'
import { parseJsonc } from '../src/config/jsonc'
import { orderedKeys, readConfigFile, readConfigText } from '../src/config/read'
import { validateConfig } from '../src/config/validate'
import { GamecrateError, Exit } from '../src/types'
import type { GameConfig, ParsedArgs, Problem, ProjectDefaults, RootConfig } from '../src/types'

const ATLAS_DEFAULTS: GameConfig = {
  ...(FIXTURE_DEFAULTS as GameConfig),
  image: { ref: 'atlas-build:latest', acquire: 'build', context: '~/fixtures/docker' },
  scanRoots: [{ path: '~/fixtures/trees/atlas', maxDepth: 3 }],
  dlc: ['atlasco.atlas.one', 'atlasco.atlas.two'],
  library: { 'patchlib.patch': { workshop: 2009463077 } },
  settings: { network: 'host' },
}

function base(): RootConfig {
  return {
    dataRoot: DEFAULT_DATA_ROOT,
    defaults: { settings: structuredClone(DEFAULT_SETTINGS) },
    games: { atlas: structuredClone(ATLAS_DEFAULTS) },
  }
}

/** The merge loadConfig runs: the fixture plugin's defaults underneath, the user's blocks over. */
function merged(user: unknown): { config: RootConfig; problems: Problem[] } {
  return validateConfig(mergeUserConfig(base(), user))
}

/** A plugin file written outside the repo, so the loader is exercised the way a user hits it. */
async function writePlugin(dir: string, game = 'atlas'): Promise<string> {
  const file = join(dir, `${game}-plugin.ts`)
  await writeFile(
    file,
    `export default {
      apiVersion: ${PLUGIN_API_VERSION},
      game: ${JSON.stringify(game)},
      defaults: ${JSON.stringify(ATLAS_DEFAULTS)},
      parseManifest: (text) => (text.includes('packageId') ? { packageId: 'x', modDependencies: [], loadAfter: [], loadBefore: [], forceLoadAfter: [], forceLoadBefore: [], incompatibleWith: [] } : null),
      renderModsConfig: () => '',
      mergePrefs: () => '',
      windowedPrefs: {},
      parseVersion: () => null,
    }\n`,
  )
  return file
}

function find(problems: Problem[], needle: string): Problem | undefined {
  return problems.find((p) => p.message.includes(needle) || p.where.includes(needle))
}

describe('parseJsonc', () => {
  test('keeps // inside a string', () => {
    const v = parseJsonc('{ "ref": "https://registry.example/x:latest" }') as Record<string, string>
    expect(v['ref']).toBe('https://registry.example/x:latest')
  })

  test('strips line comments', () => {
    const v = parseJsonc(`{
      "a": 1, // trailing note
      // whole line
      "b": 2
    }`)
    expect(v).toEqual({ a: 1, b: 2 })
  })

  test('strips block comments, including multi-line', () => {
    const v = parseJsonc('{ "a": /* inline */ 1, "b": /* one\ntwo */ 2 }')
    expect(v).toEqual({ a: 1, b: 2 })
  })

  test('strips trailing commas in objects and arrays', () => {
    expect(parseJsonc('{ "a": [1, 2, ], }')).toEqual({ a: [1, 2] })
  })

  test('a comma before a comment then a brace is still trailing', () => {
    expect(parseJsonc('{ "a": 1, // note\n }')).toEqual({ a: 1 })
  })

  test('an escaped quote does not end the string', () => {
    const v = parseJsonc(String.raw`{ "a": "say \" // not a comment" }`) as Record<string, string>
    expect(v['a']).toBe('say " // not a comment')
  })

  test('a comment marker inside a key is preserved', () => {
    const v = parseJsonc('{ "a/*b*/c": 1 }') as Record<string, number>
    expect(v['a/*b*/c']).toBe(1)
  })

  // jsonc-parser recovers from syntax errors and still returns a value, so only its
  // error list can say the parse failed.
  test('a recovered parse is still a failure', () => {
    expect(() => parseJsonc('{ "a": 1 "b": 2 }')).toThrow(GamecrateError)
    expect(() => parseJsonc('')).toThrow(GamecrateError)
  })

  test('invalid JSON raises a config error', () => {
    let caught: unknown
    try {
      parseJsonc('{ "a": }')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(GamecrateError)
    expect((caught as GamecrateError).code).toBe(Exit.Config)
  })
})

describe('plugin defaults', () => {
  test('a plugin ships the game structure and validates clean', () => {
    expect(validateConfig(base()).problems).toEqual([])
    const g = base().games['atlas']!
    expect(g.dataDir).toEqual({ container: '/data', mode: 'arg', arg: '-savedatafolder=/data' })
    expect(g.core).toBe('atlasco.atlas')
    expect(g.saveExtensions).toEqual(['sav'])
  })

  test('a plugin never ships profiles or base mods; those are the user\'s', () => {
    const g = base().games['atlas']!
    expect(g.profiles).toEqual({})
    expect(g.base).toBeUndefined()
  })
})

describe('merge chain', () => {
  const root: RootConfig = {
    dataRoot: '/tmp/dg',
    defaults: { settings: { width: 1920, memory: '8g', gameArgs: ['-a'], prefsExtra: { x: '1' } } },
    games: {},
  }
  const game = { settings: { memory: '12g', gameArgs: ['-b'], prefsExtra: { y: '2' } } } as unknown as GameConfig

  test('later levels replace scalars', () => {
    const s = resolveSettings(root, game, { settings: { memory: '16g' } }, { cpus: 2 })
    expect(s.memory).toBe('16g')
    expect(s.cpus).toBe(2)
    expect(s.width).toBe(1920)
  })

  test('arrays concatenate across levels', () => {
    const s = resolveSettings(root, game, { settings: { gameArgs: ['-c'] } }, { gameArgs: ['-d'] })
    expect(s.gameArgs).toEqual(['-a', '-b', '-c', '-d'])
  })

  // An instance's args land after the profile's and before whatever the CLI adds.
  test('the instance layer sits between the profile and the CLI', () => {
    const s = resolveSettings(
      root,
      game,
      { settings: { gameArgs: ['-c'], memory: '16g' } },
      { gameArgs: ['-i'], memory: '32g' },
      { gameArgs: ['-d'] },
    )
    expect(s.gameArgs).toEqual(['-a', '-b', '-c', '-i', '-d'])
    expect(s.memory).toBe('32g')
  })

  test('maps deep-merge across levels', () => {
    const s = resolveSettings(root, game, { settings: { prefsExtra: { z: '3' } } })
    expect(s.prefsExtra).toEqual({ x: '1', y: '2', z: '3' })
  })

  test('unset keys fall back to the built-in defaults', () => {
    const s = resolveSettings({ dataRoot: '/tmp/dg', games: {} }, {} as unknown as GameConfig, {})
    expect(s).toEqual(DEFAULT_SETTINGS)
  })

  test('resolving does not mutate the defaults', () => {
    resolveSettings(root, game, { settings: { gameArgs: ['-c'] } })
    expect(DEFAULT_SETTINGS.gameArgs).toBeUndefined()
    expect(root.defaults?.settings?.gameArgs).toEqual(['-a'])
  })
})

describe('resolveProfile', () => {
  const game: GameConfig = {
    ...structuredClone(ATLAS_DEFAULTS),
    profiles: {
      kitted: { mods: ['Kitted.Core', 'Kitted.Roshar'], settings: { devMode: false } },
      lightweave: { mods: ['Kitted.LightweaveRimBridge'], extends: 'kitted' },
      trimmed: { extends: 'lightweave', exclude: ['Kitted.Roshar', 'patchlib.*'] },
      vanilla: { alias: 'modless' },
      loop: { extends: 'knot' },
      knot: { extends: 'loop' },
    },
  }

  test('extends prepends the parent mods in order', () => {
    expect(resolveProfile(game, 'lightweave').mods).toEqual([
      'Kitted.Core',
      'Kitted.Roshar',
      'Kitted.LightweaveRimBridge',
    ])
  })

  test('exclude subtracts inherited entries and keeps globs for base', () => {
    const p = resolveProfile(game, 'trimmed')
    expect(p.mods).toEqual(['Kitted.Core', 'Kitted.LightweaveRimBridge'])
    expect(p.exclude).toEqual(['Kitted.Roshar', 'patchlib.*'])
  })

  test('settings merge down the extends chain', () => {
    expect(resolveProfile(game, 'lightweave').settings).toEqual({ devMode: false })
  })

  test('alias resolves to modless, which drops base mods', () => {
    const p = resolveProfile(game, 'vanilla')
    expect(p.mods).toEqual([])
    expect(p.includeBase).toBe(false)
  })

  test('an extends cycle is a config error', () => {
    let caught: unknown
    try {
      resolveProfile(game, 'loop')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(GamecrateError)
    expect((caught as GamecrateError).code).toBe(Exit.Config)
  })

  test('an unknown profile is a resolution error', () => {
    expect(() => resolveProfile(game, 'nope')).toThrow(/unknown profile/)
  })

  test('subtract matches prefixed forms and object entries', () => {
    const out = subtract(['workshop:patchlib.patch', { id: 'Keep.Me' }, 'Drop.Me'], ['patchlib.*', 'drop.me'])
    expect(out).toEqual([{ id: 'Keep.Me' }])
  })
})

describe('validateConfig', () => {
  test('an unknown key suggests the near miss', () => {
    const { problems } = merged({ defaults: { settings: { devMod: true } } })
    const p = find(problems, 'devMod')
    expect(p?.message).toBe('unknown key "devMod"')
    expect(p?.suggestion).toBe('did you mean "devMode"?')
    expect(p?.where).toBe('/defaults/settings/devMod')
  })

  test('an unknown game key is reported with a pointer', () => {
    const { problems } = merged({ games: { atlas: { modsDirs: { container: '/x' } } } })
    expect(find(problems, 'modsDirs')?.suggestion).toBe('did you mean "modsDir"?')
  })

  test('a reserved profile name is rejected', () => {
    const { problems } = merged({ games: { atlas: { profiles: { logs: { mods: [] } } } } })
    expect(find(problems, 'reserved')?.where).toBe('/games/atlas/profiles/logs')
  })

  test('a reserved game name is rejected', () => {
    const { problems } = merged({ games: { doctor: { profiles: {} } } })
    expect(find(problems, 'reserved')?.message).toContain('doctor')
  })

  test('a game named add is rejected as reserved', () => {
    const { problems } = merged({ games: { add: { profiles: {} } } })
    expect(find(problems, 'reserved')?.message).toContain('add')
  })

  test.each(['add', 'rm', 'sync'])('a profile named %s is rejected as reserved', (name) => {
    const { problems } = merged({ games: { atlas: { profiles: { [name]: { mods: [] } } } } })
    expect(find(problems, 'reserved')?.where).toBe(`/games/atlas/profiles/${name}`)
  })

  test('a game and profile that were always legal raise no reserved problem', () => {
    const { problems } = merged({ games: { rimworld: { profiles: { cosmere: { mods: [] } } } } })
    expect(find(problems, 'reserved')).toBeUndefined()
  })

  test('a name outside NAME_PATTERN is rejected', () => {
    const { problems } = merged({ games: { atlas: { profiles: { '-bad name': {} } } } })
    expect(find(problems, 'must match')).toBeDefined()
  })

  test('an instances block validates, and a bad instance name is caught', () => {
    const ok = merged({
      games: {
        atlas: {
          profiles: {
            dev: { instances: { 'wt-a': { worktree: '~/p/.worktrees/a', settings: { gameArgs: ['-q'] } } } },
          },
        },
      },
    })
    expect(ok.problems).toEqual([])

    const bad = merged({
      games: {
        atlas: {
          profiles: {
            dev: { instances: { '-nope': { worktee: 'x' }, ok: { settings: { memry: '4g' } } } },
          },
        },
      },
    })
    expect(find(bad.problems, 'must match')?.where).toBe('/games/atlas/profiles/dev/instances/-nope')
    expect(find(bad.problems, 'worktee')?.suggestion).toBe('did you mean "worktree"?')
    expect(find(bad.problems, 'memry')?.where).toBe('/games/atlas/profiles/dev/instances/ok/settings/memry')
  })

  test('extends and alias targets must exist', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: { kitted: { mods: [] }, a: { extends: 'kited' }, b: { alias: 'nothere' } },
        },
      },
    })
    expect(find(problems, 'extends unknown profile')?.suggestion).toBe('did you mean "kitted"?')
    expect(find(problems, 'alias of unknown profile')).toBeDefined()
  })

  test('missing required keys are all reported at once', () => {
    const { problems } = merged({ games: { newgame: { executable: './x' } } })
    const missing = problems.filter((p) => p.message.startsWith('missing required key'))
    expect(missing.length).toBeGreaterThan(5)
    expect(missing.some((p) => p.where === '/games/newgame/steamAppId')).toBe(true)
  })

  test('conditional requirements follow the discriminant', () => {
    const { problems } = merged({
      games: { atlas: { image: { ref: 'x', acquire: 'build', context: undefined } } },
    })
    expect(problems).toEqual([])
    const bad = merged({ games: { atlas: { dataDir: { mode: 'env', container: '/d' } } } })
    expect(find(bad.problems, '/games/atlas/dataDir/env')).toBeDefined()
  })

  test('the steamcmd block is optional, and so is its path', () => {
    expect(merged({}).problems).toEqual([])
    expect(merged({ steamcmd: { path: '/usr/games/steamcmd' } }).problems).toEqual([])
    expect(merged({ steamcmd: {} }).problems).toEqual([])
  })

  test('a non-string steamcmd path is reported with a pointer', () => {
    const { problems } = merged({ steamcmd: { path: 7 } })
    expect(find(problems, 'expected a string')?.where).toBe('/steamcmd/path')
  })

  test('a non-string steamcmd path fails the load with a config exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts"], "steamcmd": { "path": 7 } }')

    const error = (await loadConfig(file).catch((e: unknown) => e)) as GamecrateError
    expect(error).toBeInstanceOf(GamecrateError)
    expect(error.code).toBe(Exit.Config)
    expect(error.detail).toContain('/steamcmd/path')
  })

  test('wrong types are reported, not coerced', () => {
    const { problems } = merged({ games: { atlas: { steamAppId: '294100' } } })
    expect(find(problems, 'expected a number')?.where).toBe('/games/atlas/steamAppId')
  })

  test('an unknown key is reported next to a bad sibling value', () => {
    const { problems } = merged({ games: { atlas: { settings: { memory: 4, memry: '4g' } } } })
    expect(find(problems, 'expected a string')?.where).toBe('/games/atlas/settings/memory')
    expect(find(problems, 'memry')?.suggestion).toBe('did you mean "memory"?')
  })

  test('an unknown key with no near match gets no suggestion', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { kitted: { mods: [{ id: 'A', qqqqqqqq: 1 }] } } } },
    })
    const p = find(problems, 'qqqqqqqq')
    expect(p?.where).toBe('/games/atlas/profiles/kitted/mods/0/qqqqqqqq')
    expect(p?.message).toBe('unknown key "qqqqqqqq"')
    expect(p?.suggestion).toBeUndefined()
  })

  test('a typo inside a mod entry still suggests', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { kitted: { mods: [{ id: 'A', workshopp: 1 }] } } } },
    })
    expect(find(problems, 'workshopp')?.suggestion).toBe('did you mean "workshop"?')
  })

  test('hints stay lined up across several unknown keys, newlines included', () => {
    const { problems } = merged({
      games: { atlas: { settings: { qqqqqqqq: 1, 'mem\nory': '4g', devMod: true } } },
    })
    expect(find(problems, 'qqqqqqqq')?.suggestion).toBeUndefined()
    expect(find(problems, 'mem\nory')?.where).toBe('/games/atlas/settings/mem\nory')
    expect(find(problems, 'devMod')?.suggestion).toBe('did you mean "devMode"?')
  })

  test('a mod entry reports its shape and its unknown keys together', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { kitted: { mods: [{ id: 4, qqqqqqqq: 1, pathh: 'x' }] } } } },
    })
    expect(find(problems, 'expected a string')?.where).toBe('/games/atlas/profiles/kitted/mods/0/id')
    expect(find(problems, 'qqqqqqqq')?.suggestion).toBeUndefined()
    expect(find(problems, 'pathh')?.suggestion).toBe('did you mean "path"?')
  })

  test('shape problems and cross-reference problems arrive together', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { kitted: { mods: [] }, a: { extends: 'kited', includeBase: 'yes' } } } },
    })
    expect(find(problems, 'expected a boolean')?.where).toBe('/games/atlas/profiles/a/includeBase')
    expect(find(problems, 'extends unknown profile')?.suggestion).toBe('did you mean "kitted"?')
  })

  test('a non-object config is one problem, not a crash', () => {
    expect(validateConfig('nope').problems).toHaveLength(1)
  })

  test('a macos depot with a runnable base is refused', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: {
        branches: [{ name: 'public' }],
        variants: [{ name: 'mac', depot: 'macos', base: 'xvfb', include: [] }],
      } } },
    })
    const p = find(problems, 'macos')
    expect(p?.message).toBe('a macos depot cannot be runnable')
    expect(p?.suggestion).toBe('set base to "none"; no macos container runtime exists')
    expect(p?.where).toBe('/games/atlas/steamBuild/variants/0/base')
  })

  test('a macos depot with base none is accepted', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: {
        branches: [{ name: 'public' }],
        variants: [{ name: 'mac-ref', depot: 'macos', base: 'none', include: ['Managed'] }],
      } } },
    })
    expect(find(problems, 'macos')).toBeUndefined()
  })

  test('the second variant with a repeated name is the one reported', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: {
        branches: [{ name: 'public' }],
        variants: [
          { name: 'linux', base: 'xvfb', include: [] },
          { name: 'linux', base: 'none', include: [] },
        ],
      } } },
    })
    const p = find(problems, 'duplicate')
    expect(p?.message).toBe('duplicate variant name "linux"')
    expect(p?.where).toBe('/games/atlas/steamBuild/variants/1/name')
  })

  test('an empty variants list is refused', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: 'public' }], variants: [] } } },
    })
    expect(find(problems, 'variants')?.message).toBe('steamBuild.variants cannot be empty')
  })

  test('an unknown base value is refused with the list of real ones', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: {
        branches: [{ name: 'public' }],
        variants: [{ name: 'linux', base: 'wayland', include: [] }],
      } } },
    })
    expect(find(problems, 'expected one of')?.where).toBe('/games/atlas/steamBuild/variants/0/base')
  })

  test('a branch name with a dot survives validation', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: {
        branches: [{ name: 'public' }, { name: '1.5-test', password: true }],
        variants: [{ name: 'linux', base: 'xvfb', include: [] }],
      } } },
    })
    expect(problems).toHaveLength(0)
  })

  // the merge keeps the plugin's branches, so only a config whose own list is empty can fire this
  test('an empty branches list is refused', () => {
    const cfg = base()
    cfg.games.atlas!.steamBuild = {
      branches: [],
      variants: [{ name: 'linux', base: 'xvfb', include: [] }],
    }
    const p = find(validateConfig(cfg).problems, 'branches')
    expect(p?.message).toBe('steamBuild.branches cannot be empty')
    expect(p?.where).toBe('/games/atlas/steamBuild/branches')
  })

  test('a user branches: [] still leaves the plugin list in place', () => {
    const { config, problems } = merged({ games: { atlas: { steamBuild: { branches: [] } } } })
    expect(config.games.atlas?.steamBuild.branches.map((b) => b.name)).toEqual(['public'])
    expect(find(problems, 'branches')).toBeUndefined()
  })

  test('a variant name with a slash is refused before any download', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: {
        branches: [{ name: 'public' }],
        variants: [{ name: 'a b/c', base: 'xvfb', include: [] }],
      } } },
    })
    expect(find(problems, 'a b/c')?.where).toBe('/games/atlas/steamBuild/variants/0/name')
  })

  test('an empty variant name is refused', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: {
        branches: [{ name: 'public' }],
        variants: [{ name: '', base: 'xvfb', include: [] }],
      } } },
    })
    expect(find(problems, 'variants/0/name')).toBeDefined()
  })

  test('a user branch is added to the plugin list, not swapped for it', () => {
    const { config } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: 'unstable', password: true }] } } },
    })
    expect(config.games.atlas?.steamBuild.branches.map((b) => b.name)).toEqual(['public', 'unstable'])
  })

  test('restating the plugin branch does not duplicate it, and the user fields win', () => {
    const { config } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: 'public', password: true }, { name: '1.5' }] } } },
    })
    const branches = config.games.atlas!.steamBuild.branches
    expect(branches.map((b) => b.name)).toEqual(['public', '1.5'])
    expect(branches[0]?.password).toBe(true)
  })

  test('a user override cannot move which branch gets the bare latest tag', () => {
    const { config } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: 'unstable' }, { name: 'public' }] } } },
    })
    expect(config.games.atlas?.steamBuild.branches[0]?.name).toBe('public')
  })

  // the merge only dedupes what a user adds, so a plugin's own list reaches validation as-is
  test('a plugin declaring one branch twice is refused with no user config', () => {
    const cfg = base()
    cfg.games.atlas!.steamBuild.branches = [{ name: 'public' }, { name: 'public' }]
    const p = find(validateConfig(cfg).problems, 'duplicate branch')
    expect(p?.message).toBe('duplicate branch name "public"')
    expect(p?.where).toBe('/games/atlas/steamBuild/branches/1/name')
  })

  test('a branch name with a space is refused', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: 'my branch' }] } } },
    })
    expect(find(problems, 'my branch')?.where).toBe('/games/atlas/steamBuild/branches/1/name')
  })

  test('a branch name with a slash is refused', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: 'feature/x' }] } } },
    })
    expect(find(problems, 'feature/x')).toBeDefined()
  })

  test('a dot, a dash and an underscore stay legal in a branch name', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: '1.5-test' }, { name: 'beta_2' }] } } },
    })
    expect(problems).toHaveLength(0)
  })

  test('a branch name cannot start with a dot', () => {
    const { problems } = merged({
      games: { atlas: { steamBuild: { branches: [{ name: '.hidden' }] } } },
    })
    expect(find(problems, '.hidden')).toBeDefined()
  })

  test('variants still replace', () => {
    const { config } = merged({
      games: { atlas: { steamBuild: { variants: [{ name: 'only', base: 'none', include: [] }] } } },
    })
    expect(config.games.atlas?.steamBuild.variants.map((v) => v.name)).toEqual(['only'])
  })
})

describe('library entry sources', () => {
  function lib(entry: unknown): Problem[] {
    return merged({ games: { atlas: { library: { 'gitlib.git': entry } } } }).problems
  }

  test('a git entry takes a branch and a subdir', () => {
    expect(lib({ git: 'https://example.test/x.git', branch: 'dev', subdir: 'Source/Mod' })).toEqual([])
  })

  test('a git entry needs no ref at all', () => {
    expect(lib({ git: 'https://example.test/x.git' })).toEqual([])
  })

  test('workshop and path cannot both be given', () => {
    expect(find(lib({ workshop: 123, path: '~/mods/x' }), 'only one of')).toBeDefined()
  })

  test('a commit counts as a ref, and still needs a git url', () => {
    const problems = lib({ commit: 'abc1234', branch: 'dev' })
    expect(find(problems, 'only one of branch')?.message).toContain('branch, commit')
    expect(find(problems, '/gitlib.git/commit')?.message).toBe('"commit" needs a "git" url')
  })

  test('git and path cannot both be given', () => {
    expect(find(lib({ git: 'https://example.test/x.git', path: '~/mods/x' }), 'only one of')).toBeDefined()
  })

  test('git and workshop cannot both be given', () => {
    expect(find(lib({ git: 'https://example.test/x.git', workshop: 123 }), 'only one of')).toBeDefined()
  })

  test('branch and tag cannot both be given', () => {
    expect(
      find(lib({ git: 'https://example.test/x.git', branch: 'dev', tag: 'v1' }), 'only one of branch'),
    ).toBeDefined()
  })

  test('a ref without a git url is refused', () => {
    const problem = find(lib({ path: '~/mods/x', branch: 'dev' }), 'needs a "git"')
    expect(problem?.where).toBe('/games/atlas/library/gitlib.git/branch')
  })

  test('a subdir without a git url is refused', () => {
    const problem = find(lib({ path: '~/mods/x', subdir: 'Source' }), 'needs a "git"')
    expect(problem?.where).toBe('/games/atlas/library/gitlib.git/subdir')
  })

  test('an absolute subdir is refused', () => {
    const problem = find(lib({ git: 'https://example.test/x.git', subdir: '/abs' }), 'relative')
    expect(problem?.where).toBe('/games/atlas/library/gitlib.git/subdir')
  })

  test('a subdir that climbs out is refused', () => {
    const problem = find(lib({ git: 'https://example.test/x.git', subdir: 'a/../../b' }), 'relative')
    expect(problem?.where).toBe('/games/atlas/library/gitlib.git/subdir')
  })

  test('an entry with no source at all is refused', () => {
    expect(find(lib({}), 'needs a "workshop" id, a "path", or a "git" url')).toBeDefined()
  })
})

describe('validateConfig name space', () => {
  test('extends and alias accept any spelling the launcher accepts', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: {
            Kitted: { mods: ['A'], aliases: ['kt'] },
            byCase: { extends: 'kitted' },
            byAlias: { extends: 'KT' },
            asAlias: { alias: 'kitted' },
            bare: { extends: 'MODLESS' },
          },
        },
      },
    })
    expect(problems).toEqual([])
  })

  test('a target nothing resolves is still reported at its own pointer', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { kitted: { mods: [] }, a: { extends: 'kited' } } } },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/a/extends')
    expect(problems[0]?.message).toBe('extends unknown profile "kited"')
  })

  test('two profile keys differing only in case are refused, at the second one', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { Dev: { mods: ['A'] }, dev: { mods: ['B'] } } } },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/dev')
    expect(problems[0]?.message).toContain('only in case')
  })

  test('one alias cannot be declared by two profiles, whatever the casing', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: { one: { mods: ['A'], aliases: ['shared'] }, two: { mods: ['B'], aliases: ['SHARED'] } },
        },
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/two/aliases/0')
    expect(problems[0]?.message).toBe('alias "SHARED" is already declared by profile "one"')
  })

  test('a reserved word cannot be an alias in any casing', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { a: { mods: [], aliases: ['MODLESS'] } } } },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/a/aliases/0')
    expect(problems[0]?.message).toContain('reserved name')
  })

  test('a self alias is caught even when the casing differs', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { Dev: { alias: 'dev' } } } },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/Dev/alias')
    expect(problems[0]?.message).toBe('a profile cannot alias itself')
  })

  test('a profile named like another profile instance container is refused', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: { dev: { mods: ['A'], instances: { wt: {} } }, 'dev-wt': { mods: ['B'] } },
        },
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/dev-wt')
    expect(problems[0]?.message).toBe(
      'container name collides with /games/atlas/profiles/dev/instances/wt',
    )
  })

  test('the container collision is caught from the other side too', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: { 'dev-wt': { mods: ['B'] }, dev: { mods: ['A'], instances: { wt: {} } } },
        },
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/dev/instances/wt')
    expect(problems[0]?.message).toBe(
      'instance "wt" makes a container name that collides with /games/atlas/profiles/dev-wt',
    )
  })

  test('an instance inherited through extends is in the container name space too', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: {
            base: { mods: ['A'], instances: { wt: {} } },
            child: { extends: 'base' },
            'child-wt': { mods: ['B'] },
          },
        },
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/child-wt')
    expect(problems[0]?.message).toBe('container name collides with /games/atlas/profiles/child')
  })

  test('an inherited instance is blamed on the profile, which has no key to point at', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: {
            'child-wt': { mods: ['B'] },
            base: { mods: ['A'], instances: { wt: {} } },
            child: { extends: 'base' },
          },
        },
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas/profiles/child')
    expect(problems[0]?.message).toBe(
      'instance "wt" makes a container name that collides with /games/atlas/profiles/child-wt',
    )
  })

  test('an extends cycle does not take the collision pass down with it', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { a: { extends: 'b' }, b: { extends: 'a', instances: { wt: {} } } } } },
    })
    expect(problems).toEqual([])
  })

  // the game is part of the container name, so the collision crosses games: this is the
  // destructive direction, two runs sharing one docker name, not a refusal that annoys anyone
  test('two games that build one container name are refused', () => {
    const { problems } = merged({
      games: {
        atlas: { profiles: { 'x-dev': { mods: ['A'] } } },
        'atlas-x': { ...structuredClone(ATLAS_DEFAULTS), profiles: { dev: { mods: ['B'] } } },
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.where).toBe('/games/atlas-x/profiles/dev')
    expect(problems[0]?.message).toBe('container name collides with /games/atlas/profiles/x-dev')
  })

  test('the same profile name under two games is not a collision', () => {
    const { problems } = merged({
      games: {
        atlas: { profiles: { dev: { mods: ['A'] } } },
        other: { ...structuredClone(ATLAS_DEFAULTS), profiles: { dev: { mods: ['B'] } } },
      },
    })
    expect(problems).toEqual([])
  })

  test('instances that cannot collide are left alone', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: {
            dev: { mods: ['A'], instances: { wt: {}, 'wt-2': {} } },
            'dev-prod': { mods: ['B'], instances: { wt: {} } },
          },
        },
      },
    })
    expect(problems).toEqual([])
  })
})

describe('loadConfig', () => {
  test('a missing file means no games, not a crash', async () => {
    const { config, plugins } = await loadConfig(join(tmpdir(), 'gamecrate-absent', 'profiles.json'))
    expect(config.games).toEqual({})
    expect(plugins.size).toBe(0)
    expect(config.dataRoot.startsWith('~')).toBe(false)
  })

  test('a steamcmd path is expanded like every other host path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    const read = async (steamcmd: string): Promise<RootConfig> => {
      await writeFile(file, `{ "plugins": ["./atlas-plugin.ts"], ${steamcmd} }`)
      return (await loadConfig(file)).config
    }

    expect((await read('"steamcmd": { "path": "~/steamcmd/steamcmd.sh" }')).steamcmd?.path).toBe(
      join(homedir(), 'steamcmd/steamcmd.sh'),
    )
    expect((await read('"steamcmd": { "path": "/usr/games/steamcmd" }')).steamcmd?.path).toBe(
      '/usr/games/steamcmd',
    )
    expect((await read('"steamcmd": { "path": "./bin/steamcmd.sh" }')).steamcmd?.path).toBe(
      './bin/steamcmd.sh',
    )
    expect((await read('"dataRoot": "/tmp/gc"')).steamcmd).toBeUndefined()
  })

  test('a plugin named by path is loaded from the config directory, not the cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts"] }')

    const { config, plugins } = await loadConfig(file)
    expect([...plugins.keys()]).toEqual(['atlas'])
    expect(config.games['atlas']?.core).toBe('atlasco.atlas')
    expect(config.games['atlas']?.dataDir.mode).toBe('arg')
  })

  test('the user file deep-merges over the plugin defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(
      file,
      `{
        // raise the window
        "plugins": ["./atlas-plugin.ts"],
        "defaults": { "settings": { "width": 2560 } },
        "games": {
          "atlas": {
            "settings": { "memory": "16g" },
            "profiles": { "solo": { "mods": ["Kitted.Core"] } },
          },
        },
      }`,
    )
    const { config } = await loadConfig(file)
    expect(config.defaults?.settings?.width).toBe(2560)
    expect(config.defaults?.settings?.height).toBe(1080)
    expect(config.games['atlas']?.settings?.memory).toBe('16g')
    // The plugin's own setting survives a user block that does not mention it.
    expect(config.games['atlas']?.settings?.network).toBe('host')
    expect(Object.keys(config.games['atlas']!.profiles)).toContain('solo')
    expect(config.games['atlas']?.core).toBe('atlasco.atlas')
  })

  test('a user list replaces the plugin list instead of appending to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(
      file,
      `{
        "plugins": ["./atlas-plugin.ts"],
        "games": {
          "atlas": {
            "dlc": ["atlasco.atlas.one"],
            "modes": ["headed"],
            "saveExtensions": ["save"],
            "scanRoots": [{ "path": "/mine", "maxDepth": 2 }],
          },
        },
      }`,
    )
    const { config } = await loadConfig(file)
    const game = config.games['atlas']!
    expect(game.dlc).toEqual(['atlasco.atlas.one'])
    expect(game.modes).toEqual(['headed'])
    expect(game.saveExtensions).toEqual(['save'])
    expect(game.scanRoots).toEqual([{ path: '/mine', maxDepth: 2 }])
  })

  test('an empty list clears a plugin list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts"], "games": { "atlas": { "dlc": [] } } }')
    const { config } = await loadConfig(file)
    expect(config.games['atlas']?.dlc).toEqual([])
  })

  test('a problem in a key the user never wrote names the plugin that supplied it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const plugin = await readFile(join(dir, 'atlas-plugin.ts'), 'utf8')
    await writeFile(join(dir, 'atlas-plugin.ts'), plugin.replace('"executable":"./AtlasLinux"', '"executable":7'))
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts"] }')

    const error = (await loadConfig(file).catch((e: unknown) => e)) as GamecrateError
    expect(error.message).toContain('merged with defaults from: atlas')
    expect(error.detail).toContain("from the atlas plugin's defaults, not this file")
  })

  test('a key neither side supplies says so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const plugin = await readFile(join(dir, 'atlas-plugin.ts'), 'utf8')
    await writeFile(join(dir, 'atlas-plugin.ts'), plugin.replace('"executable":"./AtlasLinux",', ''))
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts"] }')

    const error = (await loadConfig(file).catch((e: unknown) => e)) as GamecrateError
    expect(error.detail).toContain('missing required key "executable"')
    expect(error.detail).toContain("the atlas plugin's defaults do not supply it")
  })

  test('a user key that is wrong is blamed on the user file, not the plugin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts"], "games": { "atlas": { "executable": 7 } } }')

    const error = (await loadConfig(file).catch((e: unknown) => e)) as GamecrateError
    expect(error.detail).toContain('/games/atlas/executable')
    expect(error.detail).not.toContain('plugin')
  })

  test('a JSON __proto__ key never reaches the prototype', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(
      file,
      '{ "plugins": ["./atlas-plugin.ts"], "games": { "atlas": { "profiles": { "solo": { "mods": [] } } } }, "__proto__": { "polluted": true } }',
    )
    const { config } = await loadConfig(file)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect((config as unknown as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  test('a user override beats the plugin default for the same key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(
      file,
      '{ "plugins": ["./atlas-plugin.ts"], "games": { "atlas": { "executable": "./Mine" } } }',
    )
    const { config } = await loadConfig(file)
    expect(config.games['atlas']?.executable).toBe('./Mine')
  })

  test('two plugins claiming one game is a config error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    await writeFile(join(dir, 'twin.ts'), await readFile(join(dir, 'atlas-plugin.ts'), 'utf8'))
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts", "./twin.ts"] }')

    await expect(loadConfig(file)).rejects.toThrow(/also claims the game "atlas"/)
  })

  test('an apiVersion mismatch is a config error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writeFile(join(dir, 'old.ts'), 'export default { apiVersion: 0, game: "atlas" }\n')
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./old.ts"] }')

    await expect(loadConfig(file)).rejects.toThrow(/speaks apiVersion 0/)
  })

  test('a plugin missing a required export is a config error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writeFile(
      join(dir, 'thin.ts'),
      `export default { apiVersion: ${PLUGIN_API_VERSION}, game: "atlas", defaults: {}, windowedPrefs: {}, parseManifest: () => null }\n`,
    )
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./thin.ts"] }')

    await expect(loadConfig(file)).rejects.toThrow(/is missing renderModsConfig, mergePrefs, parseVersion/)
  })

  test('a plugin named as a package is found by walking node_modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    const pkg = join(dir, 'node_modules', 'gamecrate-fixture')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), '{ "name": "gamecrate-fixture", "main": "./plugin.js" }')
    await writePlugin(pkg, 'atlas')
    await writeFile(join(pkg, 'plugin.js'), await readFile(join(pkg, 'atlas-plugin.ts'), 'utf8'))

    // The config sits a level down, so resolution has to walk up to find the package.
    const nested = join(dir, 'nested')
    await mkdir(nested, { recursive: true })
    const file = join(nested, 'profiles.json')
    await writeFile(file, '{ "plugins": ["gamecrate-fixture"] }')

    const { plugins } = await loadConfig(file)
    expect([...plugins.keys()]).toEqual(['atlas'])
  })

  test('a package entry comes from exports conditions, not a stray index.js', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    const pkg = join(dir, 'node_modules', '@fixtures', 'gamecrate-sub')
    await writePluginPackage(pkg, { '.': { bun: './dist/plugin.js', browser: './nope.js' } })
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["@fixtures/gamecrate-sub"] }')

    const { plugins } = await loadConfig(file)
    expect([...plugins.keys()]).toEqual(['atlas'])
  })

  test('a plugin named as a local checkout directory loads that package\'s entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePluginPackage(join(dir, 'checkout'), { '.': './dist/plugin.js' })
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./checkout"] }')

    const { plugins } = await loadConfig(file)
    expect([...plugins.keys()]).toEqual(['atlas'])
  })

  test('an unresolvable plugin names what it looked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["gamecrate-nosuchgame"] }')

    await expect(loadConfig(file)).rejects.toThrow(/cannot be resolved/)
  })

  test('an invalid user file exits with the config code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(
      file,
      '{ "plugins": ["./atlas-plugin.ts"], "games": { "atlas": { "settings": { "devMod": true } } } }',
    )
    let caught: unknown
    try {
      await loadConfig(file)
    } catch (e) {
      caught = e
    }
    expect((caught as GamecrateError).code).toBe(Exit.Config)
    expect((caught as GamecrateError).detail).toContain('did you mean')
  })

  test('tildes in paths are expanded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-'))
    await writePlugin(dir)
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{ "plugins": ["./atlas-plugin.ts"] }')

    const { config } = await loadConfig(file)
    expect(config.games['atlas']!.scanRoots[0]!.path.startsWith('/')).toBe(true)
    expect(config.games['atlas']!.image.context?.startsWith('/')).toBe(true)
  })
})

describe('loadProjectDefaults', () => {
  test('loads the nearest .gamecrate.yml from a parent directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
    const nested = join(dir, 'src', 'mod')
    await mkdir(nested, { recursive: true })
    await writeFile(
      join(dir, '.gamecrate.yml'),
      'game: atlas\ndefaultProfile: kitted\nbuild: true\nreplace: true\nresolution: 2560x1440\nlog: game.log\nmods:\n  - Test.Mod\n',
    )

    expect(await loadProjectDefaults(nested)).toEqual({
      game: 'atlas',
      defaultProfile: 'kitted',
      build: 'always',
      replace: true,
      resolution: { width: 2560, height: 1440 },
      log: 'game.log',
      mods: ['Test.Mod'],
      configPath: join(dir, '.gamecrate.yml'),
    })
  })

  test('build false means never', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
    await writeFile(join(dir, '.gamecrate.yml'), 'build: false\n')
    expect((await loadProjectDefaults(dir)).build).toBe('never')
  })

  test('invalid keys and values use the config exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
    await writeFile(
      join(dir, '.gamecrate.yml'),
      'replace: sometimes\nresolution: 0x1080\nlog: 42\nunknown: true\n',
    )
    try {
      await loadProjectDefaults(dir)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).code).toBe(Exit.Config)
      expect((error as GamecrateError).detail).toContain('/replace')
      expect((error as GamecrateError).detail).toContain('/resolution')
      expect((error as GamecrateError).detail).toContain('/log')
      expect((error as GamecrateError).detail).toContain('/unknown')
    }
  })

  test('every key the parser reads round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
    await writeFile(
      join(dir, '.gamecrate.yml'),
      [
        'game: atlas', 'defaultProfile: kitted', 'mode: headless', 'pull: missing', 'sort: topo',
        'network: host', 'build: auto', 'marker: ready', 'instance: dev', 'log: game.log',
        'timeout: 90', 'renderWait: 0', 'resolution: "1920x1080"',
        'mods: [A]', 'without: [B]', 'only: [C]', 'dockerArgs: ["-v"]', 'gameArgs: ["-q"]',
        'worktree: [/w]', 'use: ["A=/x"]',
        'dryRun: true', 'printPlan: true', 'json: true', 'root: true',
        'noWorktree: true', 'noStaleCheck: true', 'replace: true', '',
      ].join('\n'),
    )

    expect(await loadProjectDefaults(dir)).toEqual({
      game: 'atlas', defaultProfile: 'kitted', mode: 'headless', pull: 'missing', sort: 'topo',
      network: 'host', build: 'auto', marker: 'ready', instance: 'dev', log: 'game.log',
      timeout: 90, renderWait: 0, resolution: { width: 1920, height: 1080 },
      mods: ['A'], without: ['B'], only: ['C'], dockerArgs: ['-v'], gameArgs: ['-q'],
      worktree: ['/w'], use: ['A=/x'],
      dryRun: true, printPlan: true, json: true, root: true,
      noWorktree: true, noStaleCheck: true, replace: true,
      configPath: join(dir, '.gamecrate.yml'),
    })
  })

  test('an empty file is no defaults, but still says which file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
    await writeFile(join(dir, '.gamecrate.yml'), '')
    expect(await loadProjectDefaults(dir)).toEqual({ configPath: join(dir, '.gamecrate.yml') })
  })

  // list prints this name, and four suffixes are legal, so a hardcoded .yml is wrong three
  // times out of four
  test('the suffix that was actually found is the one reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
    await writeFile(join(dir, '.gamecrate.json'), '{"game": "atlas"}')
    expect((await loadProjectDefaults(dir)).configPath).toBe(join(dir, '.gamecrate.json'))
  })

  test('each key reports its own wrong type', async () => {
    const cases: [string, string][] = [
      ['game: "-bad"', '  /game: expected a name'],
      ['marker: 4', '  /marker: expected a string'],
      ['mods: nope', '  /mods: expected an array of strings'],
      ['mods: [4]', '  /mods: expected an array of strings'],
      ['timeout: -1', '  /timeout: expected a whole number of seconds'],
      ['renderWait: 1.5', '  /renderWait: expected a whole number of seconds'],
      ['json: maybe', '  /json: expected true or false'],
      ['mode: window', '  /mode: expected one of headed, headless, screenshot'],
      ['pull: sometimes', '  /pull: expected one of always, missing, never'],
      ['sort: alpha', '  /sort: expected one of topo, none'],
      ['network: macvlan', '  /network: expected one of none, bridge, host'],
      ['build: sometimes', '  /build: expected one of auto, always, never'],
      ['build: 4', '  /build: expected one of auto, always, never'],
      ['resolution: 12', '  /resolution: expected dimensions like 1920x1080'],
      ['resolution: "1920x0"', '  /resolution: --resolution takes positive dimensions like 1920x1080, got 1920x0'],
      ['- a', '  /: expected an object'],
    ]
    for (const [yaml, detail] of cases) {
      const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
      await writeFile(join(dir, '.gamecrate.yml'), `${yaml}\n`)
      const caught = await loadProjectDefaults(dir).then(
        () => undefined,
        (error: unknown) => error as GamecrateError,
      )
      expect(caught?.code).toBe(Exit.Config)
      expect(caught?.detail).toBe(detail)
    }
  })

  test('file defaults sit under the CLI and the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
    await writeFile(join(dir, '.gamecrate.yml'), 'game: atlas\ndefaultProfile: kitted\nmode: headless\nmarker: ready\n')
    const defaults = await loadProjectDefaults(dir)

    const bare = parseArgs([], { env: {}, games: ['atlas'], defaults })
    expect([bare.game, bare.profile, bare.mode, bare.marker]).toEqual(['atlas', undefined, 'headless', 'ready'])

    const cli = parseArgs(['--mode', 'headed'], { env: { GAMECRATE_MARKER: 'env' }, games: ['atlas'], defaults })
    expect([cli.mode, cli.marker]).toEqual(['headed', 'env'])
  })
})

describe('profile aliases', () => {
  const game = (): GameConfig =>
    ({
      profiles: {
        stick: { mods: ['A'], aliases: ['sticktoyoursave', 'stystv'] },
        vanilla: { alias: 'modless' },
        plain: { mods: ['B'] },
      },
    }) as unknown as GameConfig

  test('every spelling resolves to the same profile', () => {
    for (const name of ['stick', 'sticktoyoursave', 'STYSTV']) {
      expect(resolveProfile(game(), name).mods).toEqual(['A'])
    }
  })

  test('an alias canonicalizes, so it never gets its own data dir', () => {
    expect(canonicalProfile(game(), 'sticktoyoursave')).toBe('stick')
    expect(canonicalProfile(game(), 'stystv')).toBe('stick')
    expect(canonicalProfile(game(), 'stick')).toBe('stick')
    expect(canonicalProfile(game(), 'plain')).toBe('plain')
  })

  test('an `alias:` chain canonicalizes too', () => {
    expect(canonicalProfile(game(), 'vanilla')).toBe('modless')
  })

  test('every command reaches one data dir per profile, alias or not', () => {
    const root = { dataRoot: '~/games', games: { atlas: game() } } as unknown as RootConfig
    const canonical = profileDataDir(root, 'atlas', 'stick')
    expect(canonical).toBe(join(homedir(), 'games', 'atlas', 'stick'))
    for (const spelling of ['sticktoyoursave', 'STYSTV']) {
      expect(profileDataDir(root, 'atlas', spelling)).toBe(canonical)
    }
    expect(profileDataDir(root, 'atlas', 'vanilla')).toBe(
      join(homedir(), 'games', 'atlas', 'modless'),
    )
  })

  test('a no-profile scan keeps the directories on disk, and an explicit alias canonicalizes', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'gamecrate-dirs-'))
    const root = { dataRoot, games: { atlas: game() } } as unknown as RootConfig
    for (const name of ['stick', 'Stick', 'sticktoyoursave']) {
      await mkdir(join(dataRoot, 'atlas', name), { recursive: true })
    }

    const scanned = await profileDirs(root, 'atlas')
    expect(scanned.sort()).toEqual(
      ['Stick', 'stick', 'sticktoyoursave'].map((n) => join(dataRoot, 'atlas', n)).sort(),
    )
    expect(await profileDirs(root, 'atlas', 'sticktoyoursave')).toEqual([
      join(dataRoot, 'atlas', 'stick'),
    ])
  })

  test('an alias that shadows a real profile name is a config error', () => {
    const { problems } = merged({
      games: {
        atlas: {
          profiles: { plain: { mods: [] }, other: { mods: [], aliases: ['plain'] } },
        },
      },
    })
    expect(find(problems, 'is already a profile name')).toBeDefined()
  })

  test('a reserved word cannot be an alias', () => {
    const { problems } = merged({
      games: { atlas: { profiles: { a: { mods: [], aliases: ['doctor'] } } } },
    })
    expect(find(problems, 'reserved name')).toBeDefined()
  })
})

describe('config formats', () => {
  test('yaml and json parse to the same object', () => {
    const fromYaml = readConfigText('game: rimworld\nprofiles:\n  dev:\n    mods: [A.B]\n', 'x.yml')
    const fromJson = readConfigText('{"game":"rimworld","profiles":{"dev":{"mods":["A.B"]}}}', 'x.json')
    expect(fromYaml).toEqual(fromJson)
  })

  test('jsonc comments and trailing commas survive', () => {
    const value = readConfigText('{\n  // a note\n  "game": "rimworld",\n}', 'x.jsonc')
    expect(value).toEqual({ game: 'rimworld' })
  })

  test('an unknown suffix is a config error naming the file', () => {
    try {
      readConfigText('game: rimworld', '/tmp/profiles.toml')
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).code).toBe(Exit.Config)
      expect((error as GamecrateError).message).toContain('/tmp/profiles.toml')
    }
  })

  test('a yaml syntax error names the file and keeps the parser detail', () => {
    try {
      readConfigText('game: [unclosed\n', '/tmp/.gamecrate.yml')
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).message).toContain('/tmp/.gamecrate.yml')
      expect((error as GamecrateError).detail).toBeTruthy()
    }
  })

  // js sorts all-integer object keys to the front, so Object.keys lies about which
  // profile was written first. NAME_PATTERN allows a profile called 2024.
  test('orderedKeys reports source order, not Object.keys order', () => {
    const yaml = 'profiles:\n  2024:\n    mods: []\n  dev:\n    mods: []\n  1:\n    mods: []\n'
    expect(orderedKeys(yaml, 'x.yml', 'profiles')).toEqual(['2024', 'dev', '1'])

    const json = '{"profiles":{"2024":{},"dev":{},"1":{}}}'
    expect(orderedKeys(json, 'x.json', 'profiles')).toEqual(['2024', 'dev', '1'])

    expect(Object.keys({ 2024: 1, dev: 1, 1: 1 })).toEqual(['1', '2024', 'dev'])
  })

  test('orderedKeys is empty when the key is missing or not an object', () => {
    expect(orderedKeys('game: rimworld\n', 'x.yml', 'profiles')).toEqual([])
    expect(orderedKeys('profiles: []\n', 'x.yml', 'profiles')).toEqual([])
  })
})

describe('readConfigFile', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gamecrate-read-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('reads every format it probes for', async () => {
    const cases: [string, string][] = [
      ['.yml', 'game: rimworld\n'],
      ['.yaml', 'game: rimworld\n'],
      ['.json', '{"game":"rimworld"}'],
      ['.jsonc', '{ // a comment\n  "game": "rimworld" }'],
    ]
    for (const [suffix, text] of cases) {
      const file = join(dir, `profiles${suffix}`)
      await writeFile(file, text)
      expect(await readConfigFile(file)).toEqual({ game: 'rimworld' })
    }
  })

  test('a missing file is undefined, not an error', async () => {
    expect(await readConfigFile(join(dir, 'profiles.yml'))).toBeUndefined()
  })

  test('a parse failure names the file and uses the config exit code', async () => {
    const file = join(dir, 'profiles.json')
    await writeFile(file, '{"game": }')
    await expect(readConfigFile(file)).rejects.toMatchObject({ code: Exit.Config })
    await readConfigFile(file).catch((error: GamecrateError) => {
      expect(error.message).toContain(file)
    })
  })
})

describe('config discovery', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gamecrate-discover-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('a project config is found in any of the four formats', async () => {
    for (const suffix of ['.yml', '.yaml', '.json', '.jsonc']) {
      const nested = join(dir, `case${suffix}`)
      await mkdir(nested, { recursive: true })
      await writeFile(join(nested, `.gamecrate${suffix}`), suffix.startsWith('.j') ? '{"game":"rimworld"}' : 'game: rimworld\n')
      expect(await findProjectConfig(nested)).toBe(join(nested, `.gamecrate${suffix}`))
    }
  })

  test('two project configs in one directory is an error naming both', async () => {
    await writeFile(join(dir, '.gamecrate.yml'), 'game: rimworld\n')
    await writeFile(join(dir, '.gamecrate.json'), '{"game":"rimworld"}')
    await expect(findProjectConfig(dir)).rejects.toMatchObject({ code: Exit.Config })
    await findProjectConfig(dir).catch((error: GamecrateError) => {
      expect(error.detail).toContain('.gamecrate.yml')
      expect(error.detail).toContain('.gamecrate.json')
    })
  })

  // A yml in a parent and a json in a child is normal nesting, not a conflict.
  test('the nearest directory wins across a walk, in any format', async () => {
    const child = join(dir, 'a', 'b')
    await mkdir(child, { recursive: true })
    await writeFile(join(dir, '.gamecrate.yml'), 'game: rimworld\n')
    await writeFile(join(child, '.gamecrate.json'), '{"game":"rimworld"}')
    expect(await findProjectConfig(child)).toBe(join(child, '.gamecrate.json'))
  })

  test('loadProjectDefaults reads a json project config', async () => {
    await writeFile(join(dir, '.gamecrate.json'), '{"game":"rimworld","mode":"headless"}')
    const defaults = await loadProjectDefaults(dir)
    expect(defaults.game).toBe('rimworld')
    expect(defaults.mode).toBe('headless')
  })

  test('findGlobalConfig probes the four suffixes under XDG_CONFIG_HOME', async () => {
    const xdg = join(dir, 'xdg')
    await mkdir(join(xdg, 'gamecrate'), { recursive: true })
    await writeFile(join(xdg, 'gamecrate', 'profiles.yml'), 'games: {}\n')
    const real = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = xdg
    try {
      expect(await findGlobalConfig()).toBe(join(xdg, 'gamecrate', 'profiles.yml'))
    } finally {
      if (real === undefined) delete process.env['XDG_CONFIG_HOME']
      else process.env['XDG_CONFIG_HOME'] = real
    }
  })
})

describe('project profiles', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gamecrate-project-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function write(body: string, suffix = '.yml'): Promise<void> {
    await writeFile(join(dir, `.gamecrate${suffix}`), body)
  }

  test('profiles, settings and defaultProfile are read', async () => {
    await write('game: rimworld\ndefaultProfile: dev\nprofiles:\n  dev:\n    mods: [A.B]\nsettings:\n  memory: 8g\n')
    const defaults = await loadProjectDefaults(dir)
    expect(defaults.defaultProfile).toBe('dev')
    expect(defaults.profiles).toEqual({ dev: { mods: ['A.B'] } })
    expect(defaults.settings).toEqual({ memory: '8g' })
  })

  test('profileOrder is source order, not Object.keys order', async () => {
    await write('game: rimworld\nprofiles:\n  2024:\n    mods: []\n  dev:\n    mods: []\n')
    const defaults = await loadProjectDefaults(dir)
    expect(defaults.profileOrder).toEqual(['2024', 'dev'])
  })

  // recovering source order from a duplicate key is guesswork, so it is an error now.
  test('a duplicate profiles key is a config error', async () => {
    await write('{"game":"rimworld","profiles":{"first":{}},"profiles":{"second":{}}}', '.json')
    await expect(loadProjectDefaults(dir)).rejects.toMatchObject({ code: Exit.Config })
  })

  test('a duplicate key inside profiles is a config error', async () => {
    await write('{"game":"rimworld","profiles":{"dev":{},"dev":{}}}', '.json')
    await expect(loadProjectDefaults(dir)).rejects.toMatchObject({ code: Exit.Config })
  })

  test.each([
    ['profiles without a game', 'profiles:\n  dev:\n    mods: []\n', 'game'],
    ['the old profile key', 'game: rimworld\nprofile: dev\n', 'unknown key'],
    ['library without a game', 'library:\n  Some.Mod:\n    git: https://example.com/x.git\n', 'top-level game:'],
  ])('%s is a config error that says why', async (_case, text, needle) => {
    await write(text)
    await expect(loadProjectDefaults(dir)).rejects.toMatchObject({ code: Exit.Config })
    await loadProjectDefaults(dir).catch((error: GamecrateError) => {
      expect(error.detail).toContain(needle)
    })
  })

  test('settings without a game is the same error', async () => {
    await write('settings:\n  memory: 8g\n')
    await expect(loadProjectDefaults(dir)).rejects.toMatchObject({ code: Exit.Config })
  })

  test('flag defaults still work with none of the new keys', async () => {
    await write('game: rimworld\nmode: headless\ntimeout: 30\n')
    const defaults = await loadProjectDefaults(dir)
    expect(defaults.mode).toBe('headless')
    expect(defaults.timeout).toBe(30)
    expect(defaults.profiles).toBeUndefined()
  })

  test('detach is a project key like every other flag default', async () => {
    await write('game: rimworld\ndetach: true\n')
    expect((await loadProjectDefaults(dir)).detach).toBe(true)
  })
})

describe('repo profile splice', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gamecrate-splice-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function globalConfig(games: unknown): Promise<string> {
    const path = join(dir, 'profiles.json')
    await writeFile(path, JSON.stringify({ plugins: [], games }))
    return path
  }

  test('a repo profile replaces the global one wholesale', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), profiles: { dev: { mods: ['Global.One'], instances: { wt: {} } } } },
    })
    const { config } = await loadConfig(path, {
      game: 'rimworld',
      profiles: { dev: { mods: ['Repo.One'] } },
    })
    expect(config.games['rimworld']!.profiles['dev']!.mods).toEqual(['Repo.One'])
    // Replacement is wholesale, so the global instances are gone. Documented, not a bug.
    expect(config.games['rimworld']!.profiles['dev']!.instances).toBeUndefined()
  })

  test('a global profile the repo does not name is untouched', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), profiles: { dev: { mods: ['A'] }, base: { mods: ['B'] } } },
    })
    const { config } = await loadConfig(path, { game: 'rimworld', profiles: { dev: { mods: ['C'] } } })
    expect(config.games['rimworld']!.profiles['base']!.mods).toEqual(['B'])
  })

  test('a repo profile can extend a global parent', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), profiles: { base: { mods: ['Base.One'] } } },
    })
    const { config } = await loadConfig(path, {
      game: 'rimworld',
      profiles: { dev: { extends: 'base', mods: ['Repo.One'] } },
    })
    const resolved = resolveProfile(config.games['rimworld']!, 'dev')
    expect(resolved.mods).toEqual(['Base.One', 'Repo.One'])
  })

  test('repo settings merge into the game settings', async () => {
    const path = await globalConfig({ rimworld: { ...fixtureGame(), settings: { memory: '4g', cpus: 2 } } })
    const { config } = await loadConfig(path, { game: 'rimworld', settings: { memory: '8g' } })
    expect(config.games['rimworld']!.settings).toMatchObject({ memory: '8g', cpus: 2 })
  })

  test('a repo profile colliding with a global alias is a config error', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), profiles: { base: { mods: [], aliases: ['dev'] } } },
    })
    await expect(
      loadConfig(path, { game: 'rimworld', profiles: { dev: { mods: [] } } }),
    ).rejects.toMatchObject({ code: Exit.Config })
  })

  test('a bad repo profile is blamed on the repo file, not the global config', async () => {
    const path = await globalConfig({ rimworld: fixtureGame() })
    await expect(
      loadConfig(path, { game: 'rimworld', profiles: { dev: { extends: 'nope' } } }),
    ).rejects.toMatchObject({ code: Exit.Config })
    await loadConfig(path, {
      game: 'rimworld',
      profiles: { dev: { extends: 'nope' } },
    }).catch((error: GamecrateError) => {
      expect(error.detail).toContain('.gamecrate')
    })
  })

  // a bare `profiles[name] = x` write would hit the prototype setter and drop the profile
  // before validateConfig ever saw the name.
  test('a repo profile named __proto__ lands as an own key, not on the prototype', async () => {
    const path = await globalConfig({ rimworld: { ...fixtureGame(), profiles: { base: { mods: ['B'] } } } })
    const profiles = JSON.parse('{"__proto__":{"mods":["Evil.Mod"]},"dev":{"mods":7}}') as Record<
      string,
      unknown
    >
    const project = { game: 'rimworld', profiles }
    await expect(loadConfig(path, project)).rejects.toMatchObject({ code: Exit.Config })
    await loadConfig(path, project).catch((error: GamecrateError) => {
      expect(error.detail).toContain('__proto__')
      // dev is invalid too, so its pointer only shows up if the sibling survived the spread.
      expect(error.detail).toContain('/profiles/dev')
    })
  })

  test('a repo profile shadowing a global one is still blamed on the repo file', async () => {
    const path = await globalConfig({
      rimworld: {
        ...fixtureGame(),
        profiles: { base: { mods: ['B'] }, dev: { extends: 'base', mods: ['A'] } },
      },
    })
    const project = { game: 'rimworld', profiles: { dev: { extends: 'nope' } } }
    await expect(loadConfig(path, project)).rejects.toMatchObject({ code: Exit.Config })
    await loadConfig(path, project).catch((error: GamecrateError) => {
      expect(error.detail).toContain('.gamecrate')
    })
  })

  test('a problem in a global key the repo never names is not blamed on the repo file', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), profiles: { base: { extends: 'nope' } } },
    })
    const project = { game: 'rimworld', profiles: { dev: { mods: [] } } }
    await expect(loadConfig(path, project)).rejects.toMatchObject({ code: Exit.Config })
    await loadConfig(path, project).catch((error: GamecrateError) => {
      expect(error.detail).not.toContain('.gamecrate')
    })
  })

  test('library in a repo config replaces a global pin of the same id whole', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), library: { 'Some.Mod': { workshop: 7 }, 'Other.Mod': { workshop: 9 } } },
    })
    const { config } = await loadConfig(path, {
      game: 'rimworld',
      library: { 'Some.Mod': { git: 'https://example.com/x.git', branch: 'main' } },
    })
    const library = config.games['rimworld']!.library!
    expect(library['Some.Mod']).toEqual({ git: 'https://example.com/x.git', branch: 'main' })
    expect(library['Other.Mod']).toEqual({ workshop: 9 })
  })

  test('a repo pin replaces a global one however either file spelled the id', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), library: { 'some.mod': { workshop: 7 }, 'Other.Mod': { workshop: 9 } } },
    })
    const { config } = await loadConfig(path, {
      game: 'rimworld',
      library: { 'Some.Mod': { git: 'https://example.com/x.git', branch: 'main' } },
    })
    const library = config.games['rimworld']!.library!
    // one key, the repo's spelling. both alive would hand two profiles two pins for one mod
    expect(Object.keys(library).sort()).toEqual(['Other.Mod', 'Some.Mod'])
    expect(library['Some.Mod']).toEqual({ git: 'https://example.com/x.git', branch: 'main' })

    // and the other way round, so it is not the global spelling that happens to lose
    const upper = await globalConfig({
      rimworld: { ...fixtureGame(), library: { 'Some.Mod': { workshop: 7 } } },
    })
    const lowered = await loadConfig(upper, {
      game: 'rimworld',
      library: { 'some.mod': { git: 'https://example.com/y.git', branch: 'main' } },
    })
    expect(Object.keys(lowered.config.games['rimworld']!.library!)).toEqual(['some.mod'])
  })

  test('a repo pin of a different id leaves every global spelling alone', async () => {
    const path = await globalConfig({
      rimworld: { ...fixtureGame(), library: { 'some.mod': { workshop: 7 }, 'Some.Other': { workshop: 9 } } },
    })
    const { config } = await loadConfig(path, {
      game: 'rimworld',
      library: { 'Third.Mod': { git: 'https://example.com/x.git', branch: 'main' } },
    })
    // the fold must only drop a key the repo actually replaces
    expect(Object.keys(config.games['rimworld']!.library!).sort()).toEqual(['Some.Other', 'Third.Mod', 'some.mod'])
  })

  test('library in a repo config splices with no profiles or settings beside it', async () => {
    const path = await globalConfig({ rimworld: fixtureGame() })
    const { config } = await loadConfig(path, {
      game: 'rimworld',
      library: { 'Some.Mod': { git: 'https://example.com/x.git' } },
    })
    expect(config.games['rimworld']!.library!['Some.Mod']).toEqual({ git: 'https://example.com/x.git' })
  })

  test('a bad library in a repo config is blamed on the repo file', async () => {
    const path = await globalConfig({ rimworld: fixtureGame() })
    const project = { game: 'rimworld', library: { 'Some.Mod': { branch: 'main' } } }
    await expect(loadConfig(path, project)).rejects.toMatchObject({ code: Exit.Config })
    await loadConfig(path, project).catch((error: GamecrateError) => {
      expect(error.detail).toContain('from the .gamecrate project config')
    })
  })

  test('naming a game the global config does not have is a config error', async () => {
    const path = await globalConfig({ rimworld: fixtureGame() })
    await expect(
      loadConfig(path, { game: 'nosuchgame', profiles: { dev: { mods: [] } } }),
    ).rejects.toMatchObject({ code: Exit.Config })
  })
})

describe('profileOf', () => {
  const noProfile = { } as ParsedArgs
  const typed = { profile: 'typed' } as ParsedArgs

  test('a typed profile beats every default', () => {
    expect(profileOf(typed, { defaultProfile: 'yml', profileOrder: ['first'] })).toBe('typed')
  })

  test('defaultProfile beats the first profile key', () => {
    expect(profileOf(noProfile, { defaultProfile: 'yml', profileOrder: ['first'] })).toBe('yml')
  })

  test('the first profile key wins when defaultProfile is absent', () => {
    expect(profileOf(noProfile, { profileOrder: ['first', 'second'] })).toBe('first')
  })

  // Source order, so a profile named 2024 written first is still first.
  test('the first key is source order, not Object.keys order', () => {
    expect(profileOf(noProfile, { profileOrder: ['2024', 'dev'] })).toBe('2024')
  })

  test('modless is the floor with no project config at all', () => {
    expect(profileOf(noProfile, {})).toBe('modless')
  })

  test('args.profile stays undefined so verbs can tell typed from defaulted', () => {
    const args = parseArgs(['rimworld'], { env: {}, games: ['rimworld'] })
    expect(args.profile).toBeUndefined()
  })
})

describe('profile descriptions', () => {
  test('a description is accepted and surfaces in both output shapes', () => {
    const config = {
      dataRoot: '/tmp',
      games: {
        rimworld: {
          ...fixtureGame(),
          modes: ['headed'],
          profiles: {
            dev: { mods: ['A'], description: 'my day to day modded run' },
            bare: { mods: [] },
          },
        },
      },
    } as unknown as RootConfig

    const text = captureStdout(() => list({ } as ParsedArgs, config, {}))
    expect(text).toContain('my day to day modded run')

    const json = JSON.parse(captureStdout(() => list({ json: true } as ParsedArgs, config, {})))
    const profiles = json[0].profiles as { profile: string; description: string | null }[]
    expect(profiles.find((p) => p.profile === 'dev')?.description).toBe('my day to day modded run')
    expect(profiles.find((p) => p.profile === 'bare')?.description).toBeNull()
  })

  test('a profile carries its own launch defaults', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'gamecrate-launchdefaults-')), 'profiles.json')
    await writeFile(
      path,
      JSON.stringify({
        plugins: [],
        games: {
          rimworld: {
            ...fixtureGame(),
            profiles: { server: { mods: [], detach: true, replace: true, build: 'always' } },
          },
        },
      }),
    )
    const { config } = await loadConfig(path)
    const server = config.games['rimworld']!.profiles['server']!
    expect(server.detach).toBe(true)
    expect(server.replace).toBe(true)
    expect(server.build).toBe('always')
  })

  test('a bad build policy on a profile is a config error at the key', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'gamecrate-badbuild-')), 'profiles.json')
    await writeFile(
      path,
      JSON.stringify({ plugins: [], games: { rimworld: { ...fixtureGame(), profiles: { dev: { mods: [], build: 'sometimes' } } } } }),
    )
    await expect(loadConfig(path)).rejects.toMatchObject({ code: Exit.Config })
    await loadConfig(path).catch((error: GamecrateError) => {
      expect(error.code).toBe(Exit.Config)
      expect(error.detail).toContain('/games/rimworld/profiles/dev/build')
    })
  })

  test('a non-string description is a config error pointing at the key', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'gamecrate-desc-')), 'profiles.json')
    await writeFile(
      path,
      JSON.stringify({ plugins: [], games: { rimworld: { ...fixtureGame(), profiles: { dev: { mods: [], description: 7 } } } } }),
    )
    await expect(loadConfig(path)).rejects.toMatchObject({ code: Exit.Config })
    await loadConfig(path).catch((error: GamecrateError) => {
      expect(error.code).toBe(Exit.Config)
      expect(error.detail).toContain('/games/rimworld/profiles/dev/description')
    })
  })
})

describe('list provenance', () => {
  test('a repo profile is tagged in both output shapes', () => {
    const config = {
      dataRoot: '/tmp',
      games: {
        rimworld: {
          ...fixtureGame(),
          modes: ['headed'],
          profiles: { dev: { mods: ['A'] }, base: { mods: ['B'] } },
        },
      },
    } as unknown as RootConfig
    // .json on purpose: the note used to name .gamecrate.yml whatever the repo actually had
    const defaults: ProjectDefaults = {
      game: 'rimworld',
      profiles: { dev: { mods: ['A'] } },
      configPath: '/repo/.gamecrate.json',
    }

    const text = captureStdout(() => list({ } as ParsedArgs, config, defaults))
    expect(text).toContain('from .gamecrate.json')
    expect(text).not.toContain('.gamecrate.yml')
    expect(text.split('\n').find((l) => l.includes('base'))).not.toContain('from .gamecrate')

    const json = JSON.parse(captureStdout(() => list({ json: true } as ParsedArgs, config, defaults)))
    const profiles = json[0].profiles as { profile: string; source: string }[]
    expect(profiles.find((p) => p.profile === 'dev')?.source).toBe('project')
    expect(profiles.find((p) => p.profile === 'base')?.source).toBe('config')
  })
})

function captureStdout(body: () => void): string {
  const real = process.stdout.write.bind(process.stdout)
  let text = ''
  process.stdout.write = ((chunk: string) => {
    text += chunk
    return true
  }) as typeof process.stdout.write
  try {
    body()
  } finally {
    process.stdout.write = real
  }
  return text
}
