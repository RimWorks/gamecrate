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

export type PositionalSlot = 'profile' | 'rest'

/** Help sections. A verb with no group lands in `meta`. */
export type VerbGroup = 'launch' | 'inspect' | 'build' | 'maintain' | 'meta'

export const VERB_GROUPS: readonly { name: VerbGroup; title: string }[] = [
  { name: 'launch', title: 'Start a game and control a run' },
  { name: 'inspect', title: 'See what a profile gives you' },
  { name: 'build', title: 'Build images and mods' },
  { name: 'maintain', title: 'Clean up and check your setup' },
  { name: 'meta', title: 'About gamecrate itself' },
]

/** A nested verb: `mods add`, `steam build`. Carries its own help and its own flags. */
export interface SubverbSpec {
  summary: string
  /** Rendered after `<parent> <subverb>` in usage lines. */
  usage: string
  positionals: PositionalSlot[]
  /** Flag names this subverb alone accepts, beyond the global set. */
  flags: readonly string[]
}

export interface SubcommandSpec {
  name: string
  group: VerbGroup
  summary: string
  /** Rendered after the subcommand word in usage lines. */
  usage: string
  positionals: PositionalSlot[]
  /** Flag names beyond the global set, in the order help should show them. */
  flags: readonly string[]
  /** Nested verbs, matched against the word after the subcommand. */
  subverbs?: Readonly<Record<string, SubverbSpec>>
  /** Refuse the bare form and print help instead, for a verb that is only a namespace. */
  needsSubverb?: true
}

