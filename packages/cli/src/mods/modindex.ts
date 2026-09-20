import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep, resolve as resolvePath } from 'node:path'

import picomatch from 'picomatch'

import { expandHome } from '../config/load'
import { GamecrateError, Exit, own } from '../types'
import { contains } from './worktree'
import type { GamePlugin } from '../plugin'
import type {
  GameConfig,
  ModIndex,
  ModManifest,
  ModRecord,
  ModSourceKind,
  Problem,
  ScanRoot,
  WorktreeRequest,
} from '../types'

/** Cache lives outside the profile tree so `clean --all` can never invalidate it. */
function cacheDir(): string {
  return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'gamecrate')
}

/**
 * `**` spans separators, `*` and `?` do not; everything else is literal. Mod folders are
 * routinely named `[KV] Mod Manager`, so brackets and braces must not be glob syntax.
 */
export function globMatch(pattern: string, path: string): boolean {
  return picomatch.isMatch(path, pattern.replace(/[[\]{}()!,@+|^$.\\]/g, '\\$&'), { dot: true })
}

function excluded(patterns: string[], relativePath: string): boolean {
  return patterns.some((p) => globMatch(p, relativePath) || globMatch(p, `${relativePath}/`))
}

// ---------------------------------------------------------------------- scan

interface Candidate {
  dir: string
  kind: ModSourceKind
  rootIndex: number
  linkedWorktree: boolean
  workshopId?: number
}

/**
 * Worktrees are opt-in, never ambient inventory: an abandoned agent tree must not be a
 * candidate for a launch nobody pointed at it. The overlay scan (rootIndex -1) skips these,
 * which is how a deliberately selected worktree still gets in.
 */
const ALWAYS_EXCLUDE = ['**/.worktrees/**', '**/.claude/worktrees/**']

/**
 * A `.git` file rather than a directory means a linked worktree or submodule. The walk stops
 * at the scan root because a scan root can hold many independent repos, not one.
 */
function inLinkedWorktree(dir: string, stopAt: string): boolean {
  let current = dir
  for (;;) {
    const git = join(current, '.git')
    if (existsSync(git)) {
      try {
        if (statSync(git).isFile()) return true
      } catch {
        return false
      }
      return false
    }
    if (current === stopAt) return false
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

async function scanLocalRoot(
  root: ScanRoot,
  rootIndex: number,
  manifestFile: string,
  found: Candidate[],
): Promise<void> {
  const base = resolvePath(expandHome(root.path))
  const exclude = [...(root.exclude ?? []), ...(rootIndex === -1 ? [] : ALWAYS_EXCLUDE)]

  const walk = async (dir: string, depth: number): Promise<void> => {
    const manifest = join(dir, manifestFile)
    if (existsSync(manifest)) {
      found.push({
        dir,
        kind: 'local',
        rootIndex,
        linkedWorktree: inLinkedWorktree(dir, base),
      })
      // Never descend into a mod: 93 of 325 workshop items ship per-version About files.
      return
    }
    if (depth >= root.maxDepth) return

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.git')) continue
      const child = join(dir, entry.name)
      if (excluded(exclude, relative(base, child))) continue
      await walk(child, depth + 1)
    }
  }

  if (!existsSync(base)) return
  await walk(base, 0)
}

/** Depth-exact at `<root>/<numericId>/About/About.<ext>`; recursing produces phantoms. */
async function scanWorkshopRoot(
  workshopRoot: string,
  rootIndex: number,
  manifestFile: string,
  found: Candidate[],
): Promise<void> {
  const base = resolvePath(expandHome(workshopRoot))
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const dir = join(base, entry.name)
    if (!existsSync(join(dir, manifestFile))) continue
    found.push({ dir, kind: 'workshop', rootIndex, linkedWorktree: false, workshopId: Number(entry.name) })
  }
}

