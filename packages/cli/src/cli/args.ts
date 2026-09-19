import { Command, CommanderError, Option } from 'commander'
import type {
  BuildPolicy,
  ModeName,
  NetworkPolicy,
  ParsedArgs,
  ProfileConfig,
  ProjectDefaults,
  PullPolicy,
} from '../types'
import { GamecrateError, Exit, NAME_PATTERN } from '../types'

export type PositionalSlot = 'game' | 'profile' | 'rest'

export interface SubcommandSpec {
  name: string
  summary: string
  /** Rendered after the subcommand word in usage lines. */
  usage: string
  positionals: PositionalSlot[]
  /** Flag names beyond the global set, in the order help should show them. */
  flags: readonly string[]
}

const RUN_FLAGS = [
  '--mod',
  '--without',
  '--only',
  '--mode',
  '--marker',
  '--timeout',
  '--render-wait',
  '--resolution',
  '--network',
  '--log',
  '--pull',
  '--build',
  '--no-build',
  '--no-stale-check',
  '--replace',
  '--no-replace',
  '--detach',
  '--no-detach',
  '--sort',
  '--docker-arg',
  '--dry-run',
  '--print-plan',
  '--root',
  '--worktree',
  '--no-worktree',
  '--instance',
  '--use',
] as const

/** The subcommand table. `modless` is reserved as a built-in profile, not a verb. */
export const SUBCOMMANDS: readonly SubcommandSpec[] = [
  {
    name: 'run',
    summary: 'resolve, stage, launch (implied when the first word is a game)',
    usage: '<game> [profile]',
    positionals: ['game', 'profile', 'rest'],
    flags: RUN_FLAGS,
  },
  {
    name: 'list',
    summary: "games, profiles, and each profile's provenance",
    usage: '[game]',
    positionals: ['game'],
    flags: [],
  },
  {
    name: 'mods',
    summary: 'resolved mod set with source kind and absolute path',
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: ['--mod', '--without', '--only', '--sort'],
  },
  {
    name: 'doctor',
    summary: 'preflight: docker, CDI, registry auth, game dirs, scan roots, perms',
    usage: '',
    positionals: [],
    flags: [],
  },
  {
    name: 'clean',
    summary: 'tiered wipe of a profile',
    usage: '<game> <profile>',
    positionals: ['game', 'profile'],
    flags: ['--staging', '--logs', '--all', '--yes', '--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'clone',
    summary: "reflink-copy a profile's precious tier",
    usage: '<game> <src> <dst>',
    positionals: ['game', 'rest'],
    flags: ['--yes'],
  },
  {
    name: 'logs',
    summary: "tail or open the last run's captured logs",
    usage: '<game> <profile>',
    positionals: ['game', 'profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'build',
    summary: 'build or pull the runtime image, no launch',
    usage: '<game>',
    positionals: ['game'],
    flags: ['--pull'],
  },
  {
    name: 'shell',
    summary: 'same mounts, bash instead of the game',
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: [
      '--mod', '--without', '--only', '--docker-arg', '--root',
      '--worktree', '--no-worktree', '--instance', '--use', '--replace', '--log',
    ],
  },
  {
    name: 'verify',
    summary: 'what the running container actually bound, and whether it looks current',
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'config',
    summary: 'open the global config in $EDITOR, validate on save',
    usage: 'edit',
    positionals: ['rest'],
    flags: [],
  },
  {
    name: 'fix-perms',
    summary: 'chown foreign-owned files back to the caller',
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: ['--yes', '--dry-run'],
  },
  {
    name: 'help',
    summary: 'help for a subcommand or a game',
    usage: '[topic]',
    positionals: ['rest'],
    flags: [],
  },
  {
    name: 'version',
    summary: 'print the version',
    usage: '',
    positionals: [],
    flags: [],
  },
]

/** Shown for every subcommand. */
export const GLOBAL_FLAGS = ['--json', '--help'] as const

const MODES: readonly ModeName[] = ['headed', 'headless', 'screenshot']
const PULL_POLICIES: readonly PullPolicy[] = ['always', 'missing', 'never']
const NETWORK_POLICIES: readonly NetworkPolicy[] = ['none', 'bridge', 'host']
const BUILD_POLICIES: readonly BuildPolicy[] = ['auto', 'always', 'never']
const SORTS = ['topo', 'none'] as const

/** The GAMECRATE_ vars, by the flag they stand in for. Fallbacks only; a flag always wins. */
export const FLAG_ENV: Record<string, string> = {
  '--instance': 'GAMECRATE_INSTANCE',
  '--mode': 'GAMECRATE_MODE',
  '--marker': 'GAMECRATE_MARKER',
  '--timeout': 'GAMECRATE_TIMEOUT',
  '--render-wait': 'GAMECRATE_RENDER_WAIT',
  '--network': 'GAMECRATE_NETWORK',
  '--pull': 'GAMECRATE_PULL',
  '--build': 'GAMECRATE_BUILD',
  '--sort': 'GAMECRATE_SORT',
  '--root': 'GAMECRATE_ROOT',
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function choice<T extends string>(flag: string, values: readonly T[]): (raw: string) => T {
  return (raw) => {
    if (!values.includes(raw as T)) {
      throw usage(`${flag} must be one of ${values.join(', ')}, got ${raw}`)
    }
    return raw as T
  }
}

/** Commander's own choices message reads nothing like ours, so keep the list for help only. */
function enumOption(flags: string, summary: string, values: readonly string[]): Option {
  const long = flags.split(/[ ,]+/).find((token) => token.startsWith('--'))!
  return new Option(flags, summary).choices([...values]).argParser(choice(long, values))
}

/**
 * Every flag, in the order help lists them. The only source of truth for what the CLI
 * accepts: help and completion read it back off the program.
 */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('gamecrate')
    .exitOverride()
    .helpOption(false)
    .allowExcessArguments(true)
    .showSuggestionAfterError(false)
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .argument('[args...]')
    .option('--mod <id>', 'add a mod to the profile set', collect, [])
    .option('--without <id>', 'drop a mod from the resolved set', collect, [])
    .option('--only <id>', 'restrict the resolved set to these mods', collect, [])
    .option(
      '--worktree <path>',
      'promote mods from this git worktree, in its own instance ($GAMECRATE_WORKTREE)',
      collect,
      [],
    )
    .option('--use <packageId>=<path>', 'force one mod to load from this directory, whatever the profile pins', collect, [])
    .option('--no-worktree', 'ignore the current worktree and $GAMECRATE_WORKTREE')
    .option('--instance <name>', 'run under a named sub-profile with its own saves, logs and container')
    .addOption(enumOption(`--mode <${MODES.join('|')}>`, 'how the game is displayed', MODES))
    .option('--marker <str>', 'exit 0 as soon as this string appears in the log')
    .option('--timeout <seconds>', 'kill the container after this long', (v) => seconds('--timeout', v))
    .option('--render-wait <seconds>', 'settle time before a screenshot is taken', (v) =>
      seconds('--render-wait', v))
    .option('--resolution <width>x<height>', 'override the game resolution', parseResolution)
    // host is what a mod's own server needs: it binds loopback inside the container, and
    // -p only ever reaches the container's eth0.
    .addOption(
      enumOption(`--network <${NETWORK_POLICIES.join('|')}>`, "the container's network mode", NETWORK_POLICIES),
    )
    .option('--log <path>', 'route launch stdout and stderr to one file')
    .addOption(
      enumOption(`--pull <${PULL_POLICIES.join('|')}>`, 'when to pull the runtime image', PULL_POLICIES),
    )
    .option('--build', 'build local C# mods before launching')
    .option('--no-build', 'never build, even when an assembly is stale')
    .option('--no-stale-check', "do not warn when a mod's sources are newer than its assemblies")
    .option('--replace', 'stop whatever is holding this profile and instance, then launch')
    .option('--no-replace', 'refuse when this profile and instance are already running')
    .option('--detach', 'start the run in the background and return the prompt')
    .option('--no-detach', 'stay in the foreground, whatever the profile or project config asks for')
    // the re-exec entry point. hidden, so help and completion never offer it.
    .addOption(new Option('--supervised').hideHelp())
    .addOption(
      enumOption(`--sort <${SORTS.join('|')}>`, 'load order: the profile order, or a topological sort', SORTS),
    )
    .option('--docker-arg <arg>', 'one extra argv element for docker run', collect, [])
    .option('--dry-run', 'resolve and validate fully, write nothing')
    .option('--print-plan', 'print the resolved launch plan instead of launching')
    .option('--json', 'machine-readable output')
    .option('--root', 'run as root instead of mapping the host uid')
    .option('--staging', 'clean: wipe .stage only (the default)')
    .option('--logs', 'clean: wipe the captured run logs')
    .option('--all', 'clean: wipe the whole profile, saves included (needs --yes)')
    .option('-y, --yes', 'skip destructive-action confirmation')
    .option('-h, --help', 'this help')

  return program
}

/**
 * Commander hands a value flag whatever token follows it, and its parsers cannot tell
 * `--mod=-x` from `--mod -x`. Only the separate token can be a mistyped flag.
 */
function checkValueTokens(program: Command, head: string[]): void {
  const valued = (name: string): Option | undefined =>
    program.options.find((o) => (o.long === name || o.short === name) && (o.required || o.optional))

  for (let i = 0; i < head.length; i++) {
    const token = head[i]!
    if (!token.startsWith('-') || token === '-') continue

    const eq = token.indexOf('=')
    if (token.startsWith('--') && eq !== -1) {
      const name = token.slice(0, eq)
      if (eq === token.length - 1 && valued(name) !== undefined) throw usage(`${name} needs a value`)
      continue
    }

    const option = valued(token)
    if (option === undefined) continue
    const value = head[++i]
    if (value === undefined) return // commander reports the missing argument itself
    // --docker-arg is the one flag whose value legitimately starts with a dash.
    if (option.long === '--docker-arg') continue
    if (value.startsWith('-') && value.length > 1) {
      throw usage(`${option.long ?? token} needs a value, got the flag ${value}`)
    }
  }
}

export interface ParseOptions {
  env?: Record<string, string | undefined>
  defaults?: ProjectDefaults
  /** Game names from the loaded config; enables did-you-mean on the first positional. */
  games?: readonly string[]
}

type Values = Record<string, unknown>

/**
 * `gamecrate <game> [profile] [flags] [-- game args]`, with the subcommand slot
 * defaulting to `run`. Game args come after a bare `--` and nowhere else.
 */
export function parseArgs(argv: string[], opts: ParseOptions = {}): ParsedArgs {
  const env = opts.env ?? process.env
  const sep = argv.indexOf('--')
  const head = sep === -1 ? argv : argv.slice(0, sep)

  const program = buildProgram()
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  const worktree: string[] = []
  let cleanTier: ParsedArgs['cleanTier']

  // Commander keeps no record of how often a flag appeared, or which half of a
  // --x/--no-x pair the user typed; the events do.
  for (const option of program.options) {
    const long = option.long ?? option.flags
    program.on(`option:${option.name()}`, (value?: string) => {
      seen.add(long)
      counts.set(long, (counts.get(long) ?? 0) + 1)
      if (long === '--worktree' && value !== undefined) worktree.push(value)
      if (long === '--staging' || long === '--logs' || long === '--all') {
        cleanTier = long.slice(2) as ParsedArgs['cleanTier']
      }
    })
  }

  checkValueTokens(program, head)
  try {
    program.parse(head, { from: 'user' })
  } catch (error) {
    throw translate(error, program)
  }

  for (const option of program.options) {
    const long = option.long ?? option.flags
    const repeatable = Array.isArray(option.defaultValue)
    if (option.required && !repeatable && (counts.get(long) ?? 0) > 1) {
      throw usage(`${long} given more than once`)
    }
  }
  if (seen.has('--build') && seen.has('--no-build')) throw usage('--build and --no-build contradict')
  if (seen.has('--replace') && seen.has('--no-replace')) throw usage('--replace and --no-replace contradict')
  if (seen.has('--detach')) {
    if (seen.has('--no-detach')) throw usage('--detach and --no-detach contradict')
    if (seen.has('--dry-run')) throw usage('--detach and --dry-run contradict')
    if (seen.has('--print-plan')) throw usage('--detach and --print-plan contradict')
  }

  const values = program.opts() as Values
  const envBuild = applyEnv(program, seen, env, values)

  const out: ParsedArgs = {
    subcommand: 'run',
    mods: values['mod'] as string[],
    without: values['without'] as string[],
    only: values['only'] as string[],
    dockerArgs: values['dockerArg'] as string[],
    gameArgs: sep === -1 ? [] : argv.slice(sep + 1),
    dryRun: values['dryRun'] === true,
    printPlan: values['printPlan'] === true,
    json: values['json'] === true,
    root: values['root'] === true,
    yes: values['yes'] === true,
    help: values['help'] === true,
    worktree,
    noWorktree: seen.has('--no-worktree'),
    noStaleCheck: seen.has('--no-stale-check'),
    replace: values['replace'] === true,
    noReplace: seen.has('--no-replace'),
    detach: values['detach'] === true,
    noDetach: seen.has('--no-detach'),
    supervised: values['supervised'] === true,
    use: values['use'] as string[],
    rest: [],
  }
  out.mode = values['mode'] as ModeName | undefined
  out.marker = values['marker'] as string | undefined
  out.timeout = values['timeout'] as number | undefined
  out.renderWait = values['renderWait'] as number | undefined
  out.resolution = values['resolution'] as { width: number; height: number } | undefined
  out.network = values['network'] as NetworkPolicy | undefined
  out.log = values['log'] as string | undefined
  out.pull = values['pull'] as PullPolicy | undefined
  out.sort = values['sort'] as 'topo' | 'none' | undefined
  out.instance = values['instance'] as string | undefined
  out.build = envBuild ?? policy(values['build'])
  out.cleanTier = cleanTier

  if (opts.defaults?.game !== undefined) out.game = opts.defaults.game

  applyPositionals(out, program.args, opts.games)
  if (opts.defaults !== undefined) applyDefaults(out, seen, opts.defaults, sep !== -1)
  // the subcommand is only known once the positionals land.
  if (out.detach && out.subcommand === 'shell') {
    throw usage('shell cannot detach', 'a shell needs the terminal --detach gives up')
  }
  return out
}

function policy(value: unknown): BuildPolicy | undefined {
  if (value === true) return 'always'
  if (value === false) return 'never'
  return undefined
}

/** Commander's wording is its own; ours is the one the tests and the docs know. */
function translate(error: unknown, program: Command): unknown {
  if (!(error instanceof CommanderError)) return error
  const token = /'([^']+)'/.exec(error.message)?.[1] ?? ''

  if (error.code === 'commander.unknownOption') {
    const name = token.split('=')[0]!
    const known = program.options.find((o) => o.long === name || o.short === name)
    if (known !== undefined) return usage(`${name} takes no value`)
    return usage(`unknown flag ${name}`, suggest(name, flagNames(program)))
  }
  if (error.code === 'commander.optionMissingArgument') {
    return usage(`${token.split(' ')[0]} needs a value`)
  }
  return new GamecrateError(error.message.replace(/^error: /, ''), Exit.Usage)
}