export const RUN_FLAGS = [
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
  '--quiet',
  '--plain',
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
    group: 'launch',
    summary: "Stage a profile's mods and start the game",
    usage: '[profile]',
    positionals: ['profile'],
    flags: RUN_FLAGS,
  },
  {
    name: 'list',
    group: 'inspect',
    summary: 'List the games and profiles, and where each is defined',
    usage: '',
    positionals: [],
    flags: [],
  },
  {
    name: 'mods',
    group: 'inspect',
    summary: 'List the mods a profile loads, or edit the library behind it',
    usage: '[profile]',
    positionals: ['profile'],
    subverbs: {
      add: {
        summary: 'Add one mod source to the library',
        usage: '<source>',
        positionals: [],
        flags: [
          '--path', '--workshop', '--git', '--branch', '--tag', '--commit', '--subdir',
          '--global', '--project', '--force',
        ],
      },
      rm: {
        summary: 'Remove mod sources from the library by id',
        usage: '<id>...',
        positionals: ['rest'],
        flags: ['--global', '--project'],
      },
      sync: {
        summary: 'Refetch each git and workshop source',
        usage: '[id]...',
        positionals: ['rest'],
        flags: [],
      },
    },
    flags: ['--mod', '--without', '--only', '--sort'],
  },
  {
    name: 'refs',
    group: 'inspect',
    summary: "Print a path to the game's DLLs, to reference from a csproj",
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--image'],
  },
  {
    name: 'init',
    group: 'maintain',
    summary: 'Set up a config: pick a game, install its plugin, write a profile',
    usage: '',
    positionals: [],
    flags: ['--yes', '--project'],
  },
  {
    name: 'doctor',
    group: 'maintain',
    summary: 'Check docker, logins, game folders and permissions',
    usage: '',
    positionals: [],
    flags: [],
  },
  {
    name: 'clean',
    group: 'maintain',
    summary: "Delete a profile's staged mods, logs, saves or downloads",
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--staging', '--logs', '--all', '--downloads', '--yes', '--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'clone',
    group: 'maintain',
    summary: "Copy one profile's saves and settings to another profile",
    usage: '<src> <dst>',
    positionals: ['rest'],
    flags: ['--yes'],
  },
  {
    name: 'logs',
    group: 'inspect',
    summary: 'Print the log the last run captured',
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--instance', '--worktree', '--no-worktree', '--follow'],
  },
  {
    name: 'attach',
    group: 'launch',
    summary: 'Watch a background run. Ctrl-c leaves the game running',
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'wait',
    group: 'launch',
    summary: 'Wait for a background run to end, then exit with its code',
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'ps',
    group: 'launch',
    summary: 'List the runs going now, with their profile and uptime',
    usage: '',
    positionals: [],
    flags: [],
  },
  {
    name: 'stop',
    group: 'launch',
    summary: 'Stop a background run and free the profile it holds',
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'build',
    group: 'build',
    summary: 'Build or pull the runtime image without starting the game',
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--pull', '--image'],
  },
  {
    name: 'steam',
    group: 'build',
    summary: 'Build a game image from Steam, or log in to Steam',
    usage: '',
    positionals: [],
    needsSubverb: true,
    subverbs: {
      build: {
        summary: 'Download the game from Steam and build an image',
        usage: '',
        positionals: [],
        flags: [
          '--variant', '--beta', '--alias', '--image', '--plugin',
          '--load', '--push', '--base', '--platform', '--force', '--plain',
        ],
      },
      login: {
        summary: 'Save a Steam session so a build can download the game',
        usage: '',
        positionals: [],
        flags: ['--print', '--username'],
      },
    },
    flags: [],
  },
  {
    name: 'shell',
    group: 'launch',
    summary: 'Open a bash prompt in the container, with the same mods',
    usage: '[profile]',
    positionals: ['profile'],
    flags: [
      '--mod', '--without', '--only', '--docker-arg', '--root',
      '--worktree', '--no-worktree', '--instance', '--use', '--replace', '--log', '--quiet',
    ],
  },
  {
    name: 'verify',
    group: 'inspect',
    summary: 'Check which mods a live run loaded, and whether they are current',
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--instance', '--worktree', '--no-worktree'],
  },
  {
    name: 'config',
    group: 'maintain',
    summary: 'Read and edit the gamecrate config files',
    usage: '',
    positionals: ['rest'],
    needsSubverb: true,
    subverbs: {
      edit: {
        summary: 'Open the global config in an editor and check it on save',
        usage: '',
        positionals: [],
        flags: [],
      },
    },
    flags: [],
  },
  {
    name: 'fix-perms',
    group: 'maintain',
    summary: 'Give yourself back any profile file another user owns',
    usage: '[profile]',
    positionals: ['profile'],
    flags: ['--yes', '--dry-run'],
  },
  {
    name: 'help',
    group: 'meta',
    summary: 'Show help for a subcommand or a game',
    usage: '[topic]',
    positionals: ['rest'],
    flags: [],
  },
  {
    name: 'version',
    group: 'meta',
    summary: 'Print the gamecrate version',
    usage: '',
    positionals: [],
    flags: [],
  },
  {
    name: 'completion',
    group: 'meta',
    summary: 'Print a completion script for bash or zsh',
    usage: '<bash|zsh>',
    positionals: ['rest'],
    flags: [],
  },
]

/** Shown for every subcommand. */
export const GLOBAL_FLAGS = ['--game', '--json', '--help'] as const

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

function enumOption(flags: string, summary: string, values: readonly string[]): Option {
  const long = flags.split(/[ ,]+/).find((token) => token.startsWith('--'))!
  return new Option(flags, summary).choices([...values]).argParser(choice(long, values))
}

