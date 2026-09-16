import { YAML } from 'bun'
import { z } from 'zod'
import { access, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseResolution } from '../cli/args'
import { GamecrateError, Exit, NAME_PATTERN, own } from '../types'
import type {
  BuildPolicy,
  GameConfig,
  ModEntry,
  ProfileConfig,
  ProjectDefaults,
  RootConfig,
  Settings,
} from '../types'
import { loadPlugins } from '../plugin'
import type { GamePlugin } from '../plugin'
import { DEFAULT_DATA_ROOT, DEFAULT_SETTINGS } from './builtin'
import { parseJsonc } from './jsonc'
import { isObj, validateConfig } from './validate'

export function defaultConfigPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return join(base, 'gamecrate', 'profiles.json')
}

const PROJECT_CONFIG = '.gamecrate.yml'

const projectName = z.custom<string>((v) => typeof v === 'string' && NAME_PATTERN.test(v), 'expected a name')
const projectStr = z.string({ error: 'expected a string' })
const projectBool = z.boolean({ error: 'expected true or false' })
const projectList = z.custom<string[]>(
  (v) => Array.isArray(v) && v.every((entry) => typeof entry === 'string'),
  'expected an array of strings',
)
const projectSeconds = z.custom<number>(
  (v) => Number.isSafeInteger(v) && (v as number) >= 0,
  'expected a whole number of seconds',
)

function oneOf<T extends string>(values: readonly [T, ...T[]]) {
  return z.enum(values, { error: `expected one of ${values.join(', ')}` })
}

const BUILD_POLICIES = ['auto', 'always', 'never'] as const

/** Only the resolution is stored differently from how it is written. */
const projectResolution = z
  .string({ error: 'expected dimensions like 1920x1080' })
  .check((ctx) => {
    try {
      parseResolution(ctx.value)
    } catch (error) {
      ctx.issues.push({ code: 'custom', message: (error as Error).message, input: ctx.value })
    }
  })
  .transform(parseResolution)

const PROJECT_SCHEMA = z.strictObject(
  {
    game: projectName.optional(),
    profile: projectName.optional(),
    mods: projectList.optional(),
    without: projectList.optional(),
    only: projectList.optional(),
    dockerArgs: projectList.optional(),
    gameArgs: projectList.optional(),
    worktree: projectList.optional(),
    use: projectList.optional(),
    marker: projectStr.optional(),
    instance: projectStr.optional(),
    log: projectStr.optional(),
    timeout: projectSeconds.optional(),
    renderWait: projectSeconds.optional(),
    dryRun: projectBool.optional(),
    printPlan: projectBool.optional(),
    json: projectBool.optional(),
    root: projectBool.optional(),
    noWorktree: projectBool.optional(),
    noStaleCheck: projectBool.optional(),
    replace: projectBool.optional(),
    mode: oneOf(['headed', 'headless', 'screenshot']).optional(),
    pull: oneOf(['always', 'missing', 'never']).optional(),
    sort: oneOf(['topo', 'none']).optional(),
    network: oneOf(['none', 'bridge', 'host']).optional(),
    // A bare yes/no is the common spelling; the three-way policy is the full one.
    build: z
      .union([z.boolean().transform((on): BuildPolicy => (on ? 'always' : 'never')), z.enum(BUILD_POLICIES)], {
        error: `expected one of ${BUILD_POLICIES.join(', ')}`,
      })
      .optional(),
    resolution: projectResolution.optional(),
  },
  { error: 'expected an object' },
)

export async function findProjectConfig(start = process.cwd()): Promise<string | undefined> {
  let dir = resolve(start)
  for (;;) {
    const file = join(dir, PROJECT_CONFIG)
    try {
      await access(file)
      return file
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export async function loadProjectDefaults(start = process.cwd()): Promise<ProjectDefaults> {
  const file = await findProjectConfig(start)
  if (file === undefined) return {}

  let raw: unknown
  try {
    raw = YAML.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new GamecrateError(`project config is invalid: ${file}`, Exit.Config, (error as Error).message)
  }
  return validateProjectDefaults(raw, file)
}

function validateProjectDefaults(raw: unknown, file: string): ProjectDefaults {
  if (raw === null) return {}

  const result = PROJECT_SCHEMA.safeParse(raw)
  if (result.success) return result.data as ProjectDefaults

  const problems: string[] = []
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) problems.push(`  /${key}: unknown key`)
      continue
    }
    problems.push(`  /${issue.path.join('/')}: ${issue.message}`)
  }
  throw new GamecrateError(`project config is invalid: ${file}`, Exit.Config, problems.join('\n'))
}

