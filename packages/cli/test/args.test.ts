import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SUBCOMMANDS,
  VERB_GROUPS,
  allOptions,
  buildPolicy,
  buildProgram,
  parseArgs,
  suggest,
  supervisedDir,
  supervisorArgv,
  wantsDetach,
  wantsSteam,
  wantsReplace,
} from '../src/cli/args'
import { renderHelp } from '../src/cli/help'
import { requireGame } from '../src/cli/game'
import { profileNames } from '../src/config/load'
import { complete, renderCompletion } from '../src/cli/complete'
import {
  forwardOutput,
  openRunLog,
  planPayload,
  captureOutput,
  reportProblems,
  rotateRuns,
  runTimestamp,
  status,
  warn,
} from '../src/cli/output'
import { emit, useBaseSink, useSink } from '../src/channels'
import { exited, spawnArgv } from '../src/docker/run'
import { FIXTURE_STEAM_BUILD, FIXTURE_VERSION, fixturePlugin } from './fixture-plugin'
import type { ParseOptions } from '../src/cli/args'
import type { GameConfig, LaunchPlan, Problem, ProjectDefaults, RootConfig, Settings } from '../src/types'
import { GamecrateError, Exit, NAME_PATTERN, RESERVED_NAMES } from '../src/types'

const NO_ENV = { env: {} }

function fails(argv: string[], opts: Omit<ParseOptions, 'env'> = {}): GamecrateError {
  try {
    parseArgs(argv, { env: {}, ...opts })
  } catch (error) {
    expect(error).toBeInstanceOf(GamecrateError)
    return error as GamecrateError
  }
  throw new Error(`expected ${argv.join(' ')} to fail`)
}

describe('positionals', () => {
  test('a lone profile is refused and points at run', () => {
    const error = fails(['kitted'], { games: ['beacon'], profiles: { beacon: ['kitted'] } })
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toBe('kitted is a profile, not a subcommand')
    expect(error.detail).toBe('run it with: gamecrate run kitted')
  })

  test('a subcommand word wins the first slot, and run escapes it', () => {
    const asVerb = parseArgs(['build', 'kitted'], { env: {}, games: ['beacon'], profiles: { beacon: ['kitted'] } })
    expect(asVerb.subcommand).toBe('build')
    expect(asVerb.game).toBe('beacon')
    expect(asVerb.profile).toBe('kitted')

    const asProfile = parseArgs(['run', 'build'], { env: {}, games: ['beacon'], profiles: { beacon: ['build'] } })
    expect(asProfile.subcommand).toBe('run')
    expect(asProfile.game).toBe('beacon')
    expect(asProfile.profile).toBe('build')
  })

  test('extra positionals past a subcommand shape are rejected', () => {
    const error = fails(['list', 'kitted'])
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('unexpected argument kitted')
  })

  test('clone keeps src and dst in rest', () => {
    const args = parseArgs(['clone', 'kitted', 'kitted-2'], {
      env: {},
      games: ['beacon'],
      profiles: { beacon: ['kitted', 'kitted-2'] },
    })
    expect(args.game).toBe('beacon')
    expect(args.rest).toEqual(['kitted', 'kitted-2'])
  })

  test('an unknown first word suggests a near subcommand', () => {
    const error = fails(['lst'], { games: ['atlas'], profiles: { atlas: ['kitted'] } })
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('lst is not a subcommand')
    expect(error.detail).toBe('did you mean list?')
  })

  test('an unknown first word never suggests a profile', () => {
    const error = fails(['kited'], { games: ['atlas'], profiles: { atlas: ['kitted'] } })
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('kited is not a subcommand')
    expect(error.detail).toBeUndefined()
  })

  test('a path-shaped name is not a profile', () => {
    expect(fails(['../etc'], { games: ['atlas'] }).code).toBe(Exit.Usage)
  })

  test('no arguments asks for help', () => {
    const args = parseArgs([], NO_ENV)
    expect(args.subcommand).toBe('help')
    expect(args.help).toBe(true)
  })

  test('--ci is off unless it is passed, and shell never takes it', () => {
    expect(parseArgs(['run'], NO_ENV).ci).toBe(false)
    expect(fails(['shell', '--ci']).code).toBe(Exit.Usage)
  })

  test('--ci reaches every verb that resolves a profile', () => {
    const verbs = ['run', 'mods', 'logs', 'verify', 'clean', 'stop', 'attach', 'wait', 'build', 'refs']
    for (const verb of verbs) {
      expect(parseArgs([verb, '--ci'], NO_ENV).ci).toBe(true)
    }
  })

  test('a mods subverb takes none of the profile flags its parent takes', () => {
    for (const argv of [['--ci'], ['--mod', 'some.mod'], ['--sort', 'topo']]) {
      expect(fails(['mods', 'sync', ...argv]).message).toContain(`mods sync does not take ${argv[0]}`)
    }
  })

  test('a flag the environment supplied never scopes a subverb out', () => {
    const env = { GAMECRATE_SORT: 'none' }
    expect(parseArgs(['mods', 'sync'], { env, games: ['rimworld'] }).sort).toBe('none')
    expect(parseArgs(['run'], { env, games: ['rimworld'] }).sort).toBe('none')
  })

  test('--ci names the game, the way a typed profile does', () => {
    const two = { games: ['rimworld', 'westmyth'], profiles: { rimworld: ['dev'], westmyth: ['ci'] } }
    expect(parseArgs(['run', '--ci'], { env: {}, ...two }).game).toBe('westmyth')

    const both = { games: ['rimworld', 'westmyth'], profiles: { rimworld: ['ci'], westmyth: ['ci'] } }
    expect(parseArgs(['run', '--ci'], { env: {}, ...both, defaults: { game: 'westmyth' } }).game).toBe('westmyth')
    expect(fails(['run', '--ci'], both).detail).toContain('--game rimworld or --game westmyth')

    const none = { games: ['rimworld', 'westmyth'], profiles: { rimworld: ['dev'], westmyth: [] } }
    expect(parseArgs(['run', '--ci'], { env: {}, ...none }).game).toBeUndefined()
  })

  test('every subcommand is reserved, and modless is a profile, not a subcommand', () => {
    for (const sub of SUBCOMMANDS) expect(RESERVED_NAMES).toContain(sub.name)
    expect(SUBCOMMANDS.map((s) => s.name)).not.toContain('modless')
    expect(parseArgs(['run', 'modless'], NO_ENV).profile).toBe('modless')

    const error = fails(['modless'])
    expect(error.message).toBe('modless is a profile, not a subcommand')
    expect(error.detail).toBe('run it with: gamecrate run modless')
  })
})

describe('the bare -- split', () => {
  test('everything after -- is a game arg, verbatim', () => {
    const args = parseArgs(
      ['run', 'kitted', '--mode', 'headless', '--', '-savedatafolder=/data', '--mod', 'quicksave'],
      NO_ENV,
    )
    expect(args.mode).toBe('headless')
    expect(args.mods).toEqual([])
    expect(args.gameArgs).toEqual(['-savedatafolder=/data', '--mod', 'quicksave'])
  })

  test('a bare word after -- stays a game arg', () => {
    const args = parseArgs(['run', 'kitted', '--', 'quickstart'], NO_ENV)
    expect(args.gameArgs).toEqual(['quickstart'])
    expect(args.profile).toBe('kitted')
    expect(args.rest).toEqual([])
  })

  test('a second -- belongs to the game', () => {
    expect(parseArgs(['run', 'beacon', '--', 'a', '--', 'b'], NO_ENV).gameArgs).toEqual(['a', '--', 'b'])
  })

  test('no -- means no game args at all', () => {
    const args = parseArgs(['run', 'kitted'], NO_ENV)
    expect(args.profile).toBe('kitted')
    expect(args.gameArgs).toEqual([])
  })
})

describe('repeatable flags', () => {
  test('each occurrence takes exactly one argv element, spaces included', () => {
    const args = parseArgs(
      [
        'run',
        'beacon',
        '--mod',
        'Bridge.Lantern',
        '--mod',
        'path:/fixtures/my mods/Kitted Core',
        '--docker-arg',
        '--mount=type=bind,src=/mnt/my games/x,dst=/x',
        '--docker-arg',
        '--label=note=hello world',
      ],
      NO_ENV,
    )
    expect(args.mods).toEqual(['Bridge.Lantern', 'path:/fixtures/my mods/Kitted Core'])
    expect(args.dockerArgs).toEqual([
      '--mount=type=bind,src=/mnt/my games/x,dst=/x',
      '--label=note=hello world',
    ])
  })

  test('--docker-arg accepts a dash-leading value as a separate element', () => {
    expect(parseArgs(['run', 'beacon', '--docker-arg', '--network=host'], NO_ENV).dockerArgs).toEqual([
      '--network=host',
    ])
  })

  test('--without and --only collect independently', () => {
    const args = parseArgs(['run', 'beacon', '--without', 'a', '--without', 'b', '--only', 'c'], NO_ENV)
    expect(args.without).toEqual(['a', 'b'])
    expect(args.only).toEqual(['c'])
  })

  test('a non-repeatable value flag given twice is an error', () => {
    expect(fails(['run', 'beacon', '--mode', 'headed', '--mode', 'headless']).message).toContain('more than once')
  })
})