const OPTIONS: Readonly<Record<string, (cmd: Command) => unknown>> = {
  '--mod': (cmd) => cmd.option('--mod <id>', 'Add one more mod to what the profile loads', collect, []),
  '--without': (cmd) => cmd.option('--without <id>', 'Leave one mod out of what the profile loads', collect, []),
  '--only': (cmd) => cmd.option('--only <id>', 'Load only these mods and none of the rest', collect, []),
  '--worktree': (cmd) => cmd.option( '--worktree <path>', 'Load mods from this git checkout, in its own instance ($GAMECRATE_WORKTREE)', collect, []),
  '--use': (cmd) => cmd.option('--use <packageId>=<path>', 'Load this one mod from this directory, whatever the profile says', collect, []),
  '--no-worktree': (cmd) => cmd.option('--no-worktree', 'Ignore the current git checkout and $GAMECRATE_WORKTREE'),
  '--instance': (cmd) => cmd.option('--instance <name>', 'Run a second named copy with its own saves, logs and container'),
  '--mode': (cmd) => cmd.addOption(enumOption(`--mode <${MODES.join('|')}>`, 'Show a game window, hide it, or take one screenshot', MODES)),
  '--marker': (cmd) => cmd.option('--marker <str>', 'Exit 0 as soon as this text appears in the game log'),
  '--timeout': (cmd) => cmd.option('--timeout <seconds>', 'Stop a marker or headless run after this many seconds', (v) => seconds('--timeout', v)),
  '--render-wait': (cmd) => cmd.option('--render-wait <seconds>', 'Seconds to let the game draw before the screenshot', (v) => seconds('--render-wait', v)),
  '--resolution': (cmd) => cmd.option('--resolution <width>x<height>', 'Set the game window size, like 1920x1080', parseResolution),
  '--network': (cmd) => cmd.addOption( enumOption(`--network <${NETWORK_POLICIES.join('|')}>`, "The container's network. host lets a mod serve a port", NETWORK_POLICIES)),
  '--log': (cmd) => cmd.option('--log <path>', 'Also write everything the run prints to this file'),
  '--quiet': (cmd) => cmd.option('-q, --quiet', 'Print nothing to the terminal. --log still gets everything'),
  '--plain': (cmd) => cmd.option('--plain', 'Plain scrolling output instead of the live dashboard'),
  '--pull': (cmd) => cmd.addOption( enumOption(`--pull <${PULL_POLICIES.join('|')}>`, 'When to pull the runtime image from its registry', PULL_POLICIES)),
  '--build': (cmd) => cmd.option('--build', 'Compile the local C# mods before launching'),
  '--no-build': (cmd) => cmd.option('--no-build', "Never compile, even when a mod's DLL is out of date"),
  '--no-stale-check': (cmd) => cmd.option('--no-stale-check', "Do not warn when a mod's code is newer than its DLL"),
  '--replace': (cmd) => cmd.option('--replace', 'Stop whatever already holds this profile, then launch'),
  '--no-replace': (cmd) => cmd.option('--no-replace', 'Refuse to launch when this profile already runs'),
  '--detach': (cmd) => cmd.option('--detach', 'Run in the background and give the prompt back'),
  '--no-detach': (cmd) => cmd.option('--no-detach', 'Stay in the foreground, whatever the config asks for'),
  '--supervised': (cmd) => cmd.addOption(new Option('--supervised <instanceDir>').hideHelp()),
  '--sort': (cmd) => cmd.addOption( enumOption(`--sort <${SORTS.join('|')}>`, 'Load order: as the profile lists them, or by dependency', SORTS)),
  '--docker-arg': (cmd) => cmd.option('--docker-arg <arg>', 'One extra argument to pass to docker run', collect, []),
  '--dry-run': (cmd) => cmd.option('--dry-run', 'Resolve and check everything, write nothing'),
  '--print-plan': (cmd) => cmd.option('--print-plan', 'Print what the launch would do instead of launching'),
  '--game': (cmd) => cmd.option('--game <name>', 'The game to act on, when no profile says which'),
  '--json': (cmd) => cmd.option('--json', 'Print JSON instead of text'),
  '--root': (cmd) => cmd.option('--root', 'Run as root in the container instead of as you'),
  '--staging': (cmd) => cmd.option('--staging', 'Delete the staged copies of the mods only (the default)'),
  '--logs': (cmd) => cmd.option('--logs', 'Delete the logs the runs captured'),
  '--all': (cmd) => cmd.option('--all', 'Delete the whole profile and the game downloads (needs --yes)'),
  '--downloads': (cmd) => cmd.option('--downloads', 'Delete this game\'s workshop downloads, keeping steamcmd'),
  '--follow': (cmd) => cmd.option('-f, --follow', 'Keep printing as the run writes more'),
  '--yes': (cmd) => cmd.option('-y, --yes', 'Answer yes to the confirmation prompt'),
  '--path': (cmd) => cmd.option('--path <dir>', 'Take the mod from this directory'),
  '--workshop': (cmd) => cmd.option('--workshop <id>', 'Take the mod from this Steam Workshop item', workshopId),
  '--git': (cmd) => cmd.option('--git <url>', 'Clone the mod from this git repository'),
  '--branch': (cmd) => cmd.option('--branch <name>', 'Follow this git branch'),
  '--tag': (cmd) => cmd.option('--tag <name>', 'Pin to this git tag'),
  '--commit': (cmd) => cmd.option('--commit <sha>', 'Pin to this git commit'),
  '--subdir': (cmd) => cmd.option('--subdir <path>', 'The mod folder inside the repository'),
  '--global': (cmd) => cmd.option('--global', 'Write to the global config in ~/.config/gamecrate'),
  '--project': (cmd) => cmd.option('--project', 'Write to the .gamecrate config beside your code'),
  '--force': (cmd) => cmd.option('--force', 'Overwrite an existing mod entry, or rebuild an image anyway'),
  '--variant': (cmd) => cmd.option('--variant <name>', 'Build only this image variant', collect, []),
  '--beta': (cmd) => cmd.option('--beta <name>', 'Build only this Steam branch', collect, []),
  '--alias': (cmd) => cmd.option('--alias <tag>', 'One more moving tag to put on each branch built', collect, []),
  '--plugin': (cmd) => cmd.option('--plugin <spec>', 'Name the plugin package to use', collect, []),
  '--image': (cmd) => cmd.option('--image <ref>', 'The image to launch, or the repository a steam build tags'),
  '--load': (cmd) => cmd.option('--load', 'Load the built image into the local docker daemon'),
  '--push': (cmd) => cmd.option('--push', 'Push the built image to a registry'),
  '--base': (cmd) => cmd.option('--base <ref>', 'Build on this runtime base instead of the published one'),
  '--platform': (cmd) => cmd.option('--platform <os/arch>', 'The os and arch the built manifest claims', 'linux/amd64'),
  '--print': (cmd) => cmd.option('--print', 'Also print the session as base64'),
  '--username': (cmd) => cmd.option('--username <name>', 'Use this account name and skip the prompt'),
  '--help': (cmd) => cmd.option('-h, --help', 'Show this help'),
}

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
 * A root that carries the run flags, plus one command per verb carrying only its own.
 */
