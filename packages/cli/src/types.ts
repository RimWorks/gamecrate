import type { GamePlugin } from './plugin'

/**
 * Shared contract for every module. Units code against this and nothing else;
 * if a signature here is wrong, fix it here rather than working around it locally.
 */

// ---------------------------------------------------------------- exit codes

export const Exit = {
  Ok: 0,
  GameFailed: 1,
  Usage: 2,
  Config: 3,
  Resolution: 4,
  Environment: 5,
  MarkerTimeout: 6,
  /** Refused: this profile+instance is already running. `--replace` is the way past it. */
  Refused: 7,
  /** `verify`: a bound mod's sources are newer than its assemblies. */
  Stale: 8,
  Interrupted: 130,
} as const

export type ExitCode = (typeof Exit)[keyof typeof Exit]

export type ExitReason =
  | 'exited'
  | 'marker'
  | 'marker-timeout'
  | 'stopped'
  | 'window-closed'
  | 'timeout'
  /** The run never reached docker: staging, a pull or a build failed. */
  | 'failed'

export interface LaunchResult {
  code: number
  reason: ExitReason
}

/** 130 means runContainer caught a signal and stopped the container, not that the game died. */
export function reasonFor(code: number): ExitReason {
  return code === Exit.Interrupted ? 'stopped' : 'exited'
}

/** Every failure the tool raises deliberately. Anything else is a bug. */
export class GamecrateError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'GamecrateError'
  }
}

/** Collected and reported together, so one run surfaces every problem at once. */
export interface Problem {
  /** JSON Pointer into the global config, or a file path, or a mod id. */
  where: string
  message: string
  /** Populated by did-you-mean matching where it applies. */
  suggestion?: string
}

// -------------------------------------------------------------------- config

export type ModeName = 'headed' | 'headless' | 'screenshot'
export type PullPolicy = 'always' | 'missing' | 'never'
export type BuildPolicy = 'auto' | 'always' | 'never'
export type NetworkPolicy = 'none' | 'bridge' | 'host'
export type DisplayBackend = 'x11' | 'wayland'

export interface Settings {
  width: number
  height: number
  devMode: boolean
  runInBackground: boolean
  /** Forced false when written; see landmine 5. */
  resetModsConfigOnCrash: boolean
  gpu: boolean
  audio: boolean
  input: boolean
  network: NetworkPolicy
  /** Which display server a headed run talks to. x11 is the one an outside tool can retitle. */
  display: DisplayBackend
  memory: string
  cpus: number
  pidsLimit: number
  /** Verbatim passthrough into the generated Prefs file. */
  prefsExtra?: Record<string, string>
  gameArgs?: string[]
  dockerArgs?: string[]
}

export interface GameFilesSpec {
  source: 'mount' | 'image'
  /** Required when source is "mount". */
  host?: string
  container: string
}

export interface ImageSpec {
  ref: string
  acquire: 'pull' | 'build'
  /** Required when acquire is "build". */
  context?: string
}

/** How the engine is told where its data directory is. Verified per game. */
export type DataDirSpec =
  | { container: string; mode: 'arg'; arg: string }
  | { container: string; mode: 'env'; env: Record<string, string> }

export interface ModsDirSpec {
  /** Where the staged mod tree is bind-mounted. NOT necessarily under dataDir. */
  container: string
  /** Extra mod roots inside the image that must be masked with a tmpfs. */
  mask?: string[]
}

export type LogFileSpec =
  | { mode: 'arg'; arg: string }
  | { mode: 'copy-out'; from: string }

export interface ScanRoot {
  path: string
  maxDepth: number
  exclude?: string[]
}

export interface LibraryEntry {
  workshop?: number
  path?: string
  git?: string
  branch?: string
  tag?: string
  commit?: string
  subdir?: string
}

/** Matches a family of mods by pattern instead of naming each one. */
export interface DynamicModEntry {
  match: string
  first?: string[]
  sort?: 'alpha' | 'none'
  minMatches?: number
}

export interface ModEntryObject {
  id: string
  workshop?: number
  path?: string
  optional?: boolean
}

/** A bare string is a packageId; `workshop:` and `path:` prefixes disambiguate. */
export type ModEntry = string | ModEntryObject | DynamicModEntry