describe('flag rejection', () => {
  test('an unknown flag is an error with a suggestion', () => {
    const error = fails(['run', 'beacon', '--dryrun'])
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('unknown flag --dryrun')
    expect(error.detail).toBe('did you mean --dry-run?')
  })

  test('a typo’d flag is never swallowed as a mod name', () => {
    expect(fails(['run', 'beacon', 'kitted', '--mdo', 'Bridge.Lantern']).message).toContain('unknown flag')
  })

  test('a value flag followed by a flag is an error', () => {
    expect(fails(['run', 'beacon', '--mod', '--json']).message).toContain('needs a value')
  })

  test('a value flag at the end is an error', () => {
    expect(fails(['run', 'beacon', '--marker']).message).toContain('needs a value')
  })

  test('a boolean flag rejects a value', () => {
    expect(fails(['run', 'beacon', '--dry-run=yes']).message).toContain('takes no value')
  })

  test('enums are checked', () => {
    expect(fails(['run', 'beacon', '--mode', 'window']).message).toContain('headed, headless, screenshot')
    expect(fails(['run', 'beacon', '--pull', 'sometimes']).message).toContain('always, missing, never')
    expect(fails(['run', 'beacon', '--network', 'macvlan']).message).toContain('none, bridge, host')
  })

  test('--network overrides the game default', () => {
    expect(parseArgs(['run', 'atlas', '--network', 'none'], NO_ENV).network).toBe('none')
    expect(parseArgs(['run', 'atlas'], { env: { GAMECRATE_NETWORK: 'bridge' } }).network).toBe('bridge')
  })

  test('--timeout takes whole seconds', () => {
    expect(parseArgs(['run', 'beacon', '--timeout', '90'], NO_ENV).timeout).toBe(90)
    expect(fails(['run', 'beacon', '--timeout', '9.5']).message).toContain('whole number')
    expect(fails(['run', 'beacon', '--timeout', '-1']).message).toContain('needs a value')
  })

  test('--build and --no-build contradict', () => {
    expect(parseArgs(['run', 'beacon', '--build'], NO_ENV).build).toBe('always')
    expect(parseArgs(['run', 'beacon', '--no-build'], NO_ENV).build).toBe('never')
    expect(fails(['run', 'beacon', '--build', '--no-build']).message).toContain('contradict')
  })

  test('--flag=value is accepted, empty is not', () => {
    expect(parseArgs(['run', 'beacon', '--mod=Bridge.Lantern'], NO_ENV).mods).toEqual(['Bridge.Lantern'])
    expect(fails(['run', 'beacon', '--mod=']).message).toContain('needs a value')
  })

  test('an inline value may start with a dash, a separate token may not', () => {
    expect(parseArgs(['run', 'beacon', '--marker=->ready'], NO_ENV).marker).toBe('->ready')
    expect(parseArgs(['run', 'beacon', '--mod=-x'], NO_ENV).mods).toEqual(['-x'])
    expect(parseArgs(['run', 'beacon', '--worktree=-x'], NO_ENV).worktree).toEqual(['-x'])
    expect(parseArgs(['run', 'beacon', '--instance=-a'], NO_ENV).instance).toBe('-a')

    expect(fails(['run', 'beacon', '--marker', '->ready']).message).toBe(
      '--marker needs a value, got the flag ->ready',
    )
    expect(fails(['run', 'beacon', '--mod', '-x']).message).toContain('got the flag -x')
  })

  test('--docker-arg takes a dash value either way', () => {
    expect(parseArgs(['run', 'beacon', '--docker-arg', '-v'], NO_ENV).dockerArgs).toEqual(['-v'])
    expect(parseArgs(['run', 'beacon', '--docker-arg=-v'], NO_ENV).dockerArgs).toEqual(['-v'])
  })

  test('a separate empty value is a value, an inline empty one is not', () => {
    expect(parseArgs(['run', 'beacon', '--marker', ''], NO_ENV).marker).toBe('')
    expect(fails(['run', 'beacon', '--marker=']).message).toBe('--marker needs a value')
  })

  test('a negative number reads as a flag only as a separate token', () => {
    expect(fails(['run', 'beacon', '--timeout', '-1']).message).toContain('needs a value, got the flag -1')
    expect(fails(['run', 'beacon', '--timeout=-1']).message).toContain('whole number of seconds, got -1')
    expect(fails(['run', 'beacon', '--mode=-x']).message).toContain('headed, headless, screenshot')
  })

  test('everything after -- is passed through untouched', () => {
    expect(parseArgs(['run', 'beacon', '--', '-x', '--mod'], NO_ENV).gameArgs).toEqual(['-x', '--mod'])
  })

  test('aliases are limited to -h and -y', () => {
    expect(parseArgs(['clean', 'kitted', '-y'], NO_ENV).yes).toBe(true)
    expect(parseArgs(['list', '-h'], NO_ENV).help).toBe(true)
    expect(fails(['run', 'beacon', '-m', 'x']).message).toContain('unknown flag')
  })

  test('--replace and --no-stale-check are booleans, off by default', () => {
    const bare = parseArgs(['run', 'kitted'], NO_ENV)
    expect(bare.replace).toBe(false)
    expect(bare.noStaleCheck).toBe(false)

    const both = parseArgs(['run', 'kitted', '--replace', '--no-stale-check'], NO_ENV)
    expect(both.replace).toBe(true)
    expect(both.noStaleCheck).toBe(true)
    expect(fails(['run', 'beacon', '--replace=yes']).message).toContain('takes no value')
  })

  test('verify takes a profile, and --game says which game', () => {
    const args = parseArgs(['verify', 'kitted', '--game', 'atlas'], NO_ENV)
    expect(args.subcommand).toBe('verify')
    expect(args.game).toBe('atlas')
    expect(args.profile).toBe('kitted')
  })

  test('refs and build take a profile and --image, so they can name the pinned build', () => {
    for (const verb of ['refs', 'build']) {
      const args = parseArgs([verb, 'kitted', '--game', 'atlas', '--image', 'ghcr.io/me/atlas:2.0'], NO_ENV)
      expect(args.subcommand).toBe(verb)
      expect(args.game).toBe('atlas')
      expect(args.profile).toBe('kitted')
      expect(args.image).toBe('ghcr.io/me/atlas:2.0')
    }
  })

  test('--replace and --no-replace contradict', () => {
    expect(parseArgs(['run', 'beacon', '--no-replace'], NO_ENV).replace).toBe(false)
    expect(fails(['run', 'beacon', '--replace', '--no-replace']).message).toContain('contradict')
  })

  test('a boolean flag may repeat; a value flag may not', () => {
    expect(parseArgs(['run', 'beacon', '--dry-run', '--dry-run'], NO_ENV).dryRun).toBe(true)
    expect(fails(['run', 'beacon', '--instance', 'a', '--instance', 'b']).message).toContain('more than once')
  })

  test('--worktree and --no-worktree both land, in either order', () => {
    const args = parseArgs(['run', 'beacon', '--worktree', '/a', '--no-worktree'], NO_ENV)
    expect(args.worktree).toEqual(['/a'])
    expect(args.noWorktree).toBe(true)
  })

  test('--use keeps the = in its value', () => {
    expect(parseArgs(['run', 'beacon', '--use', 'Bridge.Lantern=/src/lantern'], NO_ENV).use).toEqual([
      'Bridge.Lantern=/src/lantern',
    ])
  })

  test('a global flag is accepted by every subcommand', () => {
    const args = parseArgs(['list', '--game', 'atlas', '--json'], NO_ENV)
    expect(args.subcommand).toBe('list')
    expect(args.game).toBe('atlas')
    expect(args.json).toBe(true)
  })

  test('a flag another subcommand owns is refused, and named where it belongs', () => {
    const error = fails(['list', '--game', 'atlas', '--mode', 'headless'])
    expect(error.message).toBe('list does not take --mode')
    expect(error.detail).toContain('gamecrate run')
  })

  test('a steam build flag is refused on a launch', () => {
    expect(fails(['run', 'atlas', '--push']).message).toBe('run does not take --push')
  })
})