/** Core and the official expansions live inside the game install, one level under Data/. */
async function scanGameData(
  game: GameConfig,
  rootIndex: number,
  found: Candidate[],
): Promise<void> {
  const host = game.gameFiles.host
  if (game.gameFiles.source !== 'mount' || host === undefined) return
  const data = join(resolvePath(expandHome(host)), 'Data')
  let entries
  try {
    entries = await readdir(data, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(data, entry.name)
    if (!existsSync(join(dir, game.manifest.file))) continue
    found.push({ dir, kind: 'official', rootIndex, linkedWorktree: false })
  }
}

// --------------------------------------------------------------------- index

const CACHE_VERSION = 3

interface CacheFile {
  version: number
  stamp: string
  records: ModRecord[]
}

function workshopStamp(game: GameConfig): string | null {
  if (game.workshopRoot === null) return null
  const acf = join(dirname(dirname(resolvePath(expandHome(game.workshopRoot)))), `appworkshop_${game.steamAppId}.acf`)
  try {
    const info = statSync(acf)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
}

async function readWorkshopCache(game: string, stamp: string): Promise<ModRecord[] | null> {
  try {
    const raw = JSON.parse(await readFile(join(cacheDir(), `${game}.workshop.json`), 'utf8')) as CacheFile
    if (raw.version !== CACHE_VERSION || raw.stamp !== stamp) return null
    return raw.records
  } catch {
    return null
  }
}

async function writeWorkshopCache(game: string, stamp: string, records: ModRecord[]): Promise<void> {
  const payload: CacheFile = { version: CACHE_VERSION, stamp, records }
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(join(cacheDir(), `${game}.workshop.json`), JSON.stringify(payload))
  } catch {
    // A cache that cannot be written is a slower launch, never a failed one.
  }
}

function toRecord(candidate: Candidate, manifest: ModManifest, game: GameConfig): ModRecord {
  const kind: ModSourceKind =
    manifest.packageId.toLowerCase() === game.core.toLowerCase() ? 'core' : candidate.kind
  const record: ModRecord = {
    packageId: manifest.packageId,
    dir: candidate.dir,
    kind,
    manifest,
    linkedWorktree: candidate.linkedWorktree,
    rootIndex: candidate.rootIndex,
  }
  if (candidate.workshopId !== undefined) record.workshopId = candidate.workshopId
  return record
}

/** Selection first: naming a directory is the strongest statement of intent available. */
function tier(r: ModRecord): number[] {
  return [
    r.overridden ?? Number.MAX_SAFE_INTEGER,
    r.selectedWorktree ?? Number.MAX_SAFE_INTEGER,
    r.kind === 'workshop' ? 1 : 0,
    r.linkedWorktree ? 1 : 0,
    r.rootIndex,
  ]
}

function compareTiers(a: ModRecord, b: ModRecord): number {
  const x = tier(a)
  const y = tier(b)
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!
  }
  return 0
}

/** Selection, then non-workshop, then non-worktree, then scan-root order. */
function rank(a: ModRecord, b: ModRecord): number {
  return compareTiers(a, b) || byClone(a, b) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)
}

/**
 * Two clones of one url tie on every element of `tier()`, and the directory-name fallback then
 * prefers `tag-v1` over `tag-v2` forever, because nothing evicts the cache. Newest fetch wins
 * instead. Only cache records carry `clonedAt`, so a clone tying with a local checkout still
 * falls through to the rule the scan-root order relies on.
 */
function byClone(a: ModRecord, b: ModRecord): number {
  if (a.clonedAt === undefined || b.clonedAt === undefined) return 0
  return b.clonedAt - a.clonedAt
}

/**
 * Stamps every record inside a requested worktree, then scans the worktree itself so a tree
 * no scanRoot reaches still contributes. Only a caller who stood in, typed, or exported a
 * directory can produce `selectedWorktree`.
 */
