import { z } from 'zod'
import { access, readdir, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseResolution } from '../cli/args'
import { warn } from '../cli/output'
import { GamecrateError, Exit, NAME_PATTERN, own } from '../types'
import type {
  BuildPolicy,
  GameConfig,
  LaunchFlags,
  LibraryEntry,
  ModEntry,
  ProfileConfig,
  ProjectDefaults,
  RootConfig,
  Settings,
  SteamBranch,
} from '../types'
import { loadPlugins, pluginInstalled } from '../plugin'
import type { GamePlugin } from '../plugin'
import { DEFAULT_DATA_ROOT, DEFAULT_SETTINGS, applyDefaultImage } from './builtin'
import { CONFIG_SUFFIXES, orderedKeys, readConfigFile, readConfigText } from './read'
import { isObj, validateConfig } from './validate'

export function globalConfigDir(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return join(base, 'gamecrate')
}

export async function findGlobalConfig(): Promise<string | undefined> {
  const dir = globalConfigDir()
  const found = await probe(dir, 'config')
  const old = await probe(dir, 'profiles')
  if (found !== undefined && old !== undefined) {
    throw new GamecrateError(
      `two global configs in ${dir}`,
      Exit.Config,
      `${basename(found)} and ${basename(old)}. the name is config now, so delete ${basename(old)}`,
    )
  }
  if (found !== undefined) return found
  return old === undefined ? undefined : await adoptOldStem(dir, old)
}

/** The global config was once `profiles.<ext>`. One rename, announced, then never again. */
async function adoptOldStem(dir: string, old: string): Promise<string> {
  const moved = join(dir, `config${extname(old)}`)
  try {
    await rename(old, moved)
  } catch {
    return (await probe(dir, 'config')) ?? old
  }
  warn(`renamed ${basename(old)} to ${basename(moved)}: the global config is config${extname(old)} now`)
  return moved
}