export interface LoadedConfig {
  config: RootConfig
  plugins: Map<string, GamePlugin>
}

/**
 * Reads profiles.json, loads the plugins it lists, then merges the user's blocks over each
 * plugin's defaults. A missing file means no games, which every non-launch subcommand survives.
 */
export async function loadConfig(path?: string): Promise<LoadedConfig> {
  const file = path ?? defaultConfigPath()
  let user: unknown
  try {
    user = parseJsonc(await readFile(file, 'utf8'))
  } catch (err) {
    if (err instanceof GamecrateError) {
      throw new GamecrateError(`${err.message}: ${file}`, err.code, err.detail)
    }
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }

  const specs = isObj(user) && user['plugins'] !== undefined ? user['plugins'] : []
  if (!Array.isArray(specs) || specs.some((s) => typeof s !== 'string')) {
    throw new GamecrateError(`config is invalid: ${file}`, Exit.Config, '  /plugins: expected an array of strings')
  }
  const plugins = await loadPlugins(specs as string[], file)

  const base: RootConfig = {
    dataRoot: DEFAULT_DATA_ROOT,
    defaults: { settings: structuredClone(DEFAULT_SETTINGS) },
    games: Object.fromEntries(
      [...plugins].map(([name, plugin]) => [name, structuredClone(plugin.defaults) as GameConfig]),
    ),
  }
  const { config, problems } = validateConfig(user === undefined ? base : deepMerge(base, user))
  if (problems.length > 0) {
    const detail = problems
      .map((p) => {
        const hint = p.suggestion ? ` (${p.suggestion})` : ''
        return `  ${p.where || '/'}: ${p.message}${hint}${origin(p.where, user, plugins)}`
      })
      .join('\n')
    const merged = plugins.size === 0 ? '' : ` (merged with defaults from: ${[...plugins.keys()].join(', ')})`
    throw new GamecrateError(`config is invalid: ${file}${merged}`, Exit.Config, detail)
  }
  return { config: expandPaths(config), plugins }
}

/**
 * Says where a problem's key actually came from. A pointer the user's file does not contain
 * arrived with a plugin's defaults, and blaming profiles.json for it sends them key-hunting.
 */
function origin(where: string, user: unknown, plugins: Map<string, GamePlugin>): string {
  if (!where.startsWith('/')) return ''
  const segments = where.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (valueAt(user, segments) !== undefined) return ''

  const [section, name, ...rest] = segments
  const plugin = section === 'games' && name !== undefined ? plugins.get(name) : undefined
  if (plugin === undefined) return '  <- not in this file'
  return valueAt(plugin.defaults, rest) === undefined
    ? `  <- not in this file, and the ${name} plugin's defaults do not supply it`
    : `  <- from the ${name} plugin's defaults, not this file`
}

function valueAt(value: unknown, segments: string[]): unknown {
  let current = value
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isObj(current)) current = own(current, segment)
    else return undefined
  }
  return current
}

/** defaults -> games.<game> -> profile -> instance -> CLI. Scalars replace, arrays concatenate. */
export function resolveSettings(
  root: RootConfig,
  game: GameConfig,
  profile: ProfileConfig,
  ...overrides: (Partial<Settings> | undefined)[]
): Settings {
  let out: Settings = structuredClone(DEFAULT_SETTINGS)
  for (const layer of [root.defaults?.settings, game.settings, profile.settings, ...overrides]) {
    if (layer) out = deepMerge(out, layer, true)
  }
  return out
}

/**
 * Flattens `alias` and the `extends` chain into one profile. `exclude` survives on
 * the result so the caller can subtract it from preCore/core/dlc/base too.
 */
export function resolveProfile(game: GameConfig, name: string): ProfileConfig {
  return resolveNamed(game, name, [])
}

function resolveNamed(game: GameConfig, name: string, seen: string[]): ProfileConfig {
  if (name.toLowerCase() === 'modless') return { mods: [], exclude: [], includeBase: false }

  const key = profileKey(game, name)
  if (key === undefined) {
    throw new GamecrateError(
      `unknown profile "${name}"`,
      Exit.Resolution,
      `known profiles: ${Object.keys(game.profiles).join(', ') || '(none)'}, modless`,
    )
  }
  if (seen.includes(key)) {
    throw new GamecrateError(
      `profile "${key}" inherits from itself`,
      Exit.Config,
      [...seen, key].join(' -> '),
    )
  }

  const self = own(game.profiles, key)!
  if (self.alias !== undefined) return resolveNamed(game, self.alias, [...seen, key])

  const parent: ProfileConfig =
    self.extends !== undefined ? resolveNamed(game, self.extends, [...seen, key]) : {}

  const exclude = [...(parent.exclude ?? []), ...(self.exclude ?? [])]
  const out: ProfileConfig = {
    mods: subtract([...(parent.mods ?? []), ...(self.mods ?? [])], exclude),
    exclude,
    settings: deepMerge(parent.settings ?? {}, self.settings ?? {}, true),
  }
  // A child inherits its parent's instances and may redefine one by name.
  const instances = deepMerge(parent.instances ?? {}, self.instances ?? {}, true)
  if (Object.keys(instances).length > 0) out.instances = instances
  const includeBase = self.includeBase ?? parent.includeBase
  if (includeBase !== undefined) out.includeBase = includeBase
  const auto = self.autoDependencies ?? parent.autoDependencies
  if (auto !== undefined) out.autoDependencies = auto
  return out
}