export function buildProgram(): Command {
  const program = quiet(new Command()).name('gamecrate').enablePositionalOptions().argument('[args...]')
  attach(program, [...RUN_FLAGS, ...GLOBAL_FLAGS, '--supervised'])
  track(program)

  for (const sub of SUBCOMMANDS) {
    if (sub.name === 'run') continue
    const cmd = quiet(program.command(sub.name)).argument('[args...]')
    attach(cmd, [...subtreeFlags(sub), ...GLOBAL_FLAGS])
    track(cmd)
  }
  return program
}

/**
 * A verb accepts its own flags plus every one of its subverbs', because commander matches one
 * word. `checkSubverbScope` is what narrows that back down to the subverb that was actually named.
 */
export function subtreeFlags(sub: SubcommandSpec): readonly string[] {
  const seen = new Set<string>(sub.flags)
  for (const spec of Object.values(sub.subverbs ?? {})) for (const name of spec.flags) seen.add(name)
  return [...seen]
}

const ACTIVE = new WeakMap<Command, Command>()

function track(cmd: Command): void {
  cmd.action((_args: string[], _opts: unknown, self: Command) => {
    ACTIVE.set(self.parent ?? self, self)
  })
}

function matched(program: Command): { cmd: Command; positional: string[]; values: Values } {
  const cmd = ACTIVE.get(program) ?? program
  const positional = cmd === program ? [...program.args] : [cmd.name(), ...cmd.args]
  return { cmd, positional, values: { ...program.opts(), ...cmd.opts() } as Values }
}

