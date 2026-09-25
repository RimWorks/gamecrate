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
import { GamecrateError, Exit, NAME_PATTERN, own } from '../types'

export type PositionalSlot = 'game' | 'profile' | 'rest'

export interface SubcommandSpec {
  name: string
  summary: string
  /** Rendered after the subcommand word in usage lines. */
  usage: string
  positionals: PositionalSlot[]
  /** Flag names beyond the global set, in the order help should show them. */
  flags: readonly string[]
  /** Slots to use instead of `positionals` when the next word is one of these. */
  subverbs?: Readonly<Record<string, PositionalSlot[]>>
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
  '--image',
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
    summary: 'resolved mod set, or add, remove and sync library sources',
    usage: '<game> [profile] | add <game> <source> | rm <game> <id>... | sync [game] [id]...',
    positionals: ['game', 'profile'],
    subverbs: {
      add: ['game'],
      rm: ['game', 'rest'],
      sync: ['game', 'rest'],
    },
    flags: [
      '--mod', '--without', '--only', '--sort',
      '--path', '--workshop', '--git', '--branch', '--tag', '--commit', '--subdir',
      '--global', '--project', '--force',
    ],
  },
  {
    name: 'refs',
    summary: "a directory of the game's managed assemblies, for a mod's csproj to reference",
    usage: '<game>',
    positionals: ['game'],
    flags: [],
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
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: ['--staging', '--logs', '--all', '--downloads', '--yes', '--instance', '--worktree', '--no-worktree'],
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
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: ['--instance', '--worktree', '--no-worktree', '--follow'],
  },
  {
    name: 'attach',
    summary: "stream a detached run's output; ctrl-c leaves the game running",
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'wait',
    summary: 'block until a detached run ends, then exit with its code',
    usage: '<game> [profile]',
    positionals: ['game', 'profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'ps',
    summary: 'every live run: game, profile/instance, mode, pid, container, uptime or status',
    usage: '',
    positionals: [],
    flags: [],
  },
  {
    name: 'stop',
    summary: 'stop a detached run and release its lock',
    usage: '<game> [profile]',
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
    name: 'steam',
    summary: 'build a game image from steam, or prime a steam session',
    usage: 'build <game> | login',
    positionals: ['game'],
    subverbs: {
      build: ['game'],
      login: [],
    },
    flags: [
      '--variant', '--beta', '--image', '--plugin',
      '--load', '--push', '--base', '--platform', '--force',
      '--print', '--username',
    ],
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
    summary: 'open the global config in $VISUAL or $EDITOR, validate on save',
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
/**
 * Every flag, by long name. `SUBCOMMANDS` decides which verbs get which, so a flag
 * registered here but listed nowhere is unreachable rather than quietly global.
 */
const OPTIONS: Readonly<Record<string, (cmd: Command) => void>> = {
  '--mod': (cmd) => {
    cmd.option('--mod <id>', 'add a mod to the profile set', collect, [])
  },
  '--without': (cmd) => {
    cmd.option('--without <id>', 'drop a mod from the resolved set', collect, [])
  },
  '--only': (cmd) => {
    cmd.option('--only <id>', 'restrict the resolved set to these mods', collect, [])
  },
  '--worktree': (cmd) => {
    cmd.option(
        '--worktree <path>',
        'promote mods from this git worktree, in its own instance ($GAMECRATE_WORKTREE)',
        collect,
        [],
      )
  },
  '--use': (cmd) => {
    cmd.option('--use <packageId>=<path>', 'force one mod to load from this directory, whatever the profile pins', collect, [])
  },
  '--no-worktree': (cmd) => {
    cmd.option('--no-worktree', 'ignore the current worktree and $GAMECRATE_WORKTREE')
  },
  '--instance': (cmd) => {
    cmd.option('--instance <name>', 'run under a named sub-profile with its own saves, logs and container')
  },
  '--mode': (cmd) => {
    cmd.addOption(enumOption(`--mode <${MODES.join('|')}>`, 'how the game is displayed', MODES))
  },
  '--marker': (cmd) => {
    cmd.option('--marker <str>', 'exit 0 as soon as this string appears in the log')
  },
  '--timeout': (cmd) => {
    cmd.option('--timeout <seconds>', 'bound a marker run, or a headless run with no marker', (v) => seconds('--timeout', v))
  },
  '--render-wait': (cmd) => {
    cmd.option('--render-wait <seconds>', 'settle time before a screenshot is taken', (v) =>
        seconds('--render-wait', v))
  },
  '--resolution': (cmd) => {
    cmd.option('--resolution <width>x<height>', 'override the game resolution', parseResolution)
  },
  '--network': (cmd) => {
    // host is what a mod's own server needs: -p only ever reaches the container's eth0
    cmd.addOption(
        enumOption(`--network <${NETWORK_POLICIES.join('|')}>`, "the container's network mode", NETWORK_POLICIES),
      )
  },
  '--log': (cmd) => {
    cmd.option('--log <path>', 'route launch stdout and stderr to one file')
  },
  '--pull': (cmd) => {
    cmd.addOption(
        enumOption(`--pull <${PULL_POLICIES.join('|')}>`, 'when to pull the runtime image', PULL_POLICIES),
      )
  },
  '--build': (cmd) => {
    cmd.option('--build', 'build local C# mods before launching')
  },
  '--no-build': (cmd) => {
    cmd.option('--no-build', 'never build, even when an assembly is stale')
  },
  '--no-stale-check': (cmd) => {
    cmd.option('--no-stale-check', "do not warn when a mod's sources are newer than its assemblies")
  },
  '--replace': (cmd) => {
    cmd.option('--replace', 'stop whatever is holding this profile and instance, then launch')
  },
  '--no-replace': (cmd) => {
    cmd.option('--no-replace', 'refuse when this profile and instance are already running')
  },
  '--detach': (cmd) => {
    cmd.option('--detach', 'start the run in the background and return the prompt')
  },
  '--no-detach': (cmd) => {
    cmd.option('--no-detach', 'stay in the foreground, whatever the profile or project config asks for')
  },
  '--supervised': (cmd) => {
    // the re-exec entry point. hidden, so help and completion never offer it
    cmd.addOption(new Option('--supervised <instanceDir>').hideHelp())
  },
  '--sort': (cmd) => {
    cmd.addOption(
        enumOption(`--sort <${SORTS.join('|')}>`, 'load order: the profile order, or a topological sort', SORTS),
      )
  },
  '--docker-arg': (cmd) => {
    cmd.option('--docker-arg <arg>', 'one extra argv element for docker run', collect, [])
  },
  '--dry-run': (cmd) => {
    cmd.option('--dry-run', 'resolve and validate fully, write nothing')
  },
  '--print-plan': (cmd) => {
    cmd.option('--print-plan', 'print the resolved launch plan instead of launching')
  },
  '--json': (cmd) => {
    cmd.option('--json', 'machine-readable output')
  },
  '--root': (cmd) => {
    cmd.option('--root', 'run as root instead of mapping the host uid')
  },
  '--staging': (cmd) => {
    cmd.option('--staging', 'clean: wipe .stage only (the default)')
  },
  '--logs': (cmd) => {
    cmd.option('--logs', 'clean: wipe the captured run logs')
  },
  '--all': (cmd) => {
    cmd.option('--all', 'clean: wipe the whole profile and the game downloads (needs --yes)')
  },
  '--downloads': (cmd) => {
    cmd.option('--downloads', 'clean: wipe this game\'s workshop downloads, keeping steamcmd')
  },
  '--follow': (cmd) => {
    cmd.option('-f, --follow', 'keep printing as the run writes')
  },
  '--yes': (cmd) => {
    cmd.option('-y, --yes', 'skip destructive-action confirmation')
  },
  '--path': (cmd) => {
    cmd.option('--path <dir>', 'mods add: take the mod from this directory')
  },
  '--workshop': (cmd) => {
    cmd.option('--workshop <id>', 'mods add: take the mod from this steam workshop item', workshopId)
  },
  '--git': (cmd) => {
    cmd.option('--git <url>', 'mods add: clone the mod from this repository')
  },
  '--branch': (cmd) => {
    cmd.option('--branch <name>', 'mods add: track this git branch')
  },
  '--tag': (cmd) => {
    cmd.option('--tag <name>', 'mods add: pin this git tag')
  },
  '--commit': (cmd) => {
    cmd.option('--commit <sha>', 'mods add: pin this git commit')
  },
  '--subdir': (cmd) => {
    cmd.option('--subdir <path>', 'mods add: the mod folder inside the repository')
  },
  '--global': (cmd) => {
    cmd.option('--global', 'write to the global config')
  },
  '--project': (cmd) => {
    cmd.option('--project', 'write to the project config')
  },
  '--force': (cmd) => {
    cmd.option('--force', 'mods add: overwrite an existing entry; steam build: rebuild even when the buildid matches')
  },
  '--variant': (cmd) => {
    cmd.option('--variant <name>', 'steam build: only this image variant', collect, [])
  },
  '--beta': (cmd) => {
    cmd.option('--beta <name>', 'steam build: only this steam branch', collect, [])
  },
  '--plugin': (cmd) => {
    cmd.option('--plugin <spec>', 'steam build: an explicit plugin package', collect, [])
  },
  '--image': (cmd) => {
    cmd.option('--image <ref>', 'run: launch this gamecrate-built image; steam build: the target repository')
  },
  '--load': (cmd) => {
    cmd.option('--load', 'steam build: load the result into the local docker daemon')
  },
  '--push': (cmd) => {
    cmd.option('--push', 'steam build: push the result to a registry')
  },
  '--base': (cmd) => {
    cmd.option('--base <ref>', 'steam build: override the published runtime base')
  },
  '--platform': (cmd) => {
    cmd.option('--platform <os/arch>', 'steam build: what the manifest claims', 'linux/amd64')
  },
  '--print': (cmd) => {
    cmd.option('--print', 'steam login: also print the session as base64')
  },
  '--username': (cmd) => {
    cmd.option('--username <name>', 'steam login: skip the account name prompt')
  },
  '--help': (cmd) => {
    cmd.option('-h, --help', 'this help')
  },
}

/** The settings every command needs: we own the output, the errors and the help. */
function quiet(cmd: Command): Command {
  return cmd
    .exitOverride()
    .helpOption(false)
    .allowExcessArguments(true)
    .showSuggestionAfterError(false)
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
}

function attach(cmd: Command, names: readonly string[]): Command {
  for (const name of names) OPTIONS[name]?.(cmd)
  return cmd
}

/**
 * A root that carries the run flags, because a bare game name means run, plus one command per
 * verb carrying only its own. enablePositionalOptions is what makes that a fence: without it
 * commander hands a flag typed after a verb back to the root and accepts it.
 */
export function buildProgram(): Command {
  const program = quiet(new Command()).name('gamecrate').enablePositionalOptions().argument('[args...]')
  attach(program, [...RUN_FLAGS, ...GLOBAL_FLAGS, '--supervised'])
  track(program)

  for (const sub of SUBCOMMANDS) {
    if (sub.name === 'run') continue
    const cmd = quiet(program.command(sub.name)).argument('[args...]')
    attach(cmd, [...sub.flags, ...GLOBAL_FLAGS])
    track(cmd)
  }
  return program
}

/** Which command commander matched. Its own opts and args are the ones that count. */
const ACTIVE = new WeakMap<Command, Command>()

function track(cmd: Command): void {
  cmd.action((_args: string[], _opts: unknown, self: Command) => {
    ACTIVE.set(self.parent ?? self, self)
  })
}

/** The matched command, and the positional list as it was typed, verb word included. */
function matched(program: Command): { cmd: Command; positional: string[]; values: Values } {
  const cmd = ACTIVE.get(program) ?? program
  const positional = cmd === program ? [...program.args] : [cmd.name(), ...cmd.args]
  return { cmd, positional, values: { ...program.opts(), ...cmd.opts() } as Values }
}

/** Every command's options, for the checks that have to see the whole vocabulary. */
export function allOptions(program: Command): Option[] {
  return [...program.options, ...program.commands.flatMap((c) => c.options)]
}

/**
 * A refusal worth more than "that verb does not take it", keyed "<verb> <flag>". Commander
 * reports an out-of-scope flag as unknown, so a reason has to be reattached here.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  'shell --detach': 'shell cannot detach: a shell needs the terminal --detach gives up',
}

/** The verbs that declare a flag, for an error that says where it does belong. */
function ownersOf(name: string): string[] {
  const run = (RUN_FLAGS as readonly string[]).includes(name) ? ['run'] : []
  return [...run, ...SUBCOMMANDS.filter((s) => s.name !== 'run' && s.flags.includes(name)).map((s) => s.name)]
}

/**
 * Commander hands a value flag whatever token follows it, and its parsers cannot tell
 * `--mod=-x` from `--mod -x`. Only the separate token can be a mistyped flag.
 */
function checkValueTokens(program: Command, head: string[]): void {
  const valued = (name: string): Option | undefined =>
    allOptions(program).find((o) => (o.long === name || o.short === name) && (o.required || o.optional))

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
    checkValue(option, token, value)
  }
}

function checkValue(option: Option, token: string, value: string): void {
  // --docker-arg is the one flag whose value legitimately starts with a dash.
  if (option.long === '--docker-arg') return
  if (value.startsWith('-') && value.length > 1) {
    throw usage(`${option.long ?? token} needs a value, got the flag ${value}`)
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
  const log = recordFlags(program)
  const { seen, counts, worktree } = log

  checkValueTokens(program, head)
  try {
    program.parse(head, { from: 'user' })
  } catch (error) {
    throw translate(error, program, SUBCOMMANDS.some((x) => x.name === head[0]) ? head[0] : undefined)
  }

  checkRepeats(program, counts)
  checkContradictions(seen)

  const { cmd, positional, values } = matched(program)
  const envBuild = applyEnv(cmd, seen, env, values)

  const out: ParsedArgs = {
    subcommand: 'run',
    mods: (values['mod'] as string[] | undefined) ?? [],
    without: (values['without'] as string[] | undefined) ?? [],
    only: (values['only'] as string[] | undefined) ?? [],
    dockerArgs: (values['dockerArg'] as string[] | undefined) ?? [],
    gameArgs: sep === -1 ? [] : argv.slice(sep + 1),
    dryRun: values['dryRun'] === true,
    printPlan: values['printPlan'] === true,
    json: values['json'] === true,
    root: values['root'] === true,
    yes: values['yes'] === true,
    help: values['help'] === true,
    follow: values['follow'] === true,
    force: values['force'] === true,
    worktree,
    noWorktree: seen.has('--no-worktree'),
    noStaleCheck: seen.has('--no-stale-check'),
    replace: values['replace'] === true,
    noReplace: seen.has('--no-replace'),
    detach: values['detach'] === true,
    noDetach: seen.has('--no-detach'),
    supervised: typeof values['supervised'] === 'string',
    use: (values['use'] as string[] | undefined) ?? [],
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
  out.cleanTier = log.cleanTier
  out.variant = (values['variant'] as string[] | undefined) ?? []
  out.branches = (values['beta'] as string[] | undefined) ?? []
  out.plugin = (values['plugin'] as string[] | undefined) ?? []
  out.image = values['image'] as string | undefined
  out.load = values['load'] === true
  out.push = values['push'] === true
  out.base = values['base'] as string | undefined
  out.platform = (values['platform'] as string | undefined) ?? 'linux/amd64'
  out.print = values['print'] === true
  out.username = values['username'] as string | undefined

  if (opts.defaults?.game !== undefined) out.game = opts.defaults.game

  // --help before completeness, everywhere: you cannot read the help for a verb you already
  // know how to type.
  applyPositionals(out, positional, opts.games, out.help)
  if (out.subcommand === 'mods' && out.subverb !== undefined && !out.help) {
    if (out.subverb === 'add') out.source = modSource(values)
    if (out.subverb !== 'sync') out.target = modTarget(seen, out.subverb)
  }
  if (opts.defaults !== undefined) applyDefaults(out, seen, opts.defaults, sep !== -1)
  return out
}

interface FlagLog {
  seen: Set<string>
  counts: Map<string, number>
  worktree: string[]
  cleanTier?: ParsedArgs['cleanTier']
}

/**
 * Commander keeps no record of how often a flag appeared, or which half of a `--x`/`--no-x`
 * pair the user typed; the events do.
 */
function recordFlags(program: Command): FlagLog {
  const log: FlagLog = { seen: new Set(), counts: new Map(), worktree: [] }
  for (const cmd of [program, ...program.commands]) {
    for (const option of cmd.options) {
    const long = option.long ?? option.flags
    cmd.on(`option:${option.name()}`, (value?: string) => {
      log.seen.add(long)
      log.counts.set(long, (log.counts.get(long) ?? 0) + 1)
      if (long === '--worktree' && value !== undefined) log.worktree.push(value)
      if (long === '--staging' || long === '--logs' || long === '--all' || long === '--downloads') {
        log.cleanTier = long.slice(2) as ParsedArgs['cleanTier']
      }
    })
    }
  }
  return log
}

function checkRepeats(program: Command, counts: Map<string, number>): void {
  for (const option of allOptions(program)) {
    const long = option.long ?? option.flags
    const repeatable = Array.isArray(option.defaultValue)
    if (option.required && !repeatable && (counts.get(long) ?? 0) > 1) {
      throw usage(`${long} given more than once`)
    }
  }
}

function checkContradictions(seen: Set<string>): void {
  if (seen.has('--build') && seen.has('--no-build')) throw usage('--build and --no-build contradict')
  if (seen.has('--replace') && seen.has('--no-replace')) throw usage('--replace and --no-replace contradict')
  if (!seen.has('--detach')) return
  if (seen.has('--no-detach')) throw usage('--detach and --no-detach contradict')
  if (seen.has('--dry-run')) throw usage('--detach and --dry-run contradict')
  if (seen.has('--print-plan')) throw usage('--detach and --print-plan contradict')
}

function policy(value: unknown): BuildPolicy | undefined {
  if (value === true) return 'always'
  if (value === false) return 'never'
  return undefined
}

/** Commander's wording is its own; ours is the one the tests and the docs know. */
function translate(error: unknown, program: Command, verb?: string): unknown {
  if (!(error instanceof CommanderError)) return error
  const token = /'([^']+)'/.exec(error.message)?.[1] ?? ''

  if (error.code === 'commander.unknownOption') {
    const name = token.split('=')[0]!
    const here = (verb === undefined ? program : program.commands.find((c) => c.name() === verb))?.options
    if (here?.some((o) => o.long === name || o.short === name)) return usage(`${name} takes no value`)
    const bespoke = REFUSALS[`${verb ?? 'run'} ${name}`]
    if (bespoke !== undefined) return usage(bespoke)
    const owners = ownersOf(name)
    if (owners.length > 0) {
      return usage(`${verb ?? 'run'} does not take ${name}`, owners.map((o) => `gamecrate ${o}`).join(' or '))
    }
    return usage(`unknown flag ${name}`, suggest(name, flagNames(program)))
  }
  if (error.code === 'commander.optionMissingArgument') {
    return usage(`${token.split(' ')[0]} needs a value`)
  }
  return new GamecrateError(error.message.replace(/^error: /, ''), Exit.Usage)
}

function applyPositionals(out: ParsedArgs, positional: string[], games?: readonly string[], help = false): void {
  const first = positional[0]
  if (first === undefined) {
    if (out.game !== undefined) return
    out.subcommand = 'help'
    out.help = true
    return
  }

  const { sub, slots, rest } = routePositionals(out, first, positional, games)
  const left = fillSlots(out, slots, rest)

  // sync is the only subverb whose game and ids are optional.
  if (!help && (out.subverb === 'add' || out.subverb === 'rm')) {
    if (out.game === undefined) throw usage(`mods ${out.subverb} needs a game`)
    if (out.subverb === 'rm' && out.rest.length === 0) throw usage('mods rm needs at least one mod id')
  }

  // routePositionals falls back to the subcommand's own slots, so an unknown steam subverb would
  // land in the game slot and fail much later.
  if (!help && out.subcommand === 'steam') {
    if (out.subverb === undefined) {
      throw usage('steam needs a subverb', 'gamecrate steam build <game>, or gamecrate steam login')
    }
    if (out.subverb === 'build' && out.game === undefined) throw usage('steam build needs a game')
  }

  if (left.length > 0) {
    const shape = sub ? `${sub.name} ${sub.usage}`.trim() : `${out.game} [profile]`
    throw usage(`unexpected argument ${left[0]}`, `gamecrate ${shape}`)
  }
}

interface Route {
  sub?: SubcommandSpec
  slots: PositionalSlot[]
  rest: string[]
}

function routePositionals(
  out: ParsedArgs,
  first: string,
  positional: string[],
  games?: readonly string[],
): Route {
  const sub = SUBCOMMANDS.find((s) => s.name === first)
  if (!sub) {
    const known = !NAME_PATTERN.test(first) ? false : games === undefined || games.includes(first)
    if (!known) {
      const candidates = [...SUBCOMMANDS.map((s) => s.name), ...(games ?? [])]
      throw usage(`${first} is not a game or a subcommand`, suggest(first, candidates))
    }
    out.subcommand = 'run'
    out.game = first
    return { slots: ['profile', 'rest'], rest: positional.slice(1) }
  }

  out.subcommand = sub.name
  const rest = positional.slice(1)
  const head = rest[0]
  const verbSlots = head === undefined || sub.subverbs === undefined ? undefined : own(sub.subverbs, head)
  if (verbSlots === undefined) return { sub, slots: [...sub.positionals], rest }
  out.subverb = head as NonNullable<ParsedArgs['subverb']>
  rest.shift()
  return { sub, slots: [...verbSlots], rest }
}

/** What is left over after every slot is filled, which is an error at every call site. */
function fillSlots(out: ParsedArgs, slots: PositionalSlot[], rest: string[]): string[] {
  const left = [...rest]
  for (const slot of slots) {
    if (slot === 'rest') {
      out.rest = left
      return []
    }
    const value = left.shift()
    if (value === undefined) break
    if (!NAME_PATTERN.test(value)) throw usage(`${value} is not a valid ${slot} name`)
    if (slot === 'game') out.game = value
    else out.profile = value
  }
  return left
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
    // a var set in the shell is not an instruction to the verb that happens to run next
    if (!program.options.some((o) => o.long === flag)) continue
    const raw = env[name]
    if (raw === undefined || raw === '') continue
    seen.add(flag)

    if (flag === '--build') {
      build = envBuildPolicy(name, raw)
      continue
    }
    applyEnvValue(program, flag, name, raw, values)
  }
  return build
}

