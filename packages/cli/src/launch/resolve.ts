import { join } from 'node:path'

import { canonicalProfile, globToRegExp, profileDataDir, resolveProfile, resolveSettings } from '../config/load'
import { buildIndex, resolveModRef, applyWorktreeRequests, applySourceOverrides } from '../mods/modindex'
import { libraryPin, sourcesRoot } from '../mods/source'
import { decideStale, scanBuildTimes, staleReport } from '../mods/staleness'
import { GamecrateError, Exit, NAME_PATTERN, own } from '../types'
import { requirePlugin } from '../plugin'
import type { GamePlugin } from '../plugin'
import { resolveInstance } from './instance'
import type {
  DynamicModEntry,
  GameConfig,
  LaunchPlan,
  ModEntry,
  ModIndex,
  ModRecord,
  ModeName,
  ParsedArgs,
  Problem,
  ProfileConfig,
  ResolvedMod,
  RootConfig,
} from '../types'

export interface ResolveOptions {
  game: string
  profile: string
  root: RootConfig
  plugins: Map<string, GamePlugin>
  args?: Partial<ParsedArgs>
  /** Prebuilt index; buildIndex runs when absent. */
  index?: ModIndex
  /** Overrides process.cwd() for ambient worktree detection; tests set it. */
  cwd?: string
  /** Lowercased packageId to the clone directory prepared for its git pin. */
  sources?: ReadonlyMap<string, string>
}

const DEFAULT_TIMEOUT_SECONDS = 420
const DEFAULT_RENDER_WAIT_SECONDS = 25

function isDynamic(entry: ModEntry): entry is DynamicModEntry {
  return typeof entry !== 'string' && 'match' in entry
}

interface Staged {
  record: ModRecord
  explicit: boolean
}

interface Slot {
  entry: ModEntry
  where: string
  /** Declared DLC: known to the game, not necessarily owned here. A miss is normal. */
  dlc?: boolean
}

function noWorkshopRoot(gameName: string, what: string): string {
  return `${gameName} has no workshopRoot, so ${what} cannot resolve`
}

/**
 * doctor resolves the modless profile, so no mod ref is ever resolved there. Read the config
 * instead: library pins, plus every profile's mods in both the object and bare-string forms.
 */
export function workshopRootProblem(gameName: string, game: GameConfig): Problem | null {
  if (game.workshopRoot !== null) return null
  const ids = new Set<string>()
  for (const entry of Object.values(game.library ?? {})) {
    if (entry.workshop !== undefined) ids.add(String(entry.workshop))
  }
  for (const profile of Object.values(game.profiles)) {
    for (const entry of profile.mods ?? []) {
      if (typeof entry === 'string') {
        if (entry.startsWith('workshop:')) ids.add(entry.slice(9))
      } else if ('workshop' in entry && entry.workshop !== undefined) ids.add(String(entry.workshop))
    }
  }
  if (ids.size === 0) return null
  const shown = [...ids].slice(0, 3).join(', ')
  const tail = `${ids.size} workshop reference(s)`
  return {
    where: `/games/${gameName}/workshopRoot`,
    message: `${noWorkshopRoot(gameName, tail)}: ${shown}${ids.size > 3 ? ', ...' : ''}`,
    suggestion: `set games.${gameName}.workshopRoot, or pin those mods with path: or git:`,
  }
}

/** A ref the index understands, with library pins applied. */
function refFor(
  entry: string | { id: string; workshop?: number; path?: string },
  game: GameConfig,
  sources: ReadonlyMap<string, string>,
): string {
  const object = typeof entry === 'string' ? { id: entry } : entry
  if (object.path !== undefined) return `path:${object.path}`
  if (object.workshop !== undefined) return `workshop:${object.workshop}`
  if (object.id.includes(':')) return object.id
  const pin = libraryPin(game, object.id)
  if (pin?.path !== undefined) return `path:${pin.path}`
  if (pin?.workshop !== undefined) return `workshop:${pin.workshop}`
  // prepared before the index was built, so this is a directory lookup, never a network call.
  // `verify` and `mods` prepare from the cache alone, and a failed fetch still leaves a map.
  if (pin?.git !== undefined) {
    const dir = sources.get(object.id.toLowerCase())
    if (dir !== undefined) return `path:${pin.subdir === undefined ? dir : join(dir, pin.subdir)}`
  }
  return object.id
}