export async function applyWorktreeRequests(
  index: ModIndex,
  requests: WorktreeRequest[],
  config: GameConfig,
): Promise<void> {
  if (requests.length === 0) return

  const known = new Set<string>()
  for (const bucket of index.byPackageId.values()) {
    for (const record of bucket) {
      known.add(record.dir)
      for (const request of requests) {
        if (!contains(request, record.dir)) continue
        record.worktree = { root: request.root, branch: request.branch, source: request.source }
        record.selectedWorktree = request.order
        break
      }
    }
  }

  // Overlay scan: coverage by scanRoot is incidental, so never depend on it.
  for (const request of requests) {
    const found: Candidate[] = []
    await scanLocalRoot(
      { path: request.root, maxDepth: WORKTREE_SCAN_DEPTH, exclude: WORKTREE_EXCLUDE },
      -1,
      config.manifest.file,
      found,
    )
    const fresh = found.filter((c) => !known.has(c.dir))
    if (fresh.length === 0) continue
    for (const record of await parseAll(fresh, config, index.plugin, index.problems)) {
      record.worktree = { root: request.root, branch: request.branch, source: request.source }
      record.selectedWorktree = request.order
      insert(index, record)
    }
  }

  for (const bucket of index.byPackageId.values()) bucket.sort(rank)
}

/** Deep enough for a repo-shaped worktree without walking a whole build tree. */
const WORKTREE_SCAN_DEPTH = 5
const WORKTREE_EXCLUDE = ['**/.retired/**', '**/node_modules/**', '**/bin/**', '**/obj/**']

/**
 * Forces one packageId to come from a named directory, whatever the profile pinned. This is
 * the only override that reaches a mod already in preCore/core/dlc/base, because slot
 * expansion is first-wins and a later `--mod` entry for a present id is dropped.
 */