/** Every command's options, for the checks that have to see the whole vocabulary. */
export function allOptions(program: Command): Option[] {
  return [...program.options, ...program.commands.flatMap((c) => c.options)]
}

let publicCache: readonly Option[] | undefined

/**
 * Every flag a person can type, deduplicated. Built once: completion asks per word typed, and
 * rebuilding the whole program each time showed up as lag.
 */
export function publicOptions(): readonly Option[] {
  if (publicCache !== undefined) return publicCache
  const seen = new Set<string>()
  publicCache = allOptions(buildProgram()).filter((o) => {
    const long = o.long ?? o.flags
    if (o.hidden || seen.has(long)) return false
    seen.add(long)
    return true
  })
  return publicCache
}

const REFUSALS: Readonly<Record<string, string>> = {
  'shell --detach': 'shell cannot detach: a shell needs the terminal --detach gives up',
}

function ownersOf(name: string): string[] {
  const run = (RUN_FLAGS as readonly string[]).includes(name) ? ['run'] : []
  const owners = SUBCOMMANDS.flatMap((s) => {
    if (s.name === 'run') return []
    const here = s.flags.includes(name) ? [s.name] : []
    const nested = Object.entries(s.subverbs ?? {})
      .filter(([, spec]) => spec.flags.includes(name))
      .map(([verb]) => `${s.name} ${verb}`)
    return [...here, ...nested]
  })
  return [...run, ...owners]
}

function checkSubverbScope(out: ParsedArgs, seen: Set<string>): void {
  const sub = SUBCOMMANDS.find((s) => s.name === out.subcommand)
  if (sub?.subverbs === undefined || out.subverb === undefined) return
  const spec = own(sub.subverbs, out.subverb)
  if (spec === undefined) return

  const allowed = new Set<string>([...spec.flags, ...sub.flags, ...GLOBAL_FLAGS])
  for (const name of seen) {
    if (allowed.has(name)) continue
    const owners = ownersOf(name).filter((o) => o !== sub.name)
    const hint = owners.length > 0 ? owners.map((o) => `gamecrate ${o}`).join(' or ') : undefined
    throw usage(`${sub.name} ${out.subverb} does not take ${name}`, hint)
  }
}

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
    if (value === undefined) return
    checkValue(option, token, value)
  }
}

function checkValue(option: Option, token: string, value: string): void {
  if (option.long === '--docker-arg') return
  if (value.startsWith('-') && value.length > 1) {
    throw usage(`${option.long ?? token} needs a value, got the flag ${value}`)
  }
}

/** The names each game's profiles answer to, aliases included. */
export type ProfileMap = Readonly<Record<string, readonly string[]>>

export interface ParseOptions {
  env?: Record<string, string | undefined>
  defaults?: ProjectDefaults
  /** Game names from the loaded config; enables did-you-mean on the first positional. */
  games?: readonly string[]
  /** Profiles per game, so a profile alone can say which game it belongs to. */
  profiles?: ProfileMap
}