function expandDynamic(
  entry: DynamicModEntry,
  index: ModIndex,
  where: string,
  problems: Problem[],
): string[] {
  const pattern = globToRegExp(entry.match)
  const matched: string[] = []
  for (const records of index.byPackageId.values()) {
    const record = records[0]
    if (record && pattern.test(record.packageId)) matched.push(record.packageId)
  }
  const minMatches = entry.minMatches ?? 1
  if (matched.length < minMatches) {
    problems.push({
      where,
      message: `"${entry.match}" matched ${matched.length} mod(s), needs at least ${minMatches}`,
    })
  }
  const firstOrder = (entry.first ?? []).map((id) => id.toLowerCase())
  const head = matched
    .filter((id) => firstOrder.includes(id.toLowerCase()))
    .sort((a, b) => firstOrder.indexOf(a.toLowerCase()) - firstOrder.indexOf(b.toLowerCase()))
  const rest = matched.filter((id) => !firstOrder.includes(id.toLowerCase()))
  if ((entry.sort ?? 'alpha') === 'alpha') {
    rest.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
  }
  return [...head, ...rest]
}

function collectSlots(
  game: GameConfig,
  gameName: string,
  profileName: string,
  profile: ProfileConfig,
  args: Partial<ParsedArgs>,
): Slot[] {
  const modless = profileName === 'modless'
  const slots: Slot[] = []
  const at = `/games/${gameName}`
  if (!modless) for (const [i, id] of (game.preCore ?? []).entries()) slots.push({ entry: id, where: `${at}/preCore/${i}` })
  slots.push({ entry: game.core, where: `${at}/core` })
  for (const [i, id] of game.dlc.entries()) slots.push({ entry: id, where: `${at}/dlc/${i}`, dlc: true })
  if (!modless && profile.includeBase !== false) {
    for (const [i, id] of (game.base ?? []).entries()) slots.push({ entry: id, where: `${at}/base/${i}` })
  }
  const only = args.only ?? []
  const declared: ModEntry[] = only.length > 0 ? only : (profile.mods ?? [])
  const source = only.length > 0 ? 'flag --only' : `${at}/profiles/${profileName}/mods`
  for (const [i, entry] of declared.entries()) slots.push({ entry, where: `${source}/${i}` })
  for (const [i, id] of (args.mods ?? []).entries()) slots.push({ entry: id, where: `flag --mod/${i}` })
  return slots
}

function insertDependencies(
  list: Staged[],
  present: Set<string>,
  index: ModIndex,
  game: GameConfig,
  problems: Problem[],
): void {
  let i = 0
  outer: while (i < list.length) {
    const mod = list[i]!
    for (const dep of mod.record.manifest.modDependencies) {
      const key = dep.packageId.toLowerCase()
      if (present.has(key)) continue
      present.add(key)
      const record = resolveModRef(index, dep.packageId, game)
      if (!record) {
        problems.push({
          where: mod.record.packageId,
          message: `declares a dependency on ${dep.packageId}, which is not installed`,
          suggestion: dep.steamWorkshopUrl,
        })
        continue
      }
      present.add(record.packageId.toLowerCase())
      list.splice(i, 0, { record, explicit: false })
      continue outer
    }
    i++
  }
}

/**
 * Kahn's algorithm over loadAfter/loadBefore/forceLoad*, profile order as tiebreak. Anything
 * that must precede core is emitted first: a patching runtime that loads after an ordinary
 * mod has already missed its window, and the symptom is a black screen, not an error.
 */