describe('env fallbacks', () => {
  test('only GAMECRATE_ prefixed vars are read', () => {
    const env = { MODE: 'headless', TIMEOUT: '5', MARKER: 'boom', GAMECRATE_MODE: 'screenshot' }
    const args = parseArgs(['run', 'atlas'], { env })
    expect(args.mode).toBe('screenshot')
    expect(args.timeout).toBeUndefined()
    expect(args.marker).toBeUndefined()
  })

  test('a flag beats the env var', () => {
    const args = parseArgs(['run', 'atlas', '--mode', 'headed'], { env: { GAMECRATE_MODE: 'headless' } })
    expect(args.mode).toBe('headed')
  })

  test('GAMECRATE_BUILD carries a policy', () => {
    expect(parseArgs(['run', 'atlas'], { env: { GAMECRATE_BUILD: 'never' } }).build).toBe('never')
    expect(() => parseArgs(['run', 'atlas'], { env: { GAMECRATE_BUILD: 'maybe' } })).toThrow(GamecrateError)
  })

  test('a bad env value fails the same way a bad flag does', () => {
    expect(() => parseArgs(['run', 'atlas'], { env: { GAMECRATE_PULL: 'sometimes' } })).toThrow(
      /always, missing, never/,
    )
  })

  test('an env value goes through the flag\'s own parser', () => {
    expect(parseArgs(['run', 'atlas'], { env: { GAMECRATE_TIMEOUT: '45' } }).timeout).toBe(45)
    expect(() => parseArgs(['run', 'atlas'], { env: { GAMECRATE_TIMEOUT: '9.5' } })).toThrow(/whole number/)
  })

  test('GAMECRATE_ROOT is truthy-checked', () => {
    expect(parseArgs(['run', 'atlas'], { env: { GAMECRATE_ROOT: '1' } }).root).toBe(true)
    expect(parseArgs(['run', 'atlas'], { env: { GAMECRATE_ROOT: '0' } }).root).toBe(false)
  })
})

describe('project defaults', () => {
  const defaults: ProjectDefaults = {
    game: 'atlas',
    defaultProfile: 'kitted',
    mode: 'headless',
    build: 'always',
    replace: true,
    resolution: { width: 2560, height: 1440 },
    mods: ['Default.Mod'],
    gameArgs: ['-quicktest'],
    noWorktree: true,
    log: 'default.log',
  }

  test('a bare invocation is help, even where a config names a game', () => {
    const args = parseArgs([], { env: {}, games: ['atlas'], defaults })
    expect(args.subcommand).toBe('help')
    expect(args.help).toBe(true)
    expect(args.game).toBeUndefined()
  })

  test('a bare run takes the configured game and every file default', () => {
    const args = parseArgs(['run'], { env: {}, games: ['atlas'], defaults })
    expect(args.subcommand).toBe('run')
    expect(args.help).toBe(false)
    expect(args.game).toBe('atlas')
    expect(args.profile).toBeUndefined()
    expect(args.build).toBe('always')
    expect(args.replace).toBe(true)
    expect(args.resolution).toEqual({ width: 2560, height: 1440 })
    expect(args.log).toBe('default.log')
  })

  test('flags alone do not make a launch', () => {
    expect(parseArgs(['--mode', 'headless'], { env: {}, games: ['atlas'], defaults }).help).toBe(true)
  })

  test('the supervisor still launches with no positional', () => {
    const args = parseArgs(['--supervised', '/tmp/x'], { env: {}, games: ['atlas'], defaults })
    expect(args.subcommand).toBe('run')
    expect(args.game).toBe('atlas')
  })

  test('CLI values replace file defaults', () => {
    const args = parseArgs(
      [
        'run', 'qol', '--game', 'beacon', '--mode', 'headed', '--no-build', '--no-replace',
        '--resolution', '1920x1080', '--log=cli.log', '--mod', 'Cli.Mod',
        '--worktree', '/worktrees/fix', '--', '-debug',
      ],
      { env: {}, games: ['atlas', 'beacon'], defaults },
    )
    expect(args.game).toBe('beacon')
    expect(args.profile).toBe('qol')
    expect(args.mode).toBe('headed')
    expect(args.build).toBe('never')
    expect(args.replace).toBe(false)
    expect(args.resolution).toEqual({ width: 1920, height: 1080 })
    expect(args.log).toBe('cli.log')
    expect(args.mods).toEqual(['Cli.Mod'])
    expect(args.worktree).toEqual(['/worktrees/fix'])
    expect(args.noWorktree).toBe(false)
    expect(args.gameArgs).toEqual(['-debug'])
  })

  test('environment values replace file defaults', () => {
    const args = parseArgs([], {
      env: { GAMECRATE_MODE: 'screenshot', GAMECRATE_BUILD: 'auto' },
      games: ['atlas'],
      defaults,
    })
    expect(args.mode).toBe('screenshot')
    expect(args.build).toBe('auto')
  })

  test('resolution rejects zero and malformed dimensions', () => {
    expect(fails(['run', 'atlas', '--resolution', '0x1080']).message).toContain('positive dimensions')
    expect(fails(['run', 'atlas', '--resolution', 'wide']).message).toContain('positive dimensions')
  })
})

describe('suggest', () => {
  test('finds a near match and gives up on a far one', () => {
    expect(suggest('lst', ['list', 'logs'])).toBe('list')
    expect(suggest('zzzzzz', ['list', 'logs'])).toBeUndefined()
  })
})

function game(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    gameFiles: { source: 'mount', host: '/fixtures/games/Beacon', container: '/opt/beacon' },
    dataDir: { container: '/data', mode: 'env', env: { XDG_DATA_HOME: '/data' } },
    modsDir: { container: '/opt/beacon/Mods' },
    logFile: { mode: 'copy-out', from: 'Logs' },
    image: { ref: 'beacon:play' },
    executable: './Beacon',
    steamAppId: 294100,
    workshopRoot: null,
    scanRoots: [],
    manifest: { file: 'About/About.txt' },
    modsConfig: { file: 'Config/ModsConfig.txt' },
    prefs: { file: 'Prefs.txt' },
    version: FIXTURE_VERSION,
    steamBuild: FIXTURE_STEAM_BUILD,
    saveExtensions: ['sav'],
    core: 'beaconco.beacon',
    dlc: [],
    modes: ['headed', 'headless'],
    library: {
      'Bridge.Lantern': { path: '/fixtures/mods/lantern' },
      'Kitted.Core': { path: '/fixtures/mods/kitted' },
    } as GameConfig['library'],
    profiles: {
      kitted: { mods: ['Bridge.Lantern', 'Kitted.Core'] },
      vanilla: { alias: 'modless' },
    },
    ...overrides,
  }
}

const config: RootConfig = { dataRoot: '~/.local/share/gamecrate', games: { beacon: game() } }

describe('NAME_PATTERN', () => {
  test('letters, digits, dot, dash and underscore are the set', () => {
    for (const name of ['v16', 'dev', 'dev-wt', 'dev_wt', 'a', '2024', 'Mixed-Case_9', '1.6', 'a.b']) {
      expect(NAME_PATTERN.test(name)).toBe(true)
    }
  })

  test('anything that could redirect a path is refused', () => {
    for (const name of ['', '.', '..', '../x', './x', 'a/b', 'a\\b', '-lead', '_lead', ' x', 'x ']) {
      expect(NAME_PATTERN.test(name)).toBe(false)
    }
  })
})