export async function applySourceOverrides(
  index: ModIndex,
  overrides: string[],
  config: GameConfig,
): Promise<Problem[]> {
  const problems: Problem[] = []
  if (overrides.length === 0) return problems

  for (const [order, spec] of overrides.entries()) {
    const eq = spec.indexOf('=')
    if (eq < 1) {
      problems.push({ where: spec, message: '--use takes <packageId>=<path>' })
      continue
    }
    const wanted = spec.slice(0, eq)
    const dir = resolvePath(expandHome(spec.slice(eq + 1)))

    const file = join(dir, config.manifest.file)
    if (!existsSync(file)) {
      problems.push({
        where: spec,
        message: `no ${config.manifest.file} under ${dir}`,
        suggestion: 'point --use at the mod directory, not the repo root',
      })
      continue
    }

    let manifest: ModManifest | null
    try {
      manifest = index.plugin.parseManifest(readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push({ where: file, message: `could not parse: ${String(error)}` })
      continue
    }
    if (manifest === null) {
      problems.push({ where: file, message: `${file} declares no packageId` })
      continue
    }

    if (manifest.packageId.toLowerCase() !== wanted.toLowerCase()) {
      problems.push({
        where: spec,
        message: `${dir} declares ${manifest.packageId}, not ${wanted}`,
        suggestion: `use --use ${manifest.packageId}=${dir}`,
      })
      continue
    }

    const key = manifest.packageId.toLowerCase()
    const existing = (index.byPackageId.get(key) ?? []).find((r) => r.dir === dir)
    if (existing) {
      existing.overridden = order
    } else {
      const record = toRecord({ dir, kind: 'local', rootIndex: -1, linkedWorktree: false }, manifest, config)
      record.overridden = order
      insert(index, record)
    }
    index.byPackageId.get(key)?.sort(rank)
  }

  return problems
}

function insert(index: ModIndex, record: ModRecord): void {
  const key = record.packageId.toLowerCase()
  const bucket = index.byPackageId.get(key)
  if (bucket) bucket.push(record)
  else index.byPackageId.set(key, [record])

  if (record.workshopId !== undefined && !index.byWorkshopId.has(record.workshopId)) {
    index.byWorkshopId.set(record.workshopId, record)
  }

  const short = key.split('.').pop()
  if (short !== undefined && short.length > 0) {
    const ids = index.byShortName.get(short)
    if (ids) {
      if (!ids.includes(record.packageId)) ids.push(record.packageId)
    } else {
      index.byShortName.set(short, [record.packageId])
    }
  }
}

/**
 * Scans the game install, then every scan root in declaration order, then the source cache,
 * then the workshop root. Local roots rescan every launch; only the workshop scan is cached,
 * against the acf stamp.
 */
export async function buildIndex(
  game: string,
  config: GameConfig,
  plugin: GamePlugin,
  sourcesDir?: string,
): Promise<ModIndex> {
  const index: ModIndex = {
    game,
    plugin,
    byPackageId: new Map(),
    byWorkshopId: new Map(),
    byShortName: new Map(),
    problems: [],
  }

  const local: Candidate[] = []
  await scanGameData(config, -1, local)
  for (const [i, root] of config.scanRoots.entries()) {
    await scanLocalRoot(root, i, config.manifest.file, local)
  }
  // after every user root, not before: lower rootIndex wins, and a clone must never quietly
  // replace a checkout the user already has.
  const cacheIndex = config.scanRoots.length
  const parsed = await parseAll(local, config, plugin, index.problems)
  if (sourcesDir !== undefined) {
    const cache: Candidate[] = []
    // <name-hash>/<ref>/<subdir>/<mod>
    await scanLocalRoot({ path: sourcesDir, maxDepth: 4 }, cacheIndex, config.manifest.file, cache)
    parsed.push(...oneModPerClone(await parseAll(cache, config, plugin, index.problems), sourcesDir))
  }
  for (const record of parsed) insert(index, record)

  if (config.workshopRoot !== null) {
    const stamp = workshopStamp(config)
    const cached = stamp === null ? null : await readWorkshopCache(game, stamp)
    if (cached) {
      for (const record of cached) insert(index, record)
    } else {
      const items: Candidate[] = []
      // +1 keeps the numbering consistent, nothing more: `kind === 'workshop'` is tier index 2,
      // ahead of rootIndex at 4, so this can never change a pick.
      await scanWorkshopRoot(config.workshopRoot, cacheIndex + 1, config.manifest.file, items)
      const records = await parseAll(items, config, plugin, index.problems)
      for (const record of records) insert(index, record)
      if (stamp !== null) await writeWorkshopCache(game, stamp, records)
    }
  }

  for (const bucket of index.byPackageId.values()) bucket.sort(rank)
  return index
}

/**
 * One record per packageId per clone, which is what the library holds: `mods add` writes one
 * entry for a repo that ships `V14/Mod` and `V15/Mod` under the same id. Keeping both here makes
 * them tie on every rule in `rank`, and `pick` turns that tie into a fatal problem. A pin that
 * names the dropped directory still resolves, because `byPath` parses a directory the index
 * never kept.
 */
function oneModPerClone(records: ModRecord[], sourcesDir: string): ModRecord[] {
  const kept = new Map<string, ModRecord>()
  const stamps = new Map<string, number>()
  for (const record of [...records].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))) {
    const clone = relative(sourcesDir, record.dir).split(sep).slice(0, 2).join(sep)
    const at = join(sourcesDir, clone)
    let stamp = stamps.get(at)
    if (stamp === undefined) {
      // a repin makes a new directory, so the mtime dates the ref rather than the last fetch.
      // that is the tie this has to break.
      stamp = statSync(at).mtimeMs
      stamps.set(at, stamp)
    }
    record.clonedAt = stamp
    const key = `${clone}\u0000${record.packageId.toLowerCase()}`
    if (!kept.has(key)) kept.set(key, record)
  }
  return [...kept.values()]
}