function envBuildPolicy(name: string, raw: string): BuildPolicy {
  if (!BUILD_POLICIES.includes(raw as BuildPolicy)) {
    throw usage(`${name} must be one of ${BUILD_POLICIES.join(', ')}, got ${raw}`)
  }
  return raw as BuildPolicy
}

function applyEnvValue(program: Command, flag: string, name: string, raw: string, values: Values): void {
  const option = program.options.find((o) => o.long === flag)
  if (option === undefined) return
  const key = option.attributeName()
  if (!option.required) {
    if (truthy(raw)) values[key] = true
    return
  }
  if (option.argChoices && !option.argChoices.includes(raw)) {
    throw usage(`${name} must be one of ${option.argChoices.join(', ')}, got ${raw}`)
  }
  values[key] = option.parseArg === undefined ? raw : option.parseArg(raw, values[key])
}

function applyDefaults(
  out: ParsedArgs,
  seen: Set<string>,
  defaults: ProjectDefaults,
  hasGameArgs: boolean,
): void {
  applyListDefaults(out, seen, defaults, hasGameArgs)
  applyScalarDefaults(out, defaults)
  applyFlagDefaults(out, seen, defaults)
}

function applyListDefaults(
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
}

function applyScalarDefaults(out: ParsedArgs, defaults: ProjectDefaults): void {
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
}