/**
 * The name a profile stores its data under. An alias must not get its own data directory,
 * or your saves split depending on which spelling you typed.
 */
export function canonicalProfile(game: GameConfig, name: string): string {
  if (name.toLowerCase() === 'modless') return 'modless'
  const seen: string[] = []
  let current = name
  for (;;) {
    const key = profileKey(game, current)
    if (key === undefined || seen.includes(key)) return key ?? current
    const next = own(game.profiles, key)?.alias
    if (next === undefined) return key
    seen.push(key)
    current = next
  }
}

/**
 * The one place a profile's data directory is named. Every subcommand goes through it, so
 * `logs`, `clean` and `clone` land on the directory `run` actually used, alias or not.
 */
export function profileDataDir(root: RootConfig, game: string, profile: string): string {
  return resolve(expandHome(root.dataRoot), game, canonicalProfile(own(root.games, game)!, profile))
}

/**
 * The directories a command should touch for one game. With no profile it lists what is on disk,
 * verbatim: a directory name is already a path, and canonicalizing it skips odd-cased ones.
 */
export async function profileDirs(root: RootConfig, game: string, profile?: string): Promise<string[]> {
  if (profile !== undefined) return [profileDataDir(root, game, profile)]
  const dir = join(expandHome(root.dataRoot), game)
  return (await readdir(dir).catch(() => [] as string[])).map((name) => join(dir, name))
}

function profileKey(game: GameConfig, name: string): string | undefined {
  if (Object.hasOwn(game.profiles, name)) return name
  const lower = name.toLowerCase()
  const direct = Object.keys(game.profiles).find((k) => k.toLowerCase() === lower)
  if (direct !== undefined) return direct
  // A profile's own `aliases` are extra names for it, so one entry answers to several.
  return Object.keys(game.profiles).find((k) =>
    (own(game.profiles, k)?.aliases ?? []).some((a) => a.toLowerCase() === lower),
  )
}

/** Removes entries whose id matches an exclusion. Dynamic entries are filtered after expansion. */
export function subtract(mods: ModEntry[], exclude: string[]): ModEntry[] {
  if (exclude.length === 0) return mods
  const patterns = exclude.map(globToRegExp)
  return mods.filter((entry) => {
    const ids = entryIds(entry)
    if (ids.length === 0) return true
    return !ids.some((id) => patterns.some((re) => re.test(id)))
  })
}

function entryIds(entry: ModEntry): string[] {
  if (typeof entry === 'string') return [entry, entry.replace(/^(workshop|path):/, '')]
  if ('id' in entry) return [entry.id]
  return []
}

export function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

/**
 * A later list replaces an earlier one, so a user can shorten a plugin's `dlc` or `modes`.
 * `concatArrays` is the settings ladder's rule, where gameArgs accumulate across layers.
 */
export function deepMerge<T>(base: T, over: unknown, concatArrays = false): T {
  if (Array.isArray(base) && Array.isArray(over)) {
    return (concatArrays ? [...base, ...over] : [...over]) as unknown as T
  }
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) continue
      out[k] = Object.hasOwn(out, k) ? deepMerge(out[k], v, concatArrays) : v
    }
    return out as unknown as T
  }
  return over as T
}

function expandPaths(config: RootConfig): RootConfig {
  config.dataRoot = expandHome(config.dataRoot)
  for (const game of Object.values(config.games)) {
    if (game.gameFiles.host !== undefined) game.gameFiles.host = expandHome(game.gameFiles.host)
    if (game.image.context !== undefined) game.image.context = expandHome(game.image.context)
    if (game.workshopRoot !== null) game.workshopRoot = expandHome(game.workshopRoot)
    for (const root of game.scanRoots) root.path = expandHome(root.path)
    for (const entry of Object.values(game.library ?? {})) {
      if (entry.path !== undefined) entry.path = expandHome(entry.path)
    }
  }
  return config
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}