function topoSort(list: Staged[], problems: Problem[], core?: string): Staged[] {
  const position = new Map<string, number>()
  for (const [i, mod] of list.entries()) position.set(mod.record.packageId.toLowerCase(), i)

  const edges = new Set<string>()
  const addEdge = (from: number | undefined, to: number | undefined): void => {
    if (from === undefined || to === undefined || from === to) return
    edges.add(`${from}>${to}`)
  }
  for (const [i, mod] of list.entries()) {
    const { loadAfter, loadBefore, forceLoadAfter, forceLoadBefore } = mod.record.manifest
    for (const id of [...loadAfter, ...forceLoadAfter]) addEdge(position.get(id.toLowerCase()), i)
    for (const id of [...loadBefore, ...forceLoadBefore]) addEdge(i, position.get(id.toLowerCase()))
  }

  const indegree = list.map(() => 0)
  const outgoing = list.map((): number[] => [])
  // `incoming` is how the pre-core walk below follows the edges backwards.
  const incoming = list.map((): number[] => [])
  for (const edge of edges) {
    const [from, to] = edge.split('>').map(Number) as [number, number]
    outgoing[from]!.push(to)
    incoming[to]!.push(from)
    indegree[to]! += 1
  }
  const preCore = new Set<number>()
  const coreIndex = core === undefined ? undefined : position.get(core.toLowerCase())
  if (coreIndex !== undefined) {
    const queue = [coreIndex]
    while (queue.length > 0) {
      for (const from of incoming[queue.pop()!]!) {
        if (preCore.has(from)) continue
        preCore.add(from)
        queue.push(from)
      }
    }
  }
  const phase = (i: number): number => (preCore.has(i) ? 0 : 1)

  const sorted: Staged[] = []
  const done = list.map(() => false)
  for (;;) {
    let next = -1
    for (let i = 0; i < list.length; i++) {
      if (done[i] || indegree[i] !== 0) continue
      if (next === -1 || phase(i) < phase(next)) next = i
    }
    if (next === -1) break
    done[next] = true
    sorted.push(list[next]!)
    for (const to of outgoing[next]!) indegree[to]! -= 1
  }

  const cycle = list.filter((_, i) => !done[i])
  if (cycle.length > 0) {
    problems.push({
      where: 'flag --sort topo',
      message: `load-order cycle among ${cycle.map((m) => m.record.packageId).join(', ')}; left in profile order`,
    })
    sorted.push(...cycle)
  }
  return sorted
}

function incompatibilityWarnings(list: Staged[]): string[] {
  const byId = new Map(list.map((mod) => [mod.record.packageId.toLowerCase(), mod.record.packageId]))
  const seen = new Set<string>()
  const warnings: string[] = []
  for (const mod of list) {
    for (const id of mod.record.manifest.incompatibleWith) {
      const other = byId.get(id.toLowerCase())
      if (!other) continue
      const pair = [mod.record.packageId, other].map((s) => s.toLowerCase()).sort().join('|')
      if (seen.has(pair)) continue
      seen.add(pair)
      warnings.push(`${mod.record.packageId} declares it is incompatible with ${other}; both are active`)
    }
  }
  return warnings
}