function applyFlagDefaults(out: ParsedArgs, seen: Set<string>, defaults: ProjectDefaults): void {
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

/** The parent already replaced the previous run, and the only lock left is the child's own. */
export function wantsReplace(args: ParsedArgs, profile: ProfileConfig): boolean {
  return !args.supervised && !args.noReplace && (args.replace || profile.replace === true)
}

/** Three-way, so first defined wins. --no-build already arrives as 'never'. */
export function buildPolicy(args: ParsedArgs, profile: ProfileConfig): BuildPolicy {
  return args.build ?? profile.build ?? 'auto'
}

function truthy(value: string): boolean {
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

function flagNames(program: Command): string[] {
  return allOptions(program).flatMap((o) => [o.long, o.short].filter((f): f is string => f !== undefined))
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

function workshopId(value: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw usage(`--workshop takes a positive workshop item id, got ${value}`)
  }
  return n
}

const REF_FLAGS = ['branch', 'tag', 'commit'] as const

/** `mods add` carries exactly one source, and the git-only flags only ride along with --git. */
function modSource(values: Values): NonNullable<ParsedArgs['source']> {
  const path = values['path'] as string | undefined
  const workshop = values['workshop'] as number | undefined
  const url = values['git'] as string | undefined
  const subdir = values['subdir'] as string | undefined
  const refs = REF_FLAGS.filter((name) => values[name] !== undefined)

  const kinds = [
    ['--path', path],
    ['--workshop', workshop],
    ['--git', url],
  ].filter(([, value]) => value !== undefined).map(([flag]) => flag as string)
  if (kinds.length === 0) throw usage('mods add needs one of --path, --workshop or --git')
  if (kinds.length > 1) throw usage(`${kinds[0]} and ${kinds[1]} contradict: a source has one kind`)

  if (url === undefined) {
    let stray: string | undefined
    if (refs[0] !== undefined) stray = `--${refs[0]}`
    else if (subdir !== undefined) stray = '--subdir'
    if (stray !== undefined) throw usage(`${stray} only applies to a --git source`)
  }
  if (refs.length > 1) throw usage(`--${refs[0]} and --${refs[1]} contradict: a git source has one ref`)
  if (subdir !== undefined) checkSubdir(subdir)

  if (path !== undefined) return { kind: 'path', value: path }
  if (workshop !== undefined) return { kind: 'workshop', value: workshop }

  const source: Extract<NonNullable<ParsedArgs['source']>, { kind: 'git' }> = { kind: 'git', url: url! }
  const ref = refs[0]
  if (ref !== undefined) source.ref = { kind: ref, value: values[ref] as string }
  if (subdir !== undefined) source.subdir = subdir
  return source
}

function checkSubdir(subdir: string): void {
  if (subdir.startsWith('/')) throw usage(`--subdir is a path inside the repository, got ${subdir}`)
  if (subdir.split('/').includes('..')) throw usage(`--subdir cannot climb out of the repository, got ${subdir}`)
}

function modTarget(seen: Set<string>, verb: string): 'global' | 'project' {
  const global = seen.has('--global')
  const project = seen.has('--project')
  if (global && project) throw usage('--global and --project contradict: a write lands in one config')
  if (!global && !project) throw usage(`mods ${verb} needs --global or --project`)
  return global ? 'global' : 'project'
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
  instanceDir: string,
  self: string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const bin = self[1]?.startsWith('/$bunfs/') === true ? [execPath] : [execPath, self[1]!]
  const sep = userArgs.indexOf('--')
  // appended, never swapped for --detach: a project or profile detach: true never types a flag,
  // and a child that does not carry --supervised forks a supervisor of its own, forever.
  const head = [
    ...(sep === -1 ? userArgs : userArgs.slice(0, sep)).filter((arg) => arg !== '--detach'),
    '--supervised',
    instanceDir,
  ]
  const tail = sep === -1 ? [] : userArgs.slice(sep)
  return [...bin, ...head, ...tail]
}

/** Read straight off argv: the recovery path runs before anything is parsed or loaded. */
export function supervisedDir(argv: string[]): string | undefined {
  const sep = argv.indexOf('--')
  const head = sep === -1 ? argv : argv.slice(0, sep)
  const at = head.indexOf('--supervised')
  return at === -1 ? undefined : head[at + 1]
}