describe('help', () => {
  test('top level lists every verb in a group, the global flags and the games', () => {
    const text = renderHelp([], config)
    expect(text).toContain('gamecrate run <profile> [flags] [-- game args]')
    expect(text).toContain('gamecrate <subcommand> [args] [flags]')
    expect(text).toContain('--game <name>')
    for (const sub of SUBCOMMANDS) expect(text).toContain(sub.name)
    for (const group of VERB_GROUPS) expect(text).toContain(`${group.title}:`)
    expect(text).toContain('--json')
    expect(text).toContain('beacon')
  })

  test('top level does not dump a verb-scoped flag', () => {
    const text = renderHelp([], config)
    expect(text).not.toContain('--docker-arg')
    expect(text).not.toContain('--render-wait')
    expect(text).not.toContain('--workshop')
  })

  test('a namespace verb lists its subverbs, and each one gets its own page', () => {
    const text = renderHelp(['mods'], config)
    for (const verb of ['add', 'rm', 'sync']) expect(text).toContain(verb)

    const add = renderHelp(['mods', 'add'], config)
    expect(add).toContain('usage: gamecrate mods add <source>')
    expect(add).toContain('--workshop')

    const rm = renderHelp(['mods', 'rm'], config)
    expect(rm).toContain('usage: gamecrate mods rm <id>...')
    expect(rm).not.toContain('--workshop')
  })

  test('a subverb page lists only the flags that subverb accepts', () => {
    for (const verb of ['add', 'rm', 'sync']) {
      const text = renderHelp(['mods', verb], config)
      for (const flag of ['--ci', '--mod ', '--without', '--only', '--sort']) {
        expect(text).not.toContain(flag)
      }
      expect(text).toContain('--game')
    }
  })

  test('an unknown subverb topic names the ones that exist', () => {
    try {
      renderHelp(['steam', 'frobnify'], config)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).code).toBe(Exit.Usage)
      expect((error as GamecrateError).detail).toContain('build')
      expect((error as GamecrateError).detail).toContain('login')
    }
  })

  test('per-subcommand help shows only that subcommand', () => {
    const text = renderHelp(['clean'], config)
    expect(text).toContain('usage: gamecrate clean [profile]')
    expect(text).toContain('--yes')
    expect(text).not.toContain('--render-wait')
  })

  test('per-game help lists profiles and modes', () => {
    const text = renderHelp(['beacon'], config)
    expect(text).toContain('kitted')
    expect(text).toContain('alias for modless')
    expect(text).toContain('modes: headed, headless')
  })

  test('an unknown topic is a usage error with a suggestion', () => {
    try {
      renderHelp(['beacn'], config)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).code).toBe(Exit.Usage)
      expect((error as GamecrateError).detail).toBe('did you mean beacon?')
    }
  })

  test('help is derived from the parser, so every public flag reaches some page', () => {
    const pages = [renderHelp([], config), renderHelp(['run'], config)]
    for (const sub of SUBCOMMANDS) {
      pages.push(renderHelp([sub.name], config))
      for (const verb of Object.keys(sub.subverbs ?? {})) pages.push(renderHelp([sub.name, verb], config))
    }
    const all = pages.join('\n')

    const options = allOptions(buildProgram()).filter((o) => !o.hidden)
    expect(allOptions(buildProgram()).filter((o) => o.hidden)).toHaveLength(1)
    for (const option of options) expect(all).toContain(option.flags)
  })

  test('the script asks the binary and names no verb of its own', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      const text = renderCompletion(shell)
      expect(text).toContain('gamecrate __complete')
      expect(text).toContain('_gamecrate()')
      expect(text).not.toContain('docker_game')
      expect(text).not.toContain('docker-game')
      expect(text).not.toContain('fix-perms')
    }
    expect(renderCompletion('bash')).toContain('complete -o nosort -F _gamecrate gamecrate')
    expect(renderCompletion('zsh')).toContain('#compdef gamecrate')
  })

  test('every subcommand is a candidate at the first word', () => {
    const values = complete([''], config).map((c) => c.value)
    for (const sub of SUBCOMMANDS) expect(values).toContain(sub.name)
    expect(values).toContain('beacon')
    expect(values).not.toContain('__complete')
  })

  test('a prefix narrows the first word', () => {
    expect(complete(['fi'], config).map((c) => c.value)).toEqual(['fix-perms'])
  })

  test('a namespace completes its subverbs, and each subverb its own flags', () => {
    expect(complete(['mods', ''], config).map((c) => c.value)).toEqual(
      expect.arrayContaining(['add', 'rm', 'sync']),
    )
    const addFlags = complete(['mods', 'add', 'beacon', 'x', '--'], config).map((c) => c.value)
    expect(addFlags).toContain('--workshop')
    const rmFlags = complete(['mods', 'rm', 'beacon', '--'], config).map((c) => c.value)
    expect(rmFlags).not.toContain('--workshop')
  })

  test('a profile slot completes profiles, since no slot holds a game any more', () => {
    const first = complete(['clean', ''], config).map((c) => c.value)
    expect(first).toContain('kitted')
    expect(first).toContain('modless')
    expect(first).not.toContain('beacon')
  })

  test('a game typed first completes its profiles, not the verb list', () => {
    const values = complete(['beacon', ''], config).map((c) => c.value)
    expect(values).toContain('kitted')
    expect(values).not.toContain('doctor')
  })

  test('a repeatable slot keeps completing, minus what is already typed', () => {
    const first = complete(['mods', 'rm', 'beacon', ''], config).map((c) => c.value)
    expect(first.length).toBeGreaterThan(0)

    const second = complete(['mods', 'rm', 'beacon', first[0]!, ''], config).map((c) => c.value)
    expect(second.length).toBeGreaterThan(0)
    expect(second).not.toContain(first[0])
  })

  test('an enum flag completes its choices', () => {
    expect(complete(['run', 'beacon', '--mode', ''], config).map((c) => c.value)).toEqual([
      'headed',
      'headless',
      'screenshot',
    ])
  })

  test('--supervised is never a candidate', () => {
    expect(complete(['run', 'beacon', '--'], config).map((c) => c.value)).not.toContain('--supervised')
  })
})

describe('run names the game its profile belongs to', () => {
  const one = { games: ['beacon'], profiles: profileNames(config) }
  const twoGames: RootConfig = {
    dataRoot: '~/.local/share/gamecrate',
    games: {
      beacon: game({ profiles: { kitted: { mods: [] }, dev: { mods: [] } } }),
      atlas: game({ profiles: { dev: { mods: [] }, solo: { mods: [] } } }),
    },
  }
  const two = { games: ['beacon', 'atlas'], profiles: profileNames(twoGames) }

  function refuses(argv: string[], opts: Record<string, unknown>): GamecrateError {
    try {
      parseArgs(argv, { env: {}, ...opts })
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      return error as GamecrateError
    }
    throw new Error(`expected ${argv.join(' ')} to fail`)
  }

  test('a profile alone is refused and points at run', () => {
    const error = refuses(['kitted'], one)
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toBe('kitted is a profile, not a subcommand')
    expect(error.detail).toBe('run it with: gamecrate run kitted')
  })

  test('naming the game is a refusal that lists its profiles', () => {
    const error = refuses(['beacon', 'kitted'], one)
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toBe('beacon is a game, not a subcommand')
    expect(error.detail).toBe('run one of its profiles: kitted, vanilla')
  })

  test('a game with no profiles yet says how to declare one', () => {
    const error = refuses(['beacon'], { games: ['beacon'], profiles: { beacon: [] } })
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toBe('beacon is a game, not a subcommand')
    expect(error.detail).toBe('it declares no profiles yet. add one under games.beacon.profiles')
  })

  test('run takes a profile and names its game', () => {
    const args = parseArgs(['run', 'kitted'], { env: {}, ...one })
    expect(args.game).toBe('beacon')
    expect(args.profile).toBe('kitted')
  })

  test('a profile alias names the game as well', () => {
    const aliased: RootConfig = {
      dataRoot: '~/x',
      games: { beacon: game({ profiles: { kitted: { mods: [], aliases: ['kit'] } } }) },
    }
    const args = parseArgs(['run', 'kit'], { env: {}, games: ['beacon'], profiles: profileNames(aliased) })
    expect(args.game).toBe('beacon')
    expect(args.profile).toBe('kit')
  })

  test('every verb with a profile slot takes a bare profile', () => {
    const verbs = SUBCOMMANDS.filter((s) => s.positionals.includes('profile')).map((s) => s.name)
    expect(verbs.length).toBeGreaterThan(8)
    for (const verb of verbs) {
      const args = parseArgs([verb, 'kitted'], { env: {}, ...one })
      expect([verb, args.game, args.profile]).toEqual([verb, 'beacon', 'kitted'])
    }
  })

  test('clone infers the game and keeps both names in rest', () => {
    const args = parseArgs(['clone', 'kitted', 'kitted-2'], { env: {}, ...one })
    expect(args.game).toBe('beacon')
    expect(args.rest).toEqual(['kitted', 'kitted-2'])
  })

  test('a profile that shares its game name is read as the profile', () => {
    const shared = { games: ['beacon'], profiles: { beacon: ['beacon', 'kitted'] } }
    const args = parseArgs(['run', 'beacon'], { env: {}, ...shared })
    expect(args.game).toBe('beacon')
    expect(args.profile).toBe('beacon')
  })

  test('a subverb takes no positional, so a profile name is rejected', () => {
    const error = refuses(['mods', 'add', 'kitted', '--path', '/x', '--global'], one)
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toBe('unexpected argument kitted')
    expect(error.detail).toBe('did you mean gamecrate mods add <source>?')
  })

  test('two games declaring one profile is a refusal that names both', () => {
    const error = refuses(['run', 'dev'], two)
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('beacon')
    expect(error.message).toContain('atlas')
    expect(error.detail).toContain('--game beacon')
    expect(error.detail).toContain('--game atlas')
  })

  test('a project config that names a game settles the tie', () => {
    const args = parseArgs(['run', 'dev'], { env: {}, ...two, defaults: { game: 'atlas' } })
    expect(args.game).toBe('atlas')
    expect(args.profile).toBe('dev')
  })

  test('a project game that declares no such profile does not settle it', () => {
    const error = refuses(['run', 'dev'], { ...two, defaults: { game: 'zephyr' } })
    expect(error.code).toBe(Exit.Usage)
  })

  test('an unknown first word is not a subcommand, and profiles are not candidates', () => {
    const error = refuses(['kitted2'], one)
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toBe('kitted2 is not a subcommand')
    expect(error.detail).toBeUndefined()
  })

  test('a profile plus a second word is still an unexpected argument', () => {
    expect(refuses(['verify', 'kitted', 'vanilla'], one).message).toContain('unexpected argument vanilla')
  })

  test('run takes one profile and nothing after it', () => {
    const typed = refuses(['run', 'kitted', 'vanilla'], one)
    expect(typed.code).toBe(Exit.Usage)
    expect(typed.message).toBe('unexpected argument vanilla')
    expect(typed.detail).toBe('did you mean gamecrate run [profile]?')
  })

  test('a word after -- is a game arg, not a trailing positional', () => {
    const args = parseArgs(['run', 'kitted', '--', '-popupwindow', '-a', '-b'], { env: {}, ...one })
    expect(args.profile).toBe('kitted')
    expect(args.rest).toEqual([])
    expect(args.gameArgs).toEqual(['-popupwindow', '-a', '-b'])
  })
})