function applyPositionals(out: ParsedArgs, positional: string[], games?: readonly string[]): void {
  const first = positional[0]
  if (first === undefined) {
    if (out.game !== undefined) return
    out.subcommand = 'help'
    out.help = true
    return
  }

  const sub = SUBCOMMANDS.find((s) => s.name === first)
  let slots: PositionalSlot[]
  let rest: string[]

  if (sub) {
    out.subcommand = sub.name
    slots = [...sub.positionals]
    rest = positional.slice(1)
  } else {
    const known = !NAME_PATTERN.test(first) ? false : games === undefined || games.includes(first)
    if (!known) {
      const candidates = [...SUBCOMMANDS.map((s) => s.name), ...(games ?? [])]
      throw usage(`${first} is not a game or a subcommand`, suggest(first, candidates))
    }
    out.subcommand = 'run'
    out.game = first
    slots = ['profile', 'rest']
    rest = positional.slice(1)
  }

  for (const slot of slots) {
    if (slot === 'rest') {
      out.rest = rest
      rest = []
      break
    }
    const value = rest.shift()
    if (value === undefined) break
    if (!NAME_PATTERN.test(value)) throw usage(`${value} is not a valid ${slot} name`)
    if (slot === 'game') out.game = value
    else out.profile = value
  }

  if (rest.length > 0) {
    const shape = sub ? `${sub.name} ${sub.usage}`.trim() : `${out.game} [profile]`
    throw usage(`unexpected argument ${rest[0]}`, `gamecrate ${shape}`)
  }
}