async function probe(dir: string, stem: string): Promise<string | undefined> {
  const found: string[] = []
  for (const suffix of CONFIG_SUFFIXES) {
    const file = join(dir, `${stem}${suffix}`)
    try {
      await access(file)
      found.push(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (found.length > 1) {
    const rows = found.map((f) => `  ${basename(f)}`).join('\n')
    throw new GamecrateError(
      `two configs in ${dir}`,
      Exit.Config,
      `${rows}\nkeep one`,
    )
  }
  return found[0]
}

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

const PROJECT_OBJECT = z.strictObject(
  {
    game: projectName.optional(),
    defaultProfile: projectName.optional(),
    profiles: z.record(projectName, z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    library: z.record(z.string(), z.unknown()).optional(),
    detach: projectBool.optional(),
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
    steam: projectBool.optional(),
    mode: oneOf(['headed', 'headless', 'screenshot']).optional(),
    pull: oneOf(['always', 'missing', 'never']).optional(),
    sort: oneOf(['topo', 'none']).optional(),
    network: oneOf(['none', 'bridge', 'host']).optional(),
    build: z
      .union([z.boolean().transform((on): BuildPolicy => (on ? 'always' : 'never')), z.enum(BUILD_POLICIES)], {
        error: `expected one of ${BUILD_POLICIES.join(', ')}`,
      })
      .optional(),
    resolution: projectResolution.optional(),
  },
  { error: 'expected an object' },
)

const PROJECT_SCHEMA = PROJECT_OBJECT.check((ctx) => {
  const { game, profiles, settings, library } = ctx.value
  if (game !== undefined) return
  for (const [key, value] of [
    ['profiles', profiles],
    ['settings', settings],
    ['library', library],
  ] as const) {
    if (value === undefined) continue
    ctx.issues.push({
      code: 'custom',
      path: [key],
      message: 'needs a top-level game: to say which game it belongs to',
      input: ctx.value,
    })
  }
})

export async function findProjectConfig(start = process.cwd()): Promise<string | undefined> {
  let dir = resolve(start)
  for (;;) {
    const file = await probe(dir, '.gamecrate')
    if (file !== undefined) return file
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export async function loadProjectDefaults(start = process.cwd()): Promise<ProjectDefaults> {
  const file = await findProjectConfig(start)
  if (file === undefined) return {}

  const text = await readFile(file, 'utf8')
  const defaults = validateProjectDefaults(readConfigText(text, file), file)
  const profiles = defaults.profiles
  if (profiles !== undefined) {
    const order = orderedKeys(text, file, 'profiles')
    if (order.length !== Object.keys(profiles).length || order.some((key) => !Object.hasOwn(profiles, key))) {
      throw new GamecrateError(`config is invalid: ${file}`, Exit.Config, 'duplicate profiles key')
    }
    defaults.profileOrder = order
  }
  if (defaults.log !== undefined) defaults.log = resolve(dirname(file), defaults.log)
  defaults.configPath = file
  return defaults
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
 * Reads the global config, loads the plugins it lists, then merges the user's blocks over each
 * plugin's defaults. A missing file means no games, which every non-launch subcommand survives.
 */
export async function loadConfig(
  path?: string,
  project?: ProjectDefaults,
  flags?: LaunchFlags,
): Promise<LoadedConfig> {
  const file = path ?? (await findGlobalConfig()) ?? join(globalConfigDir(), 'config.yml')
  const user = await readConfigFile(file)

  const declared = isObj(user) && user['plugins'] !== undefined
  const specs = declared ? user['plugins'] : []
  if (!Array.isArray(specs) || specs.some((s) => typeof s !== 'string')) {
    throw new GamecrateError(`config is invalid: ${file}`, Exit.Config, '  /plugins: expected an array of strings')
  }
  const fallback = declared || flags?.game === undefined ? undefined : flags.game
  const plugins =
    fallback === undefined
      ? await loadPlugins(specs as string[], file)
      : await loadFallbackPlugin(fallback, file)

  const base: RootConfig = {
    dataRoot: DEFAULT_DATA_ROOT,
    defaults: { settings: structuredClone(DEFAULT_SETTINGS) },
    games: Object.fromEntries(
      [...plugins].map(([name, plugin]) => [name, structuredClone(plugin.defaults) as GameConfig]),
    ),
  }
  const merged = user === undefined || user === null ? base : mergeUserConfig(base, user)
  const spliced = applyDefaultImage(applyProject(merged, project), flags)
  const { config, problems } = validateConfig(spliced)
  if (problems.length > 0) {
    const detail = problems
      .map((p) => {
        const hint = p.suggestion ? ` (${p.suggestion})` : ''
        return `  ${p.where || '/'}: ${p.message}${hint}${origin(p.where, user, plugins, project)}`
      })
      .join('\n')
    const from = plugins.size === 0 ? '' : ` (merged with defaults from: ${[...plugins.keys()].join(', ')})`
    throw new GamecrateError(`config is invalid: ${file}${from}`, Exit.Config, detail)
  }
  return { config: expandPaths(config), plugins }
}

async function loadFallbackPlugin(game: string, file: string): Promise<Map<string, GamePlugin>> {
  const spec = `@gamecrate/${game}`
  if (!pluginInstalled(spec, dirname(file))) {
    throw new GamecrateError(
      `no plugin for game "${game}"`,
      Exit.Environment,
      `nothing is installed as ${spec}, and ${file} names no plugins.\ninstall it with npm i -g ${spec}, or run gamecrate init to write a config that names one`,
    )
  }
  return await loadPlugins([spec], file)
}

function applyProject(config: RootConfig, project?: ProjectDefaults): RootConfig {
  if (project === undefined) return config
  const game = project.game
  if (game === undefined) return config
  if (project.profiles === undefined && project.settings === undefined && project.library === undefined) {
    return config
  }

  const existing = own(config.games, game)
  if (existing === undefined) {
    throw new GamecrateError(
      `the project config names game "${game}", which is not configured`,
      Exit.Config,
      `known games: ${Object.keys(config.games).join(', ') || 'none'}`,
    )
  }

  const target: GameConfig = {
    ...existing,
    profiles: { ...existing.profiles, ...(project.profiles as Record<string, ProfileConfig> | undefined) },
    ...(project.library === undefined
      ? {}
      : { library: spliceLibrary(existing.library, project.library as Record<string, LibraryEntry>) }),
  }
  config.games[game] = target
  if (project.settings !== undefined) {
    target.settings = deepMerge(target.settings ?? {}, project.settings)
  }
  return config
}

function spliceLibrary(
  global: GameConfig['library'],
  project: Record<string, LibraryEntry>,
): Record<string, LibraryEntry> {
  const replaced = new Set(Object.keys(project).map((id) => id.toLowerCase()))
  const kept = Object.entries(global ?? {}).filter(([id]) => !replaced.has(id.toLowerCase()))
  return { ...Object.fromEntries(kept), ...project }
}

const GAME_SCOPED_KEYS = ['profiles', 'settings', 'library'] as const

function origin(
  where: string,
  user: unknown,
  plugins: Map<string, GamePlugin>,
  project?: ProjectDefaults,
): string {
  if (!where.startsWith('/')) return ''
  const segments = where.slice(1).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
  const [section, name, sub, ...rest] = segments

  const repoGame = project?.game
  const repoSection = GAME_SCOPED_KEYS.find((k) => k === sub)
  if (
    repoGame !== undefined &&
    section === 'games' &&
    name === repoGame &&
    repoSection !== undefined &&
    valueAt(project?.[repoSection], rest) !== undefined
  ) {
    return '  <- from the .gamecrate project config, not this file'
  }
  if (valueAt(user, segments) !== undefined) return ''

  const plugin = section === 'games' && name !== undefined ? plugins.get(name) : undefined
  if (plugin === undefined) return '  <- not in this file'
  return valueAt(plugin.defaults, [sub, ...rest].filter((s) => s !== undefined)) === undefined
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
  const instances = deepMerge(parent.instances ?? {}, self.instances ?? {}, true)
  if (Object.keys(instances).length > 0) out.instances = instances
  const includeBase = self.includeBase ?? parent.includeBase
  if (includeBase !== undefined) out.includeBase = includeBase
  const auto = self.autoDependencies ?? parent.autoDependencies
  if (auto !== undefined) out.autoDependencies = auto
  const fields = ['detach', 'replace', 'steam', 'build', 'gameVersion', 'image', 'windowTitle', 'windowIcon'] as const
  for (const field of fields) {
    const value = self[field] ?? parent[field]
    if (value !== undefined) Object.assign(out, { [field]: value })
  }
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

/**
 * Every name `profileKey` would answer to, per game. What lets a bare profile name the game it
 * belongs to, so the extra `aliases` have to be in here too.
 */
export function profileNames(config: RootConfig): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(config.games).map(([name, game]) => [
      name,
      Object.entries(game.profiles).flatMap(([key, spec]) => [
        key,
        ...(spec.aliases ?? []).filter((a) => typeof a === 'string'),
      ]),
    ]),
  )
}

export function profileKey(game: GameConfig, name: string): string | undefined {
  if (Object.hasOwn(game.profiles, name)) return name
  const lower = name.toLowerCase()
  const direct = Object.keys(game.profiles).find((k) => k.toLowerCase() === lower)
  if (direct !== undefined) return direct
  return Object.keys(game.profiles).find((k) =>
    (own(game.profiles, k)?.aliases ?? []).some((a) => typeof a === 'string' && a.toLowerCase() === lower),
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
  const body = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${body}$`, 'i')
}

/**
 * deepMerge, then the two keys it gets wrong: `branches[0]` carries the bare tag, and a
 * library entry names one source, so a user's `git` over a plugin's `workshop` must replace it.
 */
export function mergeUserConfig(base: RootConfig, user: unknown): RootConfig {
  const out = deepMerge(base, user)
  const games = isObj(user) ? user['games'] : undefined
  if (!isObj(games)) return out
  for (const name of Object.keys(games)) {
    const theirs = own(games, name)
    const target = own(out.games, name)
    if (target === undefined) continue
    const library = isObj(theirs) ? theirs['library'] : undefined
    if (isObj(library)) {
      target.library = spliceLibrary(own(base.games, name)?.library, library as Record<string, LibraryEntry>)
    }
    const steamBuild = isObj(theirs) ? theirs['steamBuild'] : undefined
    const added = isObj(steamBuild) ? steamBuild['branches'] : undefined
    const declared = own(base.games, name)?.steamBuild?.branches
    if (!Array.isArray(added) || !Array.isArray(declared)) continue
    target.steamBuild.branches = concatBranches(declared, added)
  }
  return out
}

function branchName(entry: unknown): string | undefined {
  return isObj(entry) && typeof entry['name'] === 'string' ? entry['name'] : undefined
}

function concatBranches(declared: SteamBranch[], added: unknown[]): SteamBranch[] {
  const out = [...declared]
  const at = new Map<string, number>()
  out.forEach((branch, index) => {
    const name = branchName(branch)
    if (name !== undefined && !at.has(name)) at.set(name, index)
  })
  for (const entry of added) {
    const name = branchName(entry)
    const index = name === undefined ? undefined : at.get(name)
    if (index === undefined) {
      if (name !== undefined) at.set(name, out.length)
      out.push(entry as SteamBranch)
      continue
    }
    out[index] = deepMerge(out[index] as SteamBranch, entry)
  }
  return out
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
  if (config.steamcmd?.path !== undefined) config.steamcmd.path = expandHome(config.steamcmd.path)
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