describe('profile-aware help and completion', () => {
  const twoGames: RootConfig = {
    dataRoot: '~/.local/share/gamecrate',
    games: {
      beacon: game({ profiles: { kitted: { mods: [] }, dev: { mods: [] } } }),
      atlas: game({ profiles: { dev: { mods: [] }, solo: { mods: [] } } }),
    },
  }

  test('help for a profile prints its game page', () => {
    expect(renderHelp(['solo'], twoGames)).toContain('Profiles for atlas:')
  })

  test('help for a profile two games declare names both', () => {
    try {
      renderHelp(['dev'], twoGames)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).message).toContain('beacon')
      expect((error as GamecrateError).message).toContain('atlas')
    }
  })

  test('a bare profile completes at the first word', () => {
    const values = complete([''], config).map((c) => c.value)
    expect(values).toContain('kitted')
    expect(values).toContain('vanilla')
  })

  test('a profile typed first fills the profile slot, so only flags are left', () => {
    const values = complete(['kitted', ''], config).map((c) => c.value)
    expect(values).not.toContain('kitted')
    expect(values).not.toContain('doctor')
    expect(complete(['kitted', '--'], config).map((c) => c.value)).toContain('--dry-run')
  })
})

describe('reportProblems', () => {
  const problems: Problem[] = [
    { where: '/games/beacon/profiles/kitted/mods/0', message: 'unknown mod Bridge.Wayltih', suggestion: 'Bridge.Lantern' },
    { where: '/games/beacon/profiles/kitted/mods/1', message: 'missing dependency Kitted.Core' },
    { where: '/games/beacon/profiles/kitted/mods/2', message: 'two mods declare Kitted.Core' },
    { where: '/games/beacon/profiles/kitted/mods/3', message: 'no configured steamAppId' },
  ]

  function thrown(body: () => never): GamecrateError {
    try {
      body()
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      return error as GamecrateError
    }
    throw new Error('expected a GamecrateError')
  }

  test('every problem is carried on the error, not just the first', () => {
    const error = thrown(() => reportProblems(problems))
    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toBe('4 problems')
    for (const problem of problems) expect(error.detail).toContain(problem.message)
    expect(error.detail).toContain('did you mean Bridge.Lantern?')
  })

  test('problems sharing a location are grouped under one heading', () => {
    const error = thrown(() =>
      reportProblems([
        { where: 'profiles.json#/games/beacon', message: 'first' },
        { where: 'profiles.json#/games/beacon', message: 'second' },
      ]),
    )
    expect(error.detail?.match(/profiles\.json#\/games\/beacon/g)?.length).toBe(1)
    expect(error.detail).toContain('first')
    expect(error.detail).toContain('second')
  })

  test('an empty list still throws rather than exiting', () => {
    const error = thrown(() => reportProblems([]))
    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toContain('no reported detail')
  })

  test('nothing in the module calls process.exit', () => {
    const source = readFileSync(new URL('../src/cli/output.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('process.exit')
  })
})

const settings: Settings = {
  width: 1920,
  height: 1080,
  devMode: true,
  runInBackground: true,
  resetModsConfigOnCrash: false,
  gpu: true,
  audio: true,
  input: true,
  network: 'none',
  display: 'wayland',
  memory: '8g',
  cpus: 4,
  pidsLimit: 512,
}

const plan: LaunchPlan = {
  game: 'beacon',
  gameConfig: game(),
  plugin: fixturePlugin(),
  profile: 'kitted',
  instanceDir: '/fixtures/data/beacon/kitted',
  steam: false,
  warnOnStale: true,
  settings,
  mods: [
    {
      packageId: 'Lib.Bridge.Lantern',
      hostDir: '/workspace/Bridge/Lantern/Bridge.Lantern',
      containerDir: '/opt/beacon/Mods/lib.bridge.lantern',
      kind: 'local',
      explicit: true,
      stale: true,
    },
    {
      packageId: 'Kitted.Core',
      hostDir: '/workspace/AtlasKitted/KittedCore',
      containerDir: '/opt/beacon/Mods/kitted.core',
      kind: 'workshop',
      workshopId: 2038874626,
      explicit: false,
    },
  ],
  profileDir: '/fixtures/data/beacon/kitted',
  dataDirHost: '/fixtures/data/beacon/kitted/game',
  configDirHost: '/fixtures/data/beacon/kitted/config',
  stageDirHost: '/fixtures/data/beacon/kitted/.stage',
  logsDirHost: '/fixtures/data/beacon/kitted/logs',
  runDirHost: '/fixtures/data/beacon/kitted/logs',
  mode: 'headed',
  timeoutSeconds: 300,
  renderWaitSeconds: 8,
  warnings: ['Lib.Bridge.Lantern has sources newer than its assembly'],
}

describe('printPlan payload', () => {
  test('carries kind, host path, container path, origin and staleness per mod', () => {
    const payload = planPayload(plan)
    expect(payload.mods[0]).toEqual({
      packageId: 'Lib.Bridge.Lantern',
      kind: 'local',
      hostDir: '/workspace/Bridge/Lantern/Bridge.Lantern',
      containerDir: '/opt/beacon/Mods/lib.bridge.lantern',
      origin: 'explicit',
      stale: true,
    })
    expect(payload.mods[1]?.origin).toBe('auto')
    expect(payload.mods[1]?.stale).toBe(false)
    expect(payload.mods[1]?.workshopId).toBe(2038874626)
  })

  test('replaces the symlink-target assertion with a resolvable host path', () => {
    const payload = planPayload(plan)
    const mod = payload.mods.find((m) => m.packageId === 'Lib.Bridge.Lantern')
    expect(mod?.hostDir.startsWith('/')).toBe(true)
    expect(JSON.parse(JSON.stringify(payload)).mods).toHaveLength(2)
  })
})

describe('run logs', () => {
  test('a redirected log combines stdout and stderr without mirroring them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gamecrate-output-')), 'combined.log')
    const redirect = captureOutput(file)
    try {
      emit('game', 'game output\n')
      emit('status', 'tool status\n')
    } finally {
      redirect.close()
    }
    expect(readFileSync(file, 'utf8')).toBe('game output\ntool status\n')
  })

  test('tee writes to the file and the sink under it, and quiet-style capture writes neither', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-output-'))
    const file = join(dir, 'teed.log')
    const seen: string[] = []
    const probe = useSink({
      write(_channel, chunk) {
        seen.push(String(chunk))
      },
      close() {},
    })
    try {
      const teed = captureOutput(file, { tee: true })
      emit('game', 'both places\n')
      teed.close()

      const silent = captureOutput(undefined)
      emit('game', 'nowhere\n')
      silent.close()
    } finally {
      probe.close()
    }
    expect(readFileSync(file, 'utf8')).toBe('both places\n')
    expect(seen).toEqual(['both places\n'])
  })

  test('every channel reaches the sink under its own name', () => {
    const seen: [string, string][] = []
    const probe = useSink({
      write(channel, chunk) {
        seen.push([channel, String(chunk)])
      },
      close() {},
    })
    try {
      status('working')
      warn('careful')
      emit('game', 'from the game\n')
      emit('gameError', 'from the game, badly\n')
      emit('data', '{}\n')
    } finally {
      probe.close()
    }
    expect(seen).toEqual([
      ['status', 'working\n'],
      ['status', 'warning: careful\n'],
      ['game', 'from the game\n'],
      ['gameError', 'from the game, badly\n'],
      ['data', '{}\n'],
    ])
  })

  test('a base swapped after a capture still writes through that capture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-output-'))
    const file = join(dir, 'layered.log')
    const pane: string[] = []

    const capture = captureOutput(file, { tee: true })
    const dashboard = useBaseSink({
      write(_channel, chunk) {
        pane.push(String(chunk))
      },
      close() {},
    })
    try {
      emit('game', 'one line\n')
    } finally {
      dashboard.close()
      capture.close()
    }
    expect(readFileSync(file, 'utf8')).toBe('one line\n')
    expect(pane).toEqual(['one line\n'])
  })

  test('closing the base puts the terminal back under the capture', () => {
    const pane: string[] = []
    const dashboard = useBaseSink({ write: (_c, chunk) => pane.push(String(chunk)), close() {} })
    emit('game', 'to the pane\n')
    dashboard.close()
    expect(pane).toEqual(['to the pane\n'])
  })

  test('a sink is restored when the one over it closes', () => {
    const outer: string[] = []
    const a = useSink({ write: (_c, chunk) => outer.push(String(chunk)), close() {} })
    const inner: string[] = []
    const b = useSink({ write: (_c, chunk) => inner.push(String(chunk)), close() {} })
    emit('data', 'inner\n')
    b.close()
    emit('data', 'outer\n')
    a.close()
    expect(inner).toEqual(['inner\n'])
    expect(outer).toEqual(['outer\n'])
  })

  test('quiet drops the game channels and keeps status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-output-'))
    const file = join(dir, 'quiet.log')
    const seen: [string, string][] = []
    const probe = useBaseSink({ write: (channel, chunk) => seen.push([channel, String(chunk)]), close() {} })
    try {
      const capture = captureOutput(file, { tee: false, always: ['status'] })
      emit('game', 'chatter\n')
      emit('gameError', 'more chatter\n')
      emit('status', 'this is why it died\n')
      capture.close()
    } finally {
      probe.close()
    }
    expect(seen).toEqual([['status', 'this is why it died\n']])
    expect(readFileSync(file, 'utf8')).toBe('chatter\nmore chatter\nthis is why it died\n')
  })

  test('a log path creates its parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-output-'))
    const file = join(dir, 'nested', 'deeper', 'run.log')
    const capture = captureOutput(file)
    try {
      emit('data', 'made it\n')
    } finally {
      capture.close()
    }
    expect(readFileSync(file, 'utf8')).toBe('made it\n')
  })

  test('a redirected log captures forwarded child output', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gamecrate-output-')), 'combined.log')
    const redirect = captureOutput(file)
    try {
      const proc = spawnArgv(['sh', '-c', 'printf child-out; printf child-err >&2'], [
        'ignore',
        'pipe',
        'pipe',
      ])
      const code = exited(proc)
      await Promise.all([
        forwardOutput(proc.stdout!, 'game'),
        forwardOutput(proc.stderr!, 'gameError'),
      ])
      expect(await code).toBe(0)
    } finally {
      redirect.close()
    }
    const logged = readFileSync(file, 'utf8')
    expect(logged).toContain('child-out')
    expect(logged).toContain('child-err')
  })

  test('timestamps sort chronologically and hold no path-hostile characters', () => {
    const early = runTimestamp(new Date('2026-07-30T14:23:35.123Z'))
    const late = runTimestamp(new Date('2026-07-30T14:23:35.124Z'))
    expect(early).toBe('20260730T142335123Z')
    expect(early < late).toBe(true)
    expect(/^[A-Za-z0-9]+$/.test(early)).toBe(true)
  })

  test('a run directory is named for the stamp and `current` points at it', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'gamecrate-logs-'))
    const dir = openRunLog(logsDir, new Date('2026-07-30T14:23:35.123Z'))
    expect(dir).toBe(join(logsDir, 'runs', '20260730T142335123Z'))
    expect(readdirSync(join(logsDir, 'runs'))).toEqual(['20260730T142335123Z'])
    expect(readlinkSync(join(logsDir, 'current'))).toBe(join('runs', '20260730T142335123Z'))
  })

  test('a second run in the same millisecond gets its own directory', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'gamecrate-logs-'))
    const now = new Date('2026-07-30T14:23:35.123Z')
    expect(openRunLog(logsDir, now)).toBe(join(logsDir, 'runs', '20260730T142335123Z'))
    expect(openRunLog(logsDir, now)).toBe(join(logsDir, 'runs', '20260730T142335123Z-2'))
  })

  test('rotation caps retained runs at the newest N', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'gamecrate-rot-'))
    for (let i = 1; i <= 5; i++) {
      const dir = join(logsDir, 'runs', `2026073${i}T000000000Z`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'stdout.log'), 'x'.repeat(1000))
    }
    const removed = rotateRuns(logsDir, 2)
    expect(removed.sort()).toEqual([
      '20260731T000000000Z',
      '20260732T000000000Z',
      '20260733T000000000Z',
    ])
    expect(readdirSync(join(logsDir, 'runs')).sort()).toEqual([
      '20260734T000000000Z',
      '20260735T000000000Z',
    ])
  })
})