export async function resolvePlan(
  options: ResolveOptions,
): Promise<{ plan: LaunchPlan; problems: Problem[] }> {
  const { game: gameName, profile: requestedProfile, root } = options
  const args = options.args ?? {}
  const sources = options.sources ?? new Map<string, string>()
  const problems: Problem[] = []
  const warnings: string[] = []

  const game = own(root.games, gameName)
  if (!game) {
    throw new GamecrateError(`unknown game "${gameName}"`, Exit.Config, `known: ${Object.keys(root.games).join(', ')}`)
  }
  if (!NAME_PATTERN.test(requestedProfile)) {
    throw new GamecrateError(`invalid profile name "${requestedProfile}"`, Exit.Usage)
  }
  // An alias resolves to its profile's own name, so both spellings share one data dir.
  const profileName = canonicalProfile(game, requestedProfile)

  const profile: ProfileConfig =
    profileName === 'modless' ? { mods: [], includeBase: false } : resolveProfile(game, profileName)

  const profileDir = profileDataDir(root, gameName, profileName)
  const instance = resolveInstance({
    profileDir,
    profile,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
  problems.push(...instance.problems)

  const settings = resolveSettings(root, game, profile, instance.settings, args.resolution)
  if (args.network !== undefined) settings.network = args.network
  if (args.gameArgs?.length) settings.gameArgs = [...(settings.gameArgs ?? []), ...args.gameArgs]
  if (args.dockerArgs?.length) settings.dockerArgs = [...(settings.dockerArgs ?? []), ...args.dockerArgs]

  const plugin = requirePlugin(options.plugins, gameName)
  const index = options.index ?? (await buildIndex(gameName, game, plugin, sourcesRoot(root.dataRoot), root.dataRoot))
  await applyWorktreeRequests(index, instance.requests, game)
  problems.push(...(await applySourceOverrides(index, args.use ?? [], game)))

  const excluded = [...(profile.exclude ?? []), ...(args.without ?? [])].map(globToRegExp)
  const isExcluded = (id: string): boolean => excluded.some((pattern) => pattern.test(id))

  const staged: Staged[] = []
  const present = new Set<string>()
  for (const slot of collectSlots(game, gameName, profileName, profile, args)) {
    const entry = slot.entry
    const refs: { ref: string; optional: boolean }[] = isDynamic(entry)
      ? expandDynamic(entry, index, slot.where, problems).map((id) => ({ ref: id, optional: false }))
      : [{ ref: refFor(entry, game, sources), optional: typeof entry !== 'string' && entry.optional === true }]

    for (const { ref, optional } of refs) {
      const record = resolveModRef(index, ref, game)
      if (!record) {
        // A declared DLC is what the game can have, not what this machine owns.
        if (slot.dlc === true) continue
        if (optional) warnings.push(`optional mod ${ref} is not installed; skipped`)
        else if (ref.startsWith('workshop:') && game.workshopRoot === null) {
          problems.push({
            where: slot.where,
            message: noWorkshopRoot(gameName, ref),
          })
        } else problems.push({ where: slot.where, message: `no mod matches "${ref}"` })
        continue
      }
      const key = record.packageId.toLowerCase()
      if (present.has(key) || isExcluded(record.packageId)) continue
      present.add(key)
      staged.push({ record, explicit: true })
    }
  }

  if (profile.autoDependencies === true) insertDependencies(staged, present, index, game, problems)

  const ordered = args.sort === 'none' ? staged : topoSort(staged, problems, game.core)
  warnings.push(...incompatibilityWarnings(ordered))

  const mods: ResolvedMod[] = []
  for (const { record, explicit } of ordered) {
    // Every local mod, not just a worktree: the primary checkout goes stale exactly as easily.
    const times = record.kind === 'local' ? await scanBuildTimes(record.dir) : null
    const report = times === null ? null : staleReport(times)
    if (record.worktree) {
      warnings.push(
        `${record.packageId} comes from worktree ${record.worktree.branch} (${record.worktree.source}): ${record.dir}`,
      )
    }
    const shadowed = (index.byPackageId.get(record.packageId.toLowerCase()) ?? [])
      .filter((other) => other.dir !== record.dir)
      .map((other) => other.dir)
    mods.push({
      packageId: record.packageId,
      hostDir: record.dir,
      containerDir: `${game.modsDir.container}/${record.packageId}`,
      kind: record.kind,
      ...(record.workshopId === undefined ? {} : { workshopId: record.workshopId }),
      explicit,
      stale: times === null ? false : decideStale(times),
      ...(report === null ? {} : { staleReport: report }),
      ...(record.worktree === undefined
        ? {}
        : { worktree: { ...record.worktree, selected: record.selectedWorktree !== undefined } }),
      ...(shadowed.length === 0 ? {} : { shadowed }),
    })
  }
  problems.push(...index.problems)

  if (game.dataDir.mode === 'arg' && game.dataDir.arg.split('=').length !== 2) {
    problems.push({
      where: `/games/${gameName}/dataDir/arg`,
      message: `"${game.dataDir.arg}" must contain exactly one "="; RimWorld silently ignores anything else`,
    })
  }
  if (game.dataDir.container.includes('=')) {
    problems.push({
      where: `/games/${gameName}/dataDir/container`,
      message: `container data path "${game.dataDir.container}" contains "=", which disables the override silently`,
    })
  }

  const mode: ModeName = args.mode ?? 'headed'
  if (!game.modes.includes(mode)) {
    problems.push({ where: 'flag --mode', message: `${gameName} does not support mode "${mode}"` })
  }

  const plan: LaunchPlan = {
    game: gameName,
    gameConfig: game,
    plugin,
    profile: profileName,
    settings,
    mods,
    profileDir,
    ...(instance.name === undefined ? {} : { instance: instance.name }),
    instanceDir: instance.dir,
    dataDirHost: join(instance.dir, 'game'),
    configDirHost: join(profileDir, 'config'),
    stageDirHost: join(instance.dir, '.stage'),
    logsDirHost: join(instance.dir, 'logs'),
    // Replaced with the real logs/runs/<ts> directory once a run actually opens one.
    runDirHost: join(instance.dir, 'logs'),
    mode,
    ...(args.marker === undefined ? {} : { marker: args.marker }),
    timeoutSeconds: args.timeout ?? DEFAULT_TIMEOUT_SECONDS,
    renderWaitSeconds: args.renderWait ?? DEFAULT_RENDER_WAIT_SECONDS,
    warnOnStale: args.noStaleCheck !== true,
    warnings,
  }
  return { plan, problems }
}