/**
 * Env vars are a fallback only, and only under the GAMECRATE_ prefix. Values go through
 * the flag's own parser, so a bad one fails the way a bad flag does.
 */
function applyEnv(
  program: Command,
  seen: Set<string>,
  env: Record<string, string | undefined>,
  values: Values,
): BuildPolicy | undefined {
  let build: BuildPolicy | undefined
  for (const [flag, name] of Object.entries(FLAG_ENV)) {
    if (seen.has(flag)) continue
    if (flag === '--build' && seen.has('--no-build')) continue
    const raw = env[name]
    if (raw === undefined || raw === '') continue
    seen.add(flag)

    if (flag === '--build') {
      if (!BUILD_POLICIES.includes(raw as BuildPolicy)) {
        throw usage(`${name} must be one of ${BUILD_POLICIES.join(', ')}, got ${raw}`)
      }
      build = raw as BuildPolicy
      continue
    }

    const option = program.options.find((o) => o.long === flag)!
    const key = option.attributeName()
    if (!option.required) {
      if (truthy(raw)) values[key] = true
      continue
    }
    if (option.argChoices && !option.argChoices.includes(raw)) {
      throw usage(`${name} must be one of ${option.argChoices.join(', ')}, got ${raw}`)
    }
    values[key] = option.parseArg === undefined ? raw : option.parseArg(raw, values[key])
  }
  return build
}