describe('supervisorArgv', () => {
  const NODE = ['/usr/bin/node', '/opt/gamecrate/dist/gamecrate.js']
  const BUN = ['bun', '/$bunfs/root/gamecrate']
  const DIR = '/data/rimworld/dev'

  test('under node the script path is passed back', () => {
    expect(supervisorArgv(['rimworld', 'dev', '--detach'], DIR, NODE, '/usr/bin/node')).toEqual([
      '/usr/bin/node',
      '/opt/gamecrate/dist/gamecrate.js',
      'rimworld',
      'dev',
      '--supervised',
      DIR,
    ])
  })

  test('under the compiled binary only execPath is passed', () => {
    expect(supervisorArgv(['rimworld', 'dev', '--detach'], DIR, BUN, '/usr/local/bin/gamecrate')).toEqual([
      '/usr/local/bin/gamecrate',
      'rimworld',
      'dev',
      '--supervised',
      DIR,
    ])
  })

  test('a --detach after a bare -- is a game argument, not our flag', () => {
    expect(supervisorArgv(['rimworld', '--detach', '--', '--detach'], DIR, NODE, '/usr/bin/node')).toEqual([
      '/usr/bin/node',
      '/opt/gamecrate/dist/gamecrate.js',
      'rimworld',
      '--supervised',
      DIR,
      '--',
      '--detach',
    ])
  })

  test('argv with no --detach still gets --supervised', () => {
    expect(supervisorArgv(['rimworld'], DIR, NODE, '/usr/bin/node').slice(2)).toEqual([
      'rimworld',
      '--supervised',
      DIR,
    ])
  })

  test('supervisedDir reads the child argv back, and ignores game args', () => {
    expect(supervisedDir(supervisorArgv(['rimworld'], DIR, NODE, '/usr/bin/node'))).toBe(DIR)
    expect(supervisedDir(['rimworld'])).toBeUndefined()
    expect(supervisedDir(['rimworld', '--', '--supervised', '/evil'])).toBeUndefined()
  })
})