async function parseAll(
  candidates: Candidate[],
  config: GameConfig,
  plugin: GamePlugin,
  problems: Problem[],
): Promise<ModRecord[]> {
  const records = await Promise.all(
    candidates.map(async (candidate): Promise<ModRecord | null> => {
      const file = join(candidate.dir, config.manifest.file)
      try {
        const manifest = plugin.parseManifest(await readFile(file, 'utf8'))
        // A scan walks into plenty of directories that were never mods. null is the plugin
        // saying so; a thrown error means the file is broken and worth reporting.
        return manifest === null ? null : toRecord(candidate, manifest, config)
      } catch (error) {
        problems.push({
          where: file,
          message: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    }),
  )
  return records.filter((r): r is ModRecord => r !== null)
}

// ------------------------------------------------------------------- resolve

/**
 * `path:` and `workshop:` are explicit; a bare string resolves as exact packageId, then the
 * game's alias map, then a CLI-only short name. Ambiguity that the ladder cannot break is fatal.
 */
export function resolveModRef(index: ModIndex, ref: string, game: GameConfig): ModRecord | null {
  return honorOverride(index, resolveRaw(index, ref, game))
}

/**
 * `--use` has to beat a `library` pin, and a pin resolves through byWorkshopId without ever
 * touching the ladder. So the override is applied after the ref resolves, by packageId.
 */
function honorOverride(index: ModIndex, record: ModRecord | null): ModRecord | null {
  if (record === null || record.overridden !== undefined) return record
  const best = index.byPackageId.get(record.packageId.toLowerCase())?.[0]
  return best?.overridden !== undefined ? best : record
}

function resolveRaw(index: ModIndex, ref: string, game: GameConfig): ModRecord | null {
  if (ref.startsWith('path:')) return byPath(index, ref.slice(5), game)
  if (ref.startsWith('workshop:')) {
    const id = Number(ref.slice(9))
    return Number.isInteger(id) ? index.byWorkshopId.get(id) ?? null : null
  }

  const direct = pick(index, ref.toLowerCase(), ref)
  if (direct) return direct

  const alias = own(game.aliases, ref) ?? own(game.aliases, ref.toLowerCase())
  if (alias !== undefined && alias.toLowerCase() !== ref.toLowerCase()) {
    return resolveRaw(index, alias, game)
  }

  const short = index.byShortName.get(ref.toLowerCase())
  if (short && short.length === 1) return pick(index, short[0]!.toLowerCase(), ref)
  if (short && short.length > 1) {
    throw new GamecrateError(
      `"${ref}" is a short name for ${short.length} mods`,
      Exit.Resolution,
      short.join(', '),
    )
  }
  return null
}

function pick(index: ModIndex, key: string, ref: string): ModRecord | null {
  const bucket = index.byPackageId.get(key)
  const best = bucket?.[0]
  if (!best) return null
  const runnerUp = bucket![1]
  if (runnerUp && compareTiers(best, runnerUp) === 0) {
    // Two dirs inside one selected worktree names the tie in its own message. Everything else
    // becomes a problem, and every caller on this branch treats a problem as fatal.
    if (best.selectedWorktree !== undefined || runnerUp.selectedWorktree !== undefined) {
      throw new GamecrateError(
        `"${ref}" is declared by ${bucket!.length} indistinguishable directories`,
        Exit.Resolution,
        bucket!.map((r) => r.dir).join('\n'),
      )
    }
    // a cache tie the fetch clock already broke is a decision, not an ambiguity
    if (byClone(best, runnerUp) !== 0) return best
    index.problems.push({
      where: ref,
      message: `resolved by directory name: ${bucket!.length} candidates tie on every rule`,
      suggestion: `using ${best.dir}`,
    })
  }
  return best
}

/** An explicit path always wins, including one the scan never reached. */
function byPath(index: ModIndex, raw: string, game: GameConfig): ModRecord | null {
  const dir = resolvePath(expandHome(raw))
  for (const bucket of index.byPackageId.values()) {
    const hit = bucket.find((record) => record.dir === dir || record.dir === raw)
    if (hit) return hit
  }

  const file = join(dir, game.manifest.file)
  if (!existsSync(file)) return null
  try {
    const manifest = index.plugin.parseManifest(readFileSync(file, 'utf8'))
    if (manifest === null) return null
    return toRecord({ dir, kind: 'local', rootIndex: -1, linkedWorktree: false }, manifest, game)
  } catch {
    return null
  }
}