function applyDefaults(
  out: ParsedArgs,
  seen: Set<string>,
  defaults: ProjectDefaults,
  hasGameArgs: boolean,
): void {
  if (!seen.has('--mod') && defaults.mods !== undefined) out.mods = [...defaults.mods]
  if (!seen.has('--without') && defaults.without !== undefined) out.without = [...defaults.without]
  if (!seen.has('--only') && defaults.only !== undefined) out.only = [...defaults.only]
  if (!seen.has('--docker-arg') && defaults.dockerArgs !== undefined) out.dockerArgs = [...defaults.dockerArgs]
  if (!seen.has('--worktree') && !seen.has('--no-worktree') && defaults.worktree !== undefined) {
    out.worktree = [...defaults.worktree]
  }
  if (!seen.has('--use') && defaults.use !== undefined) out.use = [...defaults.use]
  if (!hasGameArgs && defaults.gameArgs !== undefined) out.gameArgs = [...defaults.gameArgs]

  out.mode ??= defaults.mode
  out.marker ??= defaults.marker
  out.timeout ??= defaults.timeout
  out.renderWait ??= defaults.renderWait
  out.resolution ??= defaults.resolution
  out.network ??= defaults.network
  out.log ??= defaults.log
  out.pull ??= defaults.pull
  out.build ??= defaults.build
  out.sort ??= defaults.sort
  out.instance ??= defaults.instance

  if (!seen.has('--dry-run')) out.dryRun = defaults.dryRun ?? out.dryRun
  if (!seen.has('--print-plan')) out.printPlan = defaults.printPlan ?? out.printPlan
  if (!seen.has('--json')) out.json = defaults.json ?? out.json
  if (!seen.has('--root')) out.root = defaults.root ?? out.root
  if (!seen.has('--no-worktree') && !seen.has('--worktree')) {
    out.noWorktree = defaults.noWorktree ?? out.noWorktree
  }
  if (!seen.has('--no-stale-check')) out.noStaleCheck = defaults.noStaleCheck ?? out.noStaleCheck
  if (!seen.has('--replace') && !seen.has('--no-replace')) out.replace = defaults.replace ?? out.replace
  if (!seen.has('--detach') && !seen.has('--no-detach')) out.detach = defaults.detach ?? out.detach
}