function gamesDeclaring(name: string, profiles?: ProfileMap): string[] {
  if (profiles === undefined) return []
  const lower = name.toLowerCase()
  return Object.keys(profiles).filter((game) =>
    (own(profiles, game) ?? []).some((profile) => profile.toLowerCase() === lower),
  )
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
    const verb = head[0]
    if (verb !== undefined && !verb.startsWith('-') && !SUBCOMMANDS.some((x) => x.name === verb)) {
      refuseFirstWord(verb, opts)
    }
    throw translate(error, program, verb !== undefined && SUBCOMMANDS.some((x) => x.name === verb) ? verb : undefined)
  }

  checkRepeats(program, counts)
  checkContradictions(seen)

  const { cmd, positional, values } = matched(program)
  const envBuild = applyEnv(cmd, seen, env, values)

  const out: ParsedArgs = {
    subcommand: 'run',
    verbTyped: false,
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
    quiet: values['quiet'] === true,
    plain: values['plain'] === true,
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
  out.game = values['game'] as string | undefined
  out.build = envBuild ?? policy(values['build'])
  out.cleanTier = log.cleanTier
  out.variant = (values['variant'] as string[] | undefined) ?? []
  out.branches = (values['beta'] as string[] | undefined) ?? []
  out.aliases = (values['alias'] as string[] | undefined) ?? []
  out.plugin = (values['plugin'] as string[] | undefined) ?? []
  out.image = values['image'] as string | undefined
  out.load = values['load'] === true
  out.push = values['push'] === true
  out.base = values['base'] as string | undefined
  out.platform = (values['platform'] as string | undefined) ?? 'linux/amd64'
  out.print = values['print'] === true
  out.username = values['username'] as string | undefined

  applyPositionals(out, positional, seen, opts, out.help)
  applyTargets(out, values, seen)

  if (opts.defaults !== undefined) applyDefaults(out, seen, opts.defaults, sep !== -1)
  return out
}

function applyTargets(out: ParsedArgs, values: Values, seen: Set<string>): void {
  if (out.subcommand === 'mods' && out.subverb !== undefined && !out.help) {
    if (out.subverb === 'add') out.source = modSource(values)
    if (out.subverb !== 'sync') out.target = modTarget(seen, out.subverb)
  }
  if (out.subcommand === 'init' && seen.has('--project')) out.target = 'project'
}

interface FlagLog {
  seen: Set<string>
  counts: Map<string, number>
  worktree: string[]
  cleanTier?: NonNullable<ParsedArgs['cleanTier']>
}

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