/**
 * A named sub-run of a profile with its own data directory, lock and container, so several
 * can run at once. Selected with `--instance`, or derived from an explicit `--worktree`.
 */
export interface InstanceConfig {
  /** Promoted ahead of every other worktree request when this instance is selected. */
  worktree?: string
  settings?: Partial<Settings>
}

export interface ProfileConfig {
  mods?: ModEntry[]
  extends?: string
  exclude?: string[]
  includeBase?: boolean
  /** Default true. False keeps the mod list literal, dependencies and all. */
  autoDependencies?: boolean
  settings?: Partial<Settings>
  instances?: Record<string, InstanceConfig>
  /** Marks this profile as another name for an existing one. */
  alias?: string
  /** Extra names this profile answers to, so one entry covers several spellings. */
  aliases?: string[]
  /** A one-line note for `gamecrate list`. Never read by the launcher. */
  description?: string
  /** Launch defaults for this profile. The matching --no-* flag overrides each one. */
  detach?: boolean
  replace?: boolean
  build?: BuildPolicy
}

/** One image built from a steam depot. The first entry of `variants` is the default. */
export interface SteamVariant {
  name: string
  depot?: 'linux' | 'windows' | 'macos'
  base: 'xvfb' | 'proton' | 'none'
  include: string[]
  executable?: string
}

/** A steam branch to download from. The first entry of `branches` is the default. */
export interface SteamBranch {
  name: string
  password?: boolean
  /** Extra moving tags for this branch, beside the version and `latest` forms. */
  tags?: string[]
}

/** How a plugin's game image gets built from steam. */
export interface SteamBuildSpec {
  branches: SteamBranch[]
  variants: SteamVariant[]
}

export interface GameConfig {
  gameFiles: GameFilesSpec
  dataDir: DataDirSpec
  modsDir: ModsDirSpec
  logFile: LogFileSpec
  image: ImageSpec
  executable: string
  steamAppId: number
  workshopRoot: string | null
  scanRoots: ScanRoot[]
  manifest: { file: string }
  modsConfig: { file: string }
  prefs: { file: string }
  /** Where the engine writes its version string. */
  version: { file: string }
  steamBuild: SteamBuildSpec
  /** Filename suffixes that mean "a save". `clean --all` counts them before it deletes. */
  saveExtensions: string[]
  core: string
  dlc: string[]
  preCore?: string[]
  base?: string[]
  library?: Record<string, LibraryEntry>
  modes: ModeName[]
  aliases?: Record<string, string>
  settings?: Partial<Settings>
  /** The engine claims WM_DELETE_WINDOW and drops it, so the titlebar X does nothing. */
  ignoresWmDelete?: boolean
  profiles: Record<string, ProfileConfig>
}

export interface RootConfig {
  /** Package names or paths, resolved from the config file's directory. One per game. */
  plugins?: string[]
  dataRoot: string
  defaults?: { settings?: Partial<Settings> }
  /** Where the steamcmd binary is. Root level, not per game, because it names a host tool. */
  steamcmd?: { path?: string }
  games: Record<string, GameConfig>
}

// ----------------------------------------------------------------- mod index

export type ModSourceKind = 'local' | 'workshop' | 'official' | 'core'

export interface ModManifest {
  packageId: string
  name?: string
  modDependencies: { packageId: string; steamWorkshopUrl?: string }[]
  loadAfter: string[]
  loadBefore: string[]
  forceLoadAfter: string[]
  forceLoadBefore: string[]
  incompatibleWith: string[]
}

export interface ModRecord {
  /** Manifest casing, preserved. Match on the lowercased form. */
  packageId: string
  dir: string
  kind: ModSourceKind
  manifest: ModManifest
  /** Workshop item id when kind is "workshop". */
  workshopId?: number
  /** True when dir sits inside a linked git worktree; ranked below primaries. */
  linkedWorktree: boolean
  /**
   * Request order when a caller deliberately selected the worktree this record lives in.
   * The scanner can never set it, which is what stops an unselected worktree from winning.
   */
  selectedWorktree?: number
  /** Request order when `--use <packageId>=<dir>` named this record. Outranks a worktree. */
  overridden?: number
  /** Set only for a selected worktree; the branch costs a git spawn, so it is not scanned for. */
  worktree?: { root: string; branch: string; source: WorktreeSource }
  /** Which scanRoot produced it, for the precedence ladder. */
  rootIndex: number
  /**
   * The clone directory's mtime. Source-cache records only, which is what keeps it from
   * reordering a user's checkout against anything.
   */
  clonedAt?: number
}