/**
 * Any layer can ask for this; the --no-detach flag is the only refusal. The supervisor is
 * already the fork, and a profile or project `detach: true` reaches it too: it never forks again.
 */
export function wantsDetach(args: ParsedArgs, profile: ProfileConfig): boolean {
  return !args.supervised && !args.noDetach && (args.detach || profile.detach === true)
}

export function wantsReplace(args: ParsedArgs, profile: ProfileConfig): boolean {
  return !args.noReplace && (args.replace || profile.replace === true)
}

/** Three-way, so first defined wins. --no-build already arrives as 'never'. */
export function buildPolicy(args: ParsedArgs, profile: ProfileConfig): BuildPolicy {
  return args.build ?? profile.build ?? 'auto'
}

function truthy(value: string): boolean {
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

function flagNames(program: Command): string[] {
  return program.options.flatMap((o) => [o.long, o.short].filter((f): f is string => f !== undefined))
}

function seconds(flag: string, value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw usage(`${flag} takes a whole number of seconds, got ${value}`)
  }
  return n
}

export function parseResolution(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value)
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw usage(`--resolution takes positive dimensions like 1920x1080, got ${value}`)
  }
  return { width, height }
}

function usage(message: string, suggestion?: string): GamecrateError {
  return new GamecrateError(message, Exit.Usage, suggestion ? `did you mean ${suggestion}?` : undefined)
}

/** Closest candidate within an edit distance that scales with word length. */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
  const target = word.toLowerCase()
  const limit = Math.max(2, Math.floor(target.length / 3))
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const d = distance(target, candidate.toLowerCase())
    if (d < bestDistance && d <= limit) {
      best = candidate
      bestDistance = d
    }
  }
  return best
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    prev = row
  }
  return prev[b.length]!
}

/**
 * The argv that re-execs this same gamecrate as a supervisor. The compiled binary reports
 * a virtual /$bunfs path as argv[1], which the child would read as a game name.
 */
export function supervisorArgv(
  userArgs: string[],
  self: string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const bin = self[1]?.startsWith('/$bunfs/') === true ? [execPath] : [execPath, self[1]!]
  const sep = userArgs.indexOf('--')
  const head = (sep === -1 ? userArgs : userArgs.slice(0, sep)).map((arg) =>
    arg === '--detach' ? '--supervised' : arg,
  )
  const tail = sep === -1 ? [] : userArgs.slice(sep)
  return [...bin, ...head, ...tail]
}
