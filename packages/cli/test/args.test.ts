import { describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SUBCOMMANDS,
  buildPolicy,
  buildProgram,
  parseArgs,
  suggest,
  supervisedDir,
  supervisorArgv,
  wantsDetach,
  wantsReplace,
} from '../src/cli/args'
import { renderCompletion, renderHelp } from '../src/cli/help'
import {
  forwardOutput,
  openRunLog,
  planPayload,
  redirectOutput,
  reportProblems,
  rotateRuns,
  runTimestamp,
} from '../src/cli/output'
import { exited, spawnArgv } from '../src/docker/run'
import { fixturePlugin } from './fixture-plugin'
import type { GameConfig, LaunchPlan, Problem, ProjectDefaults, RootConfig, Settings } from '../src/types'
import { GamecrateError, Exit, RESERVED_NAMES } from '../src/types'

const NO_ENV = { env: {} }

function fails(argv: string[], games?: string[]): GamecrateError {
  try {
    parseArgs(argv, { env: {}, ...(games ? { games } : {}) })
  } catch (error) {
    expect(error).toBeInstanceOf(GamecrateError)
    return error as GamecrateError
  }
  throw new Error(`expected ${argv.join(' ')} to fail`)
}

describe('positionals', () => {
  test('game and profile stay two tokens', () => {
    const args = parseArgs(['beacon', 'kitted'], NO_ENV)
    expect(args.subcommand).toBe('run')
    expect(args.game).toBe('beacon')
    expect(args.profile).toBe('kitted')
  })

  test('a subcommand word wins the first slot, and run/ escapes it', () => {
    const asVerb = parseArgs(['build', 'atlas'], NO_ENV)
    expect(asVerb.subcommand).toBe('build')
    expect(asVerb.game).toBe('atlas')
    expect(asVerb.profile).toBeUndefined()

    const asGame = parseArgs(['run', 'build', 'kitted'], NO_ENV)
    expect(asGame.subcommand).toBe('run')
    expect(asGame.game).toBe('build')
    expect(asGame.profile).toBe('kitted')
  })

  test('extra positionals past a subcommand shape are rejected', () => {
    const error = fails(['list', 'atlas', 'kitted'])
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('unexpected argument kitted')
  })

  test('clone keeps src and dst in rest', () => {
    const args = parseArgs(['clone', 'atlas', 'kitted', 'kitted-2'], NO_ENV)
    expect(args.game).toBe('atlas')
    expect(args.rest).toEqual(['kitted', 'kitted-2'])
  })

  test('an unknown first word suggests a near subcommand', () => {
    const error = fails(['lst'], ['atlas'])
    expect(error.code).toBe(Exit.Usage)
    expect(error.detail).toBe('did you mean list?')
  })

  test('an unknown game suggests a configured game', () => {
    const error = fails(['atals', 'kitted'], ['atlas', 'beacon'])
    expect(error.detail).toBe('did you mean atlas?')
  })

  test('a path-shaped name is not a game', () => {
    expect(fails(['../etc'], ['atlas']).code).toBe(Exit.Usage)
  })

  test('no arguments asks for help', () => {
    const args = parseArgs([], NO_ENV)
    expect(args.subcommand).toBe('help')
    expect(args.help).toBe(true)
  })

  test('every subcommand is reserved, and modless stays a profile name', () => {
    for (const sub of SUBCOMMANDS) expect(RESERVED_NAMES).toContain(sub.name)
    expect(SUBCOMMANDS.map((s) => s.name)).not.toContain('modless')
    expect(parseArgs(['atlas', 'modless'], NO_ENV).profile).toBe('modless')
  })
})