describe('--detach', () => {
  test('detach and supervised are separate booleans', () => {
    expect(parseArgs(['run', 'rimworld', '--detach'], { env: {}, games: ['rimworld'] }).detach).toBe(true)
    expect(parseArgs(['run', 'rimworld', '--supervised', '/tmp/x'], { env: {}, games: ['rimworld'] }).supervised).toBe(true)
    expect(parseArgs(['run', 'rimworld'], { env: {}, games: ['rimworld'] }).supervised).toBe(false)
    expect(parseArgs(['run', 'rimworld'], { env: {}, games: ['rimworld'] }).detach).toBe(false)
  })

  test('--detach and --no-detach contradict', () => {
    expect(fails(['run', 'rimworld', '--detach', '--no-detach'], { games: ['rimworld'] }).code).toBe(Exit.Usage)
  })

  test('a project detach: true fills args.detach', () => {
    const args = parseArgs(['run', 'rimworld'], { env: {}, games: ['rimworld'], defaults: { detach: true } })
    expect(args.detach).toBe(true)
  })

  test('any layer turns a boolean on, only --no-* turns it off', () => {
    const bare = parseArgs(['run', 'rimworld'], { env: {}, games: ['rimworld'] })
    const onFlag = parseArgs(['run', 'rimworld', '--detach', '--replace'], { env: {}, games: ['rimworld'] })
    const offFlag = parseArgs(['run', 'rimworld', '--no-detach', '--no-replace'], { env: {}, games: ['rimworld'] })

    expect(wantsDetach(bare, {})).toBe(false)
    expect(wantsDetach(bare, { detach: true })).toBe(true)
    expect(wantsDetach(onFlag, {})).toBe(true)
    expect(wantsDetach(offFlag, { detach: true })).toBe(false)

    expect(wantsReplace(bare, { replace: true })).toBe(true)
    expect(wantsReplace(onFlag, {})).toBe(true)
    expect(wantsReplace(offFlag, { replace: true })).toBe(false)
  })

  test('steam is off until a flag or a config asks, and --no-steam always refuses', () => {
    const bare = parseArgs(['run', 'rimworld'], { env: {}, games: ['rimworld'] })
    const onFlag = parseArgs(['run', 'rimworld', '--steam'], { env: {}, games: ['rimworld'] })
    const offFlag = parseArgs(['run', 'rimworld', '--no-steam'], { env: {}, games: ['rimworld'] })

    expect(wantsSteam(bare, {})).toBe(false)
    expect(wantsSteam(bare, { steam: true })).toBe(true)
    expect(wantsSteam(onFlag, {})).toBe(true)
    expect(wantsSteam(offFlag, { steam: true })).toBe(false)
  })

  test('a project steam: true fills args.steam', () => {
    const args = parseArgs(['run', 'rimworld'], { env: {}, games: ['rimworld'], defaults: { steam: true } })
    expect(args.steam).toBe(true)
    expect(wantsSteam(args, {})).toBe(true)
  })

  test('--no-steam beats a project steam: true', () => {
    const args = parseArgs(['run', 'rimworld', '--no-steam'], {
      env: {},
      games: ['rimworld'],
      defaults: { steam: true },
    })
    expect(wantsSteam(args, {})).toBe(false)
  })

  test('build is first defined wins, and --no-build still means never', () => {
    const bare = parseArgs(['run', 'rimworld'], { env: {}, games: ['rimworld'] })
    const noBuild = parseArgs(['run', 'rimworld', '--no-build'], { env: {}, games: ['rimworld'] })
    const always = parseArgs(['run', 'rimworld', '--build'], { env: {}, games: ['rimworld'] })

    expect(buildPolicy(bare, {})).toBe('auto')
    expect(buildPolicy(bare, { build: 'always' })).toBe('always')
    expect(buildPolicy(always, { build: 'never' })).toBe('always')
    expect(buildPolicy(noBuild, { build: 'always' })).toBe('never')
  })

  test('--ci ignores a config build policy, and only a typed --build overrides it', () => {
    const run = (argv: string[], defaults: ProjectDefaults = {}) =>
      parseArgs(['run', 'rimworld', ...argv], { env: {}, games: ['rimworld'], defaults })

    expect(buildPolicy(run(['--ci'], { build: 'always' }), {})).toBe('never')
    expect(buildPolicy(run(['--ci']), { build: 'always' })).toBe('never')
    expect(buildPolicy(run(['--ci', '--build']), {})).toBe('always')
    expect(buildPolicy(run([], { build: 'always' }), {})).toBe('always')
  })

  test('--supervised is hidden from help and completion', () => {
    expect(renderHelp([], { dataRoot: '/tmp', games: {} } as RootConfig)).not.toContain('--supervised')
    expect(renderCompletion('bash')).not.toContain('--supervised')
    expect(renderCompletion('zsh')).not.toContain('--supervised')
    expect(renderHelp(['run'])).not.toContain('--supervised')
  })

  test('shell, dry-run and print-plan refuse to detach', () => {
    expect(fails(['shell', 'rimworld', '--detach'], { games: ['rimworld'] }).code).toBe(Exit.Usage)
    expect(fails(['run', 'rimworld', '--detach', '--dry-run'], { games: ['rimworld'] }).code).toBe(Exit.Usage)
    expect(fails(['run', 'rimworld', '--detach', '--print-plan'], { games: ['rimworld'] }).code).toBe(Exit.Usage)
  })

  test('the supervisor never forks again, whatever the profile asks for', () => {
    const child = parseArgs(['run', 'rimworld', '--supervised', '/tmp/x'], { env: {}, games: ['rimworld'] })
    expect(wantsDetach(child, { detach: true })).toBe(false)
    expect(wantsReplace(child, { replace: true })).toBe(false)
  })

  test('a profile detach never reaches the shell refusal', () => {
    const args = parseArgs(['shell', 'rimworld'], { env: {}, games: ['rimworld'] })
    expect(wantsDetach(args, { detach: true })).toBe(true)
  })

  test('there is no env fallback for detach', () => {
    const args = parseArgs(['run', 'rimworld'], { env: { GAMECRATE_DETACH: '1' }, games: ['rimworld'] })
    expect(args.detach).toBe(false)
  })
})

describe('detach defaults from a project config', () => {
  const project = { detach: true } as ProjectDefaults

  test('a project detach never refuses shell, only a typed flag does', () => {
    const args = parseArgs(['shell', 'rimworld'], { env: {}, games: ['rimworld'], defaults: project })
    expect(args.detach).toBe(true)
    expect(args.subcommand).toBe('shell')
  })

  test('the shell refusal reads as one sentence', () => {
    const error = fails(['shell', 'rimworld', '--detach'], { games: ['rimworld'] })
    expect(error.message).toBe('shell cannot detach: a shell needs the terminal --detach gives up')
    expect(error.detail).toBeUndefined()
  })
})

describe('follow and the detached verbs', () => {
  test('-f and --follow are the same flag', () => {
    expect(parseArgs(['logs', 'rimworld', '-f'], { env: {}, games: ['rimworld'] }).follow).toBe(true)
    expect(parseArgs(['logs', 'rimworld', '--follow'], { env: {}, games: ['rimworld'] }).follow).toBe(true)
    expect(parseArgs(['logs', 'rimworld'], { env: {}, games: ['rimworld'] }).follow).toBe(false)
  })

  test('attach and wait take an optional profile, and it names the game', () => {
    const attach = parseArgs(['attach', 'dev'], {
      env: {},
      games: ['rimworld'],
      profiles: { rimworld: ['dev'] },
    })
    expect(attach.subcommand).toBe('attach')
    expect(attach.game).toBe('rimworld')
    expect(attach.profile).toBe('dev')

    const wait = parseArgs(['wait'], { env: {}, games: ['rimworld'] })
    expect(wait.subcommand).toBe('wait')
    expect(wait.game).toBe('rimworld')
    expect(wait.profile).toBeUndefined()
  })

  test('logs advertises --follow, and attach and wait do not', () => {
    const flagsOf = (name: string) => SUBCOMMANDS.find((s) => s.name === name)!.flags
    expect(flagsOf('logs')).toContain('--follow')
    expect(flagsOf('attach')).not.toContain('--follow')
    expect(flagsOf('wait')).not.toContain('--follow')
    expect(renderHelp(['logs'])).toContain('--follow')
  })
})