function translate(error: unknown, program: Command, verb?: string): unknown {
  if (!(error instanceof CommanderError)) return error
  const token = /'([^']+)'/.exec(error.message)?.[1] ?? ''

  if (error.code === 'commander.unknownOption') {
    const name = token.split('=')[0]!
    const owner = verb === undefined || verb === 'run' ? program : program.commands.find((c) => c.name() === verb)
    const here = owner?.options
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

function applyPositionals(
  out: ParsedArgs,
  positional: string[],
  seen: Set<string>,
  opts: ParseOptions,
  help = false,
): void {
  const first = positional[0]
  if (first === undefined) {
    // A project config can name a game, but a launch that --replace rides on gets typed on
    // purpose. `gamecrate run` is the no-argument form. The supervisor is already past this.
    if (out.supervised) {
      inferGame(out, opts)
      if (out.game !== undefined) return
    }
    out.subcommand = 'help'
    out.help = true
    out.game = undefined
    return
  }

  const { sub, slots, rest } = routePositionals(out, first, positional, opts)
  const left = fillSlots(out, slots, rest)
  inferGame(out, opts)

  // scope first: a flag that belongs to another verb means the whole line is misaddressed,
  // which is worth more than a missing argument for the verb they did not want.
  if (!help && !out.help) {
    checkSubverbScope(out, seen)
    requireSubverbArgs(out)
  }

  if (left.length > 0) {
    throw usage(`unexpected argument ${left[0]}`, `gamecrate ${shapeOf(sub, out.subverb)}`)
  }
}

/** The usage shape for whatever was routed to, subverb included when one matched. */
export function shapeOf(sub: SubcommandSpec, subverb?: string): string {
  const spec = subverb === undefined ? undefined : sub.subverbs?.[subverb]
  if (spec === undefined) return `${sub.name} ${sub.usage}`.trim()
  return `${sub.name} ${subverb} ${spec.usage}`.trim()
}

/** What a subverb needs beyond its slots. Missing here beats failing deep in a launch. */
function requireSubverbArgs(out: ParsedArgs): void {
  if (out.subverb === 'rm' && out.rest.length === 0) throw usage('mods rm needs at least one mod id')
}

interface Route {
  sub: SubcommandSpec
  subverb?: SubverbSpec
  slots: PositionalSlot[]
  rest: string[]
}

/** Every word that is not a subcommand, refused the same way whether a flag or a slot found it. */
export function refuseFirstWord(first: string, opts: ParseOptions): never {
  const { profiles } = opts
  if (NAME_PATTERN.test(first) && (first === 'modless' || gamesDeclaring(first, profiles).length > 0)) {
    throw new GamecrateError(`${first} is a profile, not a subcommand`, Exit.Usage, `run it with: gamecrate run ${first}`)
  }
  const declared = profiles?.[first]
  if (declared !== undefined) {
    throw new GamecrateError(
      `${first} is a game, not a subcommand`,
      Exit.Usage,
      declared.length === 0
        ? `it declares no profiles yet. add one under games.${first}.profiles`
        : `run one of its profiles: ${declared.join(', ')}`,
    )
  }
  throw usage(`${first} is not a subcommand`, suggest(first, SUBCOMMANDS.map((s) => s.name)))
}

function routePositionals(
  out: ParsedArgs,
  first: string,
  positional: string[],
  opts: ParseOptions,
): Route {
  const sub = SUBCOMMANDS.find((s) => s.name === first)
  if (!sub) refuseFirstWord(first, opts)

  out.subcommand = sub.name
  out.verbTyped = true
  const rest = positional.slice(1)
  const head = rest[0]
  const spec = head === undefined || sub.subverbs === undefined ? undefined : own(sub.subverbs, head)

  if (spec === undefined) {
    // A namespace verb has no bare form, so an empty tail is a request for orientation and a
    // word that named no subverb is a typo worth a suggestion.
    if (sub.needsSubverb === true && sub.subverbs !== undefined) {
      const names = Object.keys(sub.subverbs)
      if (head === undefined) {
        out.help = true
        return { sub, slots: [], rest: [] }
      }
      const hit = suggest(head, names)
      const shapes = names.map((verb) => `gamecrate ${shapeOf(sub, verb)}`).join(', ')
      throw usage(
        `${sub.name} has no subverb ${head}`,
        hit === undefined ? shapes : `gamecrate ${shapeOf(sub, hit)}`,
      )
    }
    return { sub, slots: [...sub.positionals], rest }
  }

  out.subverb = head as NonNullable<ParsedArgs['subverb']>
  rest.shift()
  return { sub, subverb: spec, slots: [...spec.positionals], rest }
}

function inferGame(out: ParsedArgs, opts: ParseOptions): void {
  if (out.game !== undefined) return
  const named = out.profile ?? out.rest[0]
  const owners = named === undefined ? [] : gamesDeclaring(named, opts.profiles)
  if (owners.length > 0) {
    out.game = pickOwner(named!, owners, opts.defaults?.game)
    return
  }
  const all = opts.games ?? []
  out.game = opts.defaults?.game ?? (all.length === 1 ? all[0] : undefined)
}

function pickOwner(name: string, owners: readonly string[], preferred?: string): string {
  if (owners.length === 1) return owners[0]!
  if (preferred !== undefined && owners.includes(preferred)) return preferred
  const picks = owners.map((game) => `--game ${game}`).join(' or ')
  throw new GamecrateError(
    `${owners.length} games declare a profile named ${name}: ${owners.join(', ')}`,
    Exit.Usage,
    `pass --game to pick one: ${picks}`,
  )
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
    out.profile = value
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