export type WorktreeSource = 'flag' | 'env' | 'cwd' | 'ref'

export interface WorktreeRequest {
  /** realpath'd worktree toplevel. */
  root: string
  branch: string
  source: WorktreeSource
  /** Lower wins. */
  order: number
}

export interface ModIndex {
  game: string
  plugin: GamePlugin
  /** Keyed by lowercased packageId. Several records means a collision to resolve. */
  byPackageId: Map<string, ModRecord[]>
  byWorkshopId: Map<number, ModRecord>
  /** Lowercased last dot-segment -> packageIds. CLI matching only. */
  byShortName: Map<string, string[]>
  problems: Problem[]
}

// ---------------------------------------------------------------- resolution

/** Why a mod looks stale, in enough detail to name the file that says so. */
export interface StaleReport {
  /** Mod-relative path of the newest .cs. */
  newestSource: string
  newestSourceMs: number
  /** Mod-relative path of the newest assembly it should have been compiled into. */
  assembly: string
  assemblyMs: number
  newerCount: number
}

export interface ResolvedMod {
  packageId: string
  hostDir: string
  containerDir: string
  kind: ModSourceKind
  workshopId?: number
  /** False when the entry came from autoDependencies rather than the profile. */
  explicit: boolean
  /** Set when a .cs file is newer than the staged assembly. */
  stale?: boolean
  /** Set only when there is an assembly to be stale against; drives the launch warning. */
  staleReport?: StaleReport
  /** Present when this mod came out of a linked worktree. */
  worktree?: { root: string; branch: string; source: WorktreeSource; selected: boolean }
  /** Other directories that declared this packageId and lost. Always emitted. */
  shadowed?: string[]
}

export interface LaunchPlan {
  game: string
  gameConfig: GameConfig
  plugin: GamePlugin
  profile: string
  settings: Settings
  mods: ResolvedMod[]
  /** Absolute host path: <dataRoot>/<game>/<profile>. */
  profileDir: string
  /** Undefined for the base profile; a name when several runs share one profile. */
  instance?: string
  /** profileDir, or <profileDir>/instances/<instance>. Everything a run writes hangs off it. */
  instanceDir: string
  dataDirHost: string
  /** <profileDir>/config. Shared by every instance, and holds the XDG dirs. */
  configDirHost: string
  stageDirHost: string
  logsDirHost: string
  /** <logsDirHost>/runs/<ts>, bound into the container so Player.log lands with stdout.log. */
  runDirHost: string
  mode: ModeName
  marker?: string
  timeoutSeconds: number
  renderWaitSeconds: number
  /** False under --no-stale-check. The check still runs, so staleReport stays truthful. */
  warnOnStale: boolean
  warnings: string[]
}

// -------------------------------------------------------------------- docker

export interface Identity {
  uid: number
  gid: number
  home: string
  user: string
}

export interface Mount {
  type: 'bind' | 'tmpfs'
  source?: string
  target: string
  readonly?: boolean
  /** tmpfs only. */
  size?: string
  uid?: number
  gid?: number
  mode?: string
}

export interface DockerRunSpec {
  image: string
  name: string
  labels: Record<string, string>
  identity: Identity
  env: Record<string, string>
  mounts: Mount[]
  devices: string[]
  deviceCgroupRules: string[]
  network: NetworkPolicy
  memory: string
  memorySwap: string
  cpus: number
  pidsLimit: number
  ulimits: string[]
  workdir: string
  /** The host's, when set: KWin appends `<@name>` to a caption from a foreign machine. */
  hostname?: string
  /** argv after the image name. */
  command: string[]
  extraArgs: string[]
}

// ----------------------------------------------------------------------- cli