describe('the bare -- split', () => {
  test('everything after -- is a game arg, verbatim', () => {
    const args = parseArgs(
      ['atlas', 'kitted', '--mode', 'headless', '--', '-savedatafolder=/data', '--mod', 'quicksave'],
      NO_ENV,
    )
    expect(args.mode).toBe('headless')
    expect(args.mods).toEqual([])
    expect(args.gameArgs).toEqual(['-savedatafolder=/data', '--mod', 'quicksave'])
  })

  test('a bare word after -- stays a game arg', () => {
    const args = parseArgs(['beacon', '--', 'quickstart'], NO_ENV)
    expect(args.gameArgs).toEqual(['quickstart'])
    expect(args.profile).toBeUndefined()
  })

  test('a second -- belongs to the game', () => {
    expect(parseArgs(['beacon', '--', 'a', '--', 'b'], NO_ENV).gameArgs).toEqual(['a', '--', 'b'])
  })

  test('no -- means no game args, and a trailing word is a profile', () => {
    const args = parseArgs(['beacon', 'kitted'], NO_ENV)
    expect(args.gameArgs).toEqual([])
  })
})

describe('repeatable flags', () => {
  test('each occurrence takes exactly one argv element, spaces included', () => {
    const args = parseArgs(
      [
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
    expect(parseArgs(['beacon', '--docker-arg', '--network=host'], NO_ENV).dockerArgs).toEqual([
      '--network=host',
    ])
  })

  test('--without and --only collect independently', () => {
    const args = parseArgs(['beacon', '--without', 'a', '--without', 'b', '--only', 'c'], NO_ENV)
    expect(args.without).toEqual(['a', 'b'])
    expect(args.only).toEqual(['c'])
  })

  test('a non-repeatable value flag given twice is an error', () => {
    expect(fails(['beacon', '--mode', 'headed', '--mode', 'headless']).message).toContain('more than once')
  })
})

describe('flag rejection', () => {
  test('an unknown flag is an error with a suggestion', () => {
    const error = fails(['beacon', '--dryrun'])
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('unknown flag --dryrun')
    expect(error.detail).toBe('did you mean --dry-run?')
  })

  test('a typo’d flag is never swallowed as a mod name', () => {
    expect(fails(['beacon', 'kitted', '--mdo', 'Bridge.Lantern']).message).toContain('unknown flag')
  })

  test('a value flag followed by a flag is an error', () => {
    expect(fails(['beacon', '--mod', '--json']).message).toContain('needs a value')
  })

  test('a value flag at the end is an error', () => {
    expect(fails(['beacon', '--marker']).message).toContain('needs a value')
  })

  test('a boolean flag rejects a value', () => {
    expect(fails(['beacon', '--dry-run=yes']).message).toContain('takes no value')
  })

  test('enums are checked', () => {
    expect(fails(['beacon', '--mode', 'window']).message).toContain('headed, headless, screenshot')
    expect(fails(['beacon', '--pull', 'sometimes']).message).toContain('always, missing, never')
    expect(fails(['beacon', '--network', 'macvlan']).message).toContain('none, bridge, host')
  })

  test('--network overrides the game default', () => {
    expect(parseArgs(['atlas', '--network', 'none'], NO_ENV).network).toBe('none')
    expect(parseArgs(['atlas'], { env: { GAMECRATE_NETWORK: 'bridge' } }).network).toBe('bridge')
  })

  test('--timeout takes whole seconds', () => {
    expect(parseArgs(['beacon', '--timeout', '90'], NO_ENV).timeout).toBe(90)
    expect(fails(['beacon', '--timeout', '9.5']).message).toContain('whole number')
    expect(fails(['beacon', '--timeout', '-1']).message).toContain('needs a value')
  })

  test('--build and --no-build contradict', () => {
    expect(parseArgs(['beacon', '--build'], NO_ENV).build).toBe('always')
    expect(parseArgs(['beacon', '--no-build'], NO_ENV).build).toBe('never')
    expect(fails(['beacon', '--build', '--no-build']).message).toContain('contradict')
  })

  test('--flag=value is accepted, empty is not', () => {
    expect(parseArgs(['beacon', '--mod=Bridge.Lantern'], NO_ENV).mods).toEqual(['Bridge.Lantern'])
    expect(fails(['beacon', '--mod=']).message).toContain('needs a value')
  })

  test('an inline value may start with a dash, a separate token may not', () => {
    expect(parseArgs(['beacon', '--marker=->ready'], NO_ENV).marker).toBe('->ready')
    expect(parseArgs(['beacon', '--mod=-x'], NO_ENV).mods).toEqual(['-x'])
    expect(parseArgs(['beacon', '--worktree=-x'], NO_ENV).worktree).toEqual(['-x'])
    expect(parseArgs(['beacon', '--instance=-a'], NO_ENV).instance).toBe('-a')

    expect(fails(['beacon', '--marker', '->ready']).message).toBe(
      '--marker needs a value, got the flag ->ready',
    )
    expect(fails(['beacon', '--mod', '-x']).message).toContain('got the flag -x')
  })

  test('--docker-arg takes a dash value either way', () => {
    expect(parseArgs(['beacon', '--docker-arg', '-v'], NO_ENV).dockerArgs).toEqual(['-v'])
    expect(parseArgs(['beacon', '--docker-arg=-v'], NO_ENV).dockerArgs).toEqual(['-v'])
  })

  test('a separate empty value is a value, an inline empty one is not', () => {
    expect(parseArgs(['beacon', '--marker', ''], NO_ENV).marker).toBe('')
    expect(fails(['beacon', '--marker=']).message).toBe('--marker needs a value')
  })

  test('a negative number reads as a flag only as a separate token', () => {
    expect(fails(['beacon', '--timeout', '-1']).message).toContain('needs a value, got the flag -1')
    expect(fails(['beacon', '--timeout=-1']).message).toContain('whole number of seconds, got -1')
    expect(fails(['beacon', '--mode=-x']).message).toContain('headed, headless, screenshot')
  })

  test('everything after -- is passed through untouched', () => {
    expect(parseArgs(['beacon', '--', '-x', '--mod'], NO_ENV).gameArgs).toEqual(['-x', '--mod'])
  })

  test('aliases are limited to -h and -y', () => {
    expect(parseArgs(['clean', 'beacon', 'kitted', '-y'], NO_ENV).yes).toBe(true)
    expect(parseArgs(['list', '-h'], NO_ENV).help).toBe(true)
    expect(fails(['beacon', '-m', 'x']).message).toContain('unknown flag')
  })

  test('--replace and --no-stale-check are booleans, off by default', () => {
    const bare = parseArgs(['beacon', 'kitted'], NO_ENV)
    expect(bare.replace).toBe(false)
    expect(bare.noStaleCheck).toBe(false)

    const both = parseArgs(['beacon', 'kitted', '--replace', '--no-stale-check'], NO_ENV)
    expect(both.replace).toBe(true)
    expect(both.noStaleCheck).toBe(true)
    expect(fails(['beacon', '--replace=yes']).message).toContain('takes no value')
  })

  test('verify takes a game and a profile', () => {
    const args = parseArgs(['verify', 'atlas', 'kitted'], NO_ENV)
    expect(args.subcommand).toBe('verify')
    expect(args.game).toBe('atlas')
    expect(args.profile).toBe('kitted')
  })

  test('--replace and --no-replace contradict', () => {
    expect(parseArgs(['beacon', '--no-replace'], NO_ENV).replace).toBe(false)
    expect(fails(['beacon', '--replace', '--no-replace']).message).toContain('contradict')
  })

  test('a boolean flag may repeat; a value flag may not', () => {
    expect(parseArgs(['beacon', '--dry-run', '--dry-run'], NO_ENV).dryRun).toBe(true)
    expect(fails(['beacon', '--instance', 'a', '--instance', 'b']).message).toContain('more than once')
  })

  test('--worktree and --no-worktree both land, in either order', () => {
    const args = parseArgs(['beacon', '--worktree', '/a', '--no-worktree'], NO_ENV)
    expect(args.worktree).toEqual(['/a'])
    expect(args.noWorktree).toBe(true)
  })

  test('--use keeps the = in its value', () => {
    expect(parseArgs(['beacon', '--use', 'Bridge.Lantern=/src/lantern'], NO_ENV).use).toEqual([
      'Bridge.Lantern=/src/lantern',
    ])
  })

  test('a global flag is accepted by every subcommand, ignored or not', () => {
    const args = parseArgs(['list', 'atlas', '--json', '--mode', 'headless'], NO_ENV)
    expect(args.subcommand).toBe('list')
    expect(args.json).toBe(true)
    expect(args.mode).toBe('headless')
  })
})

describe('env fallbacks', () => {
  test('only GAMECRATE_ prefixed vars are read', () => {
    const env = { MODE: 'headless', TIMEOUT: '5', MARKER: 'boom', GAMECRATE_MODE: 'screenshot' }
    const args = parseArgs(['atlas'], { env })
    expect(args.mode).toBe('screenshot')
    expect(args.timeout).toBeUndefined()
    expect(args.marker).toBeUndefined()
  })

  test('a flag beats the env var', () => {
    const args = parseArgs(['atlas', '--mode', 'headed'], { env: { GAMECRATE_MODE: 'headless' } })
    expect(args.mode).toBe('headed')
  })

  test('GAMECRATE_BUILD carries a policy', () => {
    expect(parseArgs(['atlas'], { env: { GAMECRATE_BUILD: 'never' } }).build).toBe('never')
    expect(() => parseArgs(['atlas'], { env: { GAMECRATE_BUILD: 'maybe' } })).toThrow(GamecrateError)
  })

  test('a bad env value fails the same way a bad flag does', () => {
    expect(() => parseArgs(['atlas'], { env: { GAMECRATE_PULL: 'sometimes' } })).toThrow(
      /always, missing, never/,
    )
  })

  test('an env value goes through the flag\'s own parser', () => {
    expect(parseArgs(['atlas'], { env: { GAMECRATE_TIMEOUT: '45' } }).timeout).toBe(45)
    expect(() => parseArgs(['atlas'], { env: { GAMECRATE_TIMEOUT: '9.5' } })).toThrow(/whole number/)
  })

  test('GAMECRATE_ROOT is truthy-checked', () => {
    expect(parseArgs(['atlas'], { env: { GAMECRATE_ROOT: '1' } }).root).toBe(true)
    expect(parseArgs(['atlas'], { env: { GAMECRATE_ROOT: '0' } }).root).toBe(false)
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

  test('a configured game makes a bare invocation runnable', () => {
    const args = parseArgs([], { env: {}, games: ['atlas'], defaults })
    expect(args.subcommand).toBe('run')
    expect(args.help).toBe(false)
    expect(args.game).toBe('atlas')
    expect(args.profile).toBeUndefined()
    expect(args.build).toBe('always')
    expect(args.replace).toBe(true)
    expect(args.resolution).toEqual({ width: 2560, height: 1440 })
    expect(args.log).toBe('default.log')
  })

  test('CLI values replace file defaults', () => {
    const args = parseArgs(
      [
        'beacon', 'qol', '--mode', 'headed', '--no-build', '--no-replace',
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
    expect(fails(['atlas', '--resolution', '0x1080']).message).toContain('positive dimensions')
    expect(fails(['atlas', '--resolution', 'wide']).message).toContain('positive dimensions')
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
    image: { ref: 'beacon:play', acquire: 'pull' },
    executable: './Beacon',
    steamAppId: 294100,
    workshopRoot: null,
    scanRoots: [],
    manifest: { file: 'About/About.txt' },
    modsConfig: { file: 'Config/ModsConfig.txt' },
    prefs: { file: 'Prefs.txt' },
    saveExtensions: ['sav'],
    core: 'beaconco.beacon',
    dlc: [],
    modes: ['headed', 'headless'],
    profiles: {
      kitted: { mods: ['Bridge.Lantern', 'Kitted.Core'] },
      vanilla: { alias: 'modless' },
    },
    ...overrides,
  }
}

const config: RootConfig = { dataRoot: '~/.local/share/gamecrate', games: { beacon: game() } }

describe('help', () => {
  test('top level lists subcommands, flags and games', () => {
    const text = renderHelp(undefined, config)
    expect(text).toContain('gamecrate <game> [profile] [flags] [-- game args]')
    expect(text).toContain('fix-perms')
    expect(text).toContain('--docker-arg')
    expect(text).toContain('--resolution')
    expect(text).toContain('--log')
    expect(text).toContain('--no-replace')
    expect(text).toContain('beacon')
  })

  test('per-subcommand help shows only that subcommand', () => {
    const text = renderHelp('clean', config)
    expect(text).toContain('usage: gamecrate clean <game> <profile>')
    expect(text).toContain('--yes')
    expect(text).not.toContain('--render-wait')
  })

  test('per-game help lists profiles and modes', () => {
    const text = renderHelp('beacon', config)
    expect(text).toContain('kitted')
    expect(text).toContain('alias for modless')
    expect(text).toContain('modes: headed, headless')
  })

  test('an unknown topic is a usage error with a suggestion', () => {
    try {
      renderHelp('beacn', config)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GamecrateError)
      expect((error as GamecrateError).code).toBe(Exit.Usage)
      expect((error as GamecrateError).detail).toBe('did you mean beacon?')
    }
  })

  test('help is derived from the parser, so every public flag it accepts is listed', () => {
    const text = renderHelp(undefined, config)
    const options = buildProgram().options.filter((o) => !o.hidden)
    expect(options.length).toBe(buildProgram().options.length - 1)
    for (const option of options) expect(text).toContain(option.flags)
  })

  test('completions name every subcommand', () => {
    const bash = renderCompletion('bash')
    expect(bash).toContain('complete -F _gamecrate gamecrate')
    expect(bash).toContain('fix-perms')
    expect(renderCompletion('zsh')).toContain('#compdef gamecrate')
  })

  test('completions carry no docker-game identifiers', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      const text = renderCompletion(shell)
      expect(text).not.toContain('docker_game')
      expect(text).not.toContain('docker-game')
      expect(text).toContain('_gamecrate()')
    }
    expect(renderCompletion('zsh')).toContain('_gamecrate "$@"')
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
    expect(JSON.parse(JSON.stringify(payload)).mods.length).toBe(2)
  })
})

describe('run logs', () => {
  test('a redirected log combines stdout and stderr without mirroring them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gamecrate-output-')), 'combined.log')
    const redirect = redirectOutput(file)
    try {
      process.stdout.write('game output\n')
      process.stderr.write('tool status\n')
    } finally {
      redirect.close()
    }
    expect(readFileSync(file, 'utf8')).toBe('game output\ntool status\n')
  })

  test('a redirected log captures forwarded child output', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gamecrate-output-')), 'combined.log')
    const redirect = redirectOutput(file)
    try {
      const proc = spawnArgv(['sh', '-c', 'printf child-out; printf child-err >&2'], [
        'ignore',
        'pipe',
        'pipe',
      ])
      const code = exited(proc)
      await Promise.all([
        forwardOutput(proc.stdout!, process.stdout),
        forwardOutput(proc.stderr!, process.stderr),
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

  // /$bunfs is a virtual path inside the compiled binary; the child would parse it as a game.
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

  // a project or profile detach: true never types a flag, so a swap would leave the child
  // detaching all over again.
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
    expect(parseArgs(['rimworld', '--detach'], { env: {}, games: ['rimworld'] }).detach).toBe(true)
    expect(parseArgs(['rimworld', '--supervised', '/tmp/x'], { env: {}, games: ['rimworld'] }).supervised).toBe(true)
    expect(parseArgs(['rimworld'], { env: {}, games: ['rimworld'] }).supervised).toBe(false)
    expect(parseArgs(['rimworld'], { env: {}, games: ['rimworld'] }).detach).toBe(false)
  })

  test('--detach and --no-detach contradict', () => {
    expect(fails(['rimworld', '--detach', '--no-detach'], ['rimworld']).code).toBe(Exit.Usage)
  })

  test('a project detach: true fills args.detach', () => {
    const args = parseArgs(['rimworld'], { env: {}, games: ['rimworld'], defaults: { detach: true } })
    expect(args.detach).toBe(true)
  })

  test('any layer turns a boolean on, only --no-* turns it off', () => {
    const bare = parseArgs(['rimworld'], { env: {}, games: ['rimworld'] })
    const onFlag = parseArgs(['rimworld', '--detach', '--replace'], { env: {}, games: ['rimworld'] })
    const offFlag = parseArgs(['rimworld', '--no-detach', '--no-replace'], { env: {}, games: ['rimworld'] })

    expect(wantsDetach(bare, {})).toBe(false)
    expect(wantsDetach(bare, { detach: true })).toBe(true)
    expect(wantsDetach(onFlag, {})).toBe(true)
    expect(wantsDetach(offFlag, { detach: true })).toBe(false)

    expect(wantsReplace(bare, { replace: true })).toBe(true)
    expect(wantsReplace(onFlag, {})).toBe(true)
    expect(wantsReplace(offFlag, { replace: true })).toBe(false)
  })

  test('build is first defined wins, and --no-build still means never', () => {
    const bare = parseArgs(['rimworld'], { env: {}, games: ['rimworld'] })
    const noBuild = parseArgs(['rimworld', '--no-build'], { env: {}, games: ['rimworld'] })
    const always = parseArgs(['rimworld', '--build'], { env: {}, games: ['rimworld'] })

    expect(buildPolicy(bare, {})).toBe('auto')
    expect(buildPolicy(bare, { build: 'always' })).toBe('always')
    expect(buildPolicy(always, { build: 'never' })).toBe('always')
    expect(buildPolicy(noBuild, { build: 'always' })).toBe('never')
  })

  test('--supervised is hidden from help and completion', () => {
    expect(renderHelp(undefined, { dataRoot: '/tmp', games: {} } as RootConfig)).not.toContain('--supervised')
    expect(renderCompletion('bash')).not.toContain('--supervised')
    expect(renderCompletion('zsh')).not.toContain('--supervised')
    expect(renderHelp('run')).not.toContain('--supervised')
  })

  test('shell, dry-run and print-plan refuse to detach', () => {
    expect(fails(['shell', 'rimworld', '--detach'], ['rimworld']).code).toBe(Exit.Usage)
    expect(fails(['rimworld', '--detach', '--dry-run'], ['rimworld']).code).toBe(Exit.Usage)
    expect(fails(['rimworld', '--detach', '--print-plan'], ['rimworld']).code).toBe(Exit.Usage)
  })

  test('the supervisor never forks again, whatever the profile asks for', () => {
    const child = parseArgs(['rimworld', '--supervised', '/tmp/x'], { env: {}, games: ['rimworld'] })
    expect(wantsDetach(child, { detach: true })).toBe(false)
    expect(wantsReplace(child, { replace: true })).toBe(false)
  })

  test('a profile detach never reaches the shell refusal', () => {
    const args = parseArgs(['shell', 'rimworld'], { env: {}, games: ['rimworld'] })
    expect(wantsDetach(args, { detach: true })).toBe(true)
  })

  test('there is no env fallback for detach', () => {
    const args = parseArgs(['rimworld'], { env: { GAMECRATE_DETACH: '1' }, games: ['rimworld'] })
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
    const error = fails(['shell', 'rimworld', '--detach'], ['rimworld'])
    expect(error.message).toBe('shell cannot detach: a shell needs the terminal --detach gives up')
    expect(error.detail).toBeUndefined()
  })
})