describe('mods subverbs', () => {
  test('the read verb takes a profile, and the profile names the game', () => {
    const args = parseArgs(['mods', 'cosmere'], {
      env: {},
      games: ['rimworld'],
      profiles: { rimworld: ['cosmere'] },
    })
    expect(args.subcommand).toBe('mods')
    expect(args.subverb).toBeUndefined()
    expect(args.game).toBe('rimworld')
    expect(args.profile).toBe('cosmere')
  })

  test('add takes a path source and a target', () => {
    const args = parseArgs(['mods', 'add', '--game', 'rimworld', '--path', '/a/b', '--global'], NO_ENV)
    expect(args.subverb).toBe('add')
    expect(args.game).toBe('rimworld')
    expect(args.source).toEqual({ kind: 'path', value: '/a/b' })
    expect(args.target).toBe('global')
  })

  test('a workshop id is a number', () => {
    const args = parseArgs(['mods', 'add', '--game', 'rimworld', '--workshop', '2009463077', '--global'], NO_ENV)
    expect(args.source).toEqual({ kind: 'workshop', value: 2009463077 })
  })

  test('a git source carries its ref and subdir', () => {
    const args = parseArgs(
      ['mods', 'add', '--game', 'rimworld', '--git', 'https://x/y.git', '--tag', 'v1', '--subdir', 'Core', '--project'],
      NO_ENV,
    )
    expect(args.source).toEqual({
      kind: 'git',
      url: 'https://x/y.git',
      ref: { kind: 'tag', value: 'v1' },
      subdir: 'Core',
    })
    expect(args.target).toBe('project')
  })

  test('rm keeps every id in rest', () => {
    const args = parseArgs(['mods', 'rm', '--game', 'rimworld', 'A.B', 'C.D', '--global'], NO_ENV)
    expect(args.subverb).toBe('rm')
    expect(args.game).toBe('rimworld')
    expect(args.rest).toEqual(['A.B', 'C.D'])
  })

  test('sync takes no game at all', () => {
    const args = parseArgs(['mods', 'sync'], NO_ENV)
    expect(args.subverb).toBe('sync')
    expect(args.game).toBeUndefined()
    expect(args.target).toBeUndefined()
  })

  test('add needs exactly one source', () => {
    expect(fails(['mods', 'add', '--game', 'rimworld', '--global']).code).toBe(Exit.Usage)
    expect(fails(['mods', 'add', '--game', 'rimworld', '--global']).message).toContain('one of --path')
    const two = fails(['mods', 'add', '--game', 'rimworld', '--path', '/a', '--git', 'https://x/y.git', '--global'])
    expect(two.code).toBe(Exit.Usage)
    expect(two.message).toContain('a source has one kind')
  })

  test('a workshop id has to be a positive integer', () => {
    const text = fails(['mods', 'add', '--game', 'rimworld', '--workshop', 'abc', '--global'])
    expect(text.code).toBe(Exit.Usage)
    expect(text.message).toContain('positive workshop item id')
    const zero = fails(['mods', 'add', '--game', 'rimworld', '--workshop', '0', '--global'])
    expect(zero.message).toContain('positive workshop item id')
    expect(fails(['mods', 'add', '--game', 'rimworld', '--workshop', '-3', '--global']).message)
      .toContain('--workshop needs a value, got the flag -3')
  })

  test('add and rm leave the game unresolved when nothing says which', () => {
    const add = parseArgs(['mods', 'add', '--path', '/a', '--global'], NO_ENV)
    expect(add.subverb).toBe('add')
    expect(add.game).toBeUndefined()
    const rm = parseArgs(['mods', 'rm', 'A.B', '--global'], NO_ENV)
    expect(rm.subverb).toBe('rm')
    expect(rm.game).toBeUndefined()
  })

  test('requireGame refuses a subverb that could not tell which game', () => {
    const args = parseArgs(['mods', 'add', '--path', '/a', '--global'], NO_ENV)
    const only: RootConfig = {
      dataRoot: '~/x',
      games: { beacon: game({ profiles: { kitted: { mods: [] } } }) },
    }
    try {
      requireGame(args, only)
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).code).toBe(Exit.Usage)
      expect((error as GamecrateError).message).toBe('mods add could not tell which game you mean')
      return
    }
    throw new Error('expected requireGame to refuse')
  })

  test('rm needs at least one mod id', () => {
    const args = fails(['mods', 'rm', '--game', 'rimworld', '--global'])
    expect(args.code).toBe(Exit.Usage)
    expect(args.message).toBe('mods rm needs at least one mod id')
  })

  test.each([
    ['mods --help', ['mods', '--help']],
    ['mods add --help', ['mods', 'add', '--help']],
    ['mods add --game rimworld --help', ['mods', 'add', '--game', 'rimworld', '--help']],
    ['mods rm --game rimworld --global --help', ['mods', 'rm', '--game', 'rimworld', '--global', '--help']],
    ['mods sync --help', ['mods', 'sync', '--help']],
    ['mods add --game rimworld --git u --global --help', ['mods', 'add', '--game', 'rimworld', '--git', 'u', '--global', '--help']],
  ])('--help reaches the caller on %s', (_name, argv) => {
    expect(parseArgs(argv, NO_ENV).help).toBe(true)
  })

  test('--help is the only thing that skips the subverb checks', () => {
    expect(fails(['mods', 'add', '--game', 'rimworld', '--global']).message).toContain('--path, --workshop, --git or --release')
    expect(fails(['mods', 'rm', '--game', 'rimworld', '--global']).message).toBe('mods rm needs at least one mod id')
    expect(fails(['mods', 'add', '--game', 'rimworld', '--git', 'u']).message).toBe('mods add needs --global or --project')
    const helped = parseArgs(['mods', 'add', '--game', 'rimworld', '--help'], NO_ENV)
    expect(helped.source).toBeUndefined()
    expect(helped.target).toBeUndefined()
  })

  test('sync keeps its ids optional, and a word it is given is an id', () => {
    expect(parseArgs(['mods', 'sync'], NO_ENV).rest).toEqual([])
    const one = parseArgs(['mods', 'sync', 'A.B'], NO_ENV)
    expect(one.game).toBeUndefined()
    expect(one.rest).toEqual(['A.B'])
  })

  test('the git-only flags need --git', () => {
    const ref = fails(['mods', 'add', '--game', 'rimworld', '--path', '/a', '--tag', 'v1', '--global'])
    expect(ref.message).toContain('--tag only applies to a --git or --release source')
    const sub = fails(['mods', 'add', '--game', 'rimworld', '--path', '/a', '--subdir', 'Core', '--global'])
    expect(sub.message).toContain('--subdir only applies to a --git or --release source')
  })

  test('a release source takes a repo, a tag, an asset glob and a subdir', () => {
    const bare = parseArgs(['mods', 'add', '--game', 'rimworld', '--release', 'Owner/Mod', '--global'], NO_ENV)
    expect(bare.source).toEqual({ kind: 'release', repo: 'Owner/Mod' })
    const full = parseArgs(
      ['mods', 'add', '--game', 'rimworld', '--release', 'Owner/Mod', '--tag', 'v1.2', '--asset', 'Mod-*.zip', '--subdir', 'Mod', '--global'],
      NO_ENV,
    )
    expect(full.source).toEqual({ kind: 'release', repo: 'Owner/Mod', tag: 'v1.2', asset: 'Mod-*.zip', subdir: 'Mod' })
  })

  test('--release takes one owner and one repo', () => {
    const error = fails(['mods', 'add', '--game', 'rimworld', '--release', 'https://github.com/Owner/Mod', '--global'])
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('--release takes an owner/repo')
  })

  test('--release contradicts the other source kinds', () => {
    const error = fails(['mods', 'add', '--game', 'rimworld', '--git', 'https://x/y.git', '--release', 'Owner/Mod', '--global'])
    expect(error.message).toContain('a source has one kind')
  })

  test('a release is pinned by --tag, never by --branch or --commit', () => {
    for (const flag of ['--branch', '--commit']) {
      const error = fails(['mods', 'add', '--game', 'rimworld', '--release', 'Owner/Mod', flag, 'x', '--global'])
      expect(error.message).toContain(`${flag} only applies to a --git source; pin a release with --tag`)
    }
  })

  test('--asset needs --release', () => {
    const error = fails(['mods', 'add', '--game', 'rimworld', '--git', 'https://x/y.git', '--asset', '*.zip', '--global'])
    expect(error.message).toBe('--asset only applies to a --release source')
  })

  test('a git source pins one ref', () => {
    const both = fails(['mods', 'add', '--game', 'rimworld', '--git', 'https://x/y.git', '--tag', 'v1', '--branch', 'main', '--global'])
    expect(both.code).toBe(Exit.Usage)
    expect(both.message).toContain('a git source has one ref')
  })

  test('--subdir stays inside the repository', () => {
    const abs = fails(['mods', 'add', '--game', 'rimworld', '--git', 'https://x/y.git', '--subdir', '/abs', '--global'])
    expect(abs.message).toContain('path inside the repository')
    const up = fails(['mods', 'add', '--game', 'rimworld', '--git', 'https://x/y.git', '--subdir', 'a/../../b', '--global'])
    expect(up.message).toContain('cannot climb out of the repository')
  })

  test('a write names exactly one config', () => {
    const none = fails(['mods', 'add', '--game', 'rimworld', '--path', '/a'])
    expect(none.code).toBe(Exit.Usage)
    expect(none.message).toContain('needs --global or --project')
    const both = fails(['mods', 'rm', '--game', 'rimworld', 'A.B', '--global', '--project'])
    expect(both.message).toContain('a write lands in one config')
  })
})

describe('steam', () => {
  test('build takes its game from --game', () => {
    const args = parseArgs(['steam', 'build', '--game', 'rimworld'], NO_ENV)
    expect(args.subcommand).toBe('steam')
    expect(args.subverb).toBe('build')
    expect(args.game).toBe('rimworld')
  })

  test('login takes no positional', () => {
    const args = parseArgs(['steam', 'login'], NO_ENV)
    expect(args.subverb).toBe('login')
    expect(args.game).toBeUndefined()
  })

  test('an unknown subverb lists the ones that exist', () => {
    const error = fails(['steam', 'frobnify'])
    expect(error.code).toBe(Exit.Usage)
    expect(`${error.message} ${error.detail}`).toContain('steam build')
    expect(`${error.message} ${error.detail}`).toContain('steam login')
  })

  test('steam build leaves the game unresolved when nothing says which', () => {
    const args = parseArgs(['steam', 'build'], NO_ENV)
    expect(args.subverb).toBe('build')
    expect(args.game).toBeUndefined()
  })

  test('--variant, --beta and --plugin all repeat', () => {
    const args = parseArgs(
      ['steam', 'build', '--game', 'rimworld', '--variant', 'linux', '--variant', 'windows',
       '--beta', 'public', '--beta', '1.5', '--plugin', '@gamecrate/rimworld'],
      NO_ENV,
    )
    expect(args.variant).toEqual(['linux', 'windows'])
    expect(args.branches).toEqual(['public', '1.5'])
    expect(args.plugin).toEqual(['@gamecrate/rimworld'])
  })

  test('--beta leaves the git --branch of mods add alone', () => {
    const args = parseArgs(
      ['mods', 'add', '--game', 'rimworld', '--git', 'https://x/y.git', '--branch', 'main', '--global'],
      NO_ENV,
    )
    expect(args.source).toEqual({ kind: 'git', url: 'https://x/y.git', ref: { kind: 'branch', value: 'main' } })
  })

  test('--platform defaults to linux/amd64', () => {
    expect(parseArgs(['steam', 'build', '--game', 'rimworld'], NO_ENV).platform).toBe('linux/amd64')
  })

  test('load defaults on, with and without --push', () => {
    expect(parseArgs(['steam', 'build', '--game', 'rimworld'], NO_ENV).load).toBe(true)
    expect(parseArgs(['steam', 'build', '--game', 'rimworld', '--push'], NO_ENV).load).toBe(true)
  })

  test('--no-load turns it off and leaves --push alone', () => {
    const args = parseArgs(['steam', 'build', '--game', 'rimworld', '--push', '--no-load'], NO_ENV)
    expect(args.load).toBe(false)
    expect(args.push).toBe(true)
  })

  test('--load is gone, so it is a usage error', () => {
    const error = fails(['steam', 'build', '--game', 'rimworld', '--load'])
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('--load')
  })
})