export interface ParsedArgs {
  subcommand: string
  game?: string
  profile?: string
  mods: string[]
  without: string[]
  only: string[]
  mode?: ModeName
  marker?: string
  timeout?: number
  renderWait?: number
  resolution?: { width: number; height: number }
  network?: NetworkPolicy
  log?: string
  pull?: PullPolicy
  build?: BuildPolicy
  sort?: 'topo' | 'none'
  /** `clean` only: --staging is the default, --all additionally requires --yes. */
  cleanTier?: 'staging' | 'logs' | 'all' | 'downloads'
  dockerArgs: string[]
  gameArgs: string[]
  dryRun: boolean
  printPlan: boolean
  json: boolean
  root: boolean
  yes: boolean
  help: boolean
  /** Repeatable; earlier flags outrank later ones. */
  worktree: string[]
  /** Names the sub-run: its own data directory, lock and container. */
  instance?: string
  /** Repeatable `packageId=path`; forces one mod's source, whatever the profile says. */
  use: string[]
  /** Suppresses ambient cwd selection and the env var. */
  noWorktree: boolean
  /** Suppresses the sources-newer-than-assemblies warning. The check itself still runs. */
  noStaleCheck: boolean
  /** Stops whatever holds this profile+instance, then launches. Never refuses. */
  replace: boolean
  /** Runs in the background: this process forks a supervisor and returns the prompt. */
  detach: boolean
  /** One-run overrides. Only these turn the matching boolean back off. */
  noDetach: boolean
  noReplace: boolean
  /** Set on the forked supervisor only. Never a config key, never in help. */
  supervised: boolean
  /** `-f`: keep printing as the run writes, instead of dumping what is there. */
  follow: boolean
  /** The write verb under `mods`, or the verb under `steam`. Unset means the read verb. */
  subverb?: 'add' | 'rm' | 'sync' | 'build' | 'login'
  /** `steam build`: repeatable filters on the two axes. */
  variant?: string[]
  branches?: string[]
  /** Repeatable plugin package specifiers. */
  plugin?: string[]
  image?: string
  load?: boolean
  push?: boolean
  base?: string
  platform?: string
  print?: boolean
  username?: string
  /** Where `mods add` pulls the mod from. */
  source?:
    | { kind: 'path'; value: string }
    | { kind: 'workshop'; value: number }
    | {
        kind: 'git'
        url: string
        ref?: { kind: 'branch' | 'tag' | 'commit'; value: string }
        subdir?: string
      }
  /** Which config file a write lands in. */
  target?: 'global' | 'project'
  /** Overwrite an existing entry instead of refusing. */
  force?: boolean
  rest: string[]
}

export type ProjectDefaults = Partial<
  Omit<
    ParsedArgs,
    | 'subcommand' | 'cleanTier' | 'yes' | 'help' | 'rest' | 'profile' | 'supervised'
    | 'noDetach' | 'noReplace' | 'follow' | 'subverb' | 'source' | 'target' | 'force'
    | 'variant' | 'branches' | 'plugin' | 'image' | 'load' | 'push' | 'base'
    | 'platform' | 'print' | 'username'
  >
> & {
  /** Replaces the old `profile:` key. Falls back to the first entry in `profiles`. */
  defaultProfile?: string
  /** Validated by validateConfig after the splice, not here. */
  profiles?: Record<string, unknown>
  settings?: Record<string, unknown>
  /** Spliced per id over games.<game>.library, so a repo pin replaces a global one whole. */
  library?: Record<string, unknown>
  /** Profile keys in source order. Object.keys sorts integer-like names to the front. */
  profileOrder?: string[]
  /** The file these came from. Four suffixes are legal, so output must not guess the name. */
  configPath?: string
}

/** Names that can never be a game or profile key. Enforced at config load. */
export const RESERVED_NAMES: readonly string[] = [
  'run', 'list', 'mods', 'doctor', 'clean', 'clone', 'logs', 'build',
  'shell', 'config', 'fix-perms', 'verify', 'help', 'version', 'modless',
  'ps', 'stop', 'attach', 'wait', 'add', 'rm', 'sync', 'steam', 'login',
]

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Lookup in a bag keyed by user input. A bare index hands back Object.prototype members, so
 * `--mod constructor` or a profile named `toString` would resolve to an inherited function.
 */
export function own<T>(bag: Record<string, T> | undefined, key: string): T | undefined {
  return bag !== undefined && Object.hasOwn(bag, key) ? bag[key] : undefined
}
