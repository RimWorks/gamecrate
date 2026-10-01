import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep, resolve as resolvePath } from 'node:path'

import picomatch from 'picomatch'

import { expandHome } from '../config/load'
import { GamecrateError, Exit, own } from '../types'
import { installedItems, parseAcf } from './acf'
import { capture } from '../docker/run'
import { imageDigest } from '../launch/prepare'
import { RELEASE_PREFIX } from './source'
import { downloadRoot } from './steamcmd'
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
export function cacheDir(): string {
  return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'gamecrate')
}

/**
 * `**` spans separators, `*` and `?` do not; everything else is literal. Mod folders are
 * routinely named `[KV] Mod Manager`, so brackets and braces must not be glob syntax.
 */
export function globMatch(pattern: string, path: string): boolean {
  return picomatch.isMatch(path, pattern.replaceAll(/[[\]{}()!,@+|^$.\\]/g, String.raw`\$&`), { dot: true })
}

function excluded(patterns: string[], relativePath: string): boolean {
  return patterns.some((p) => globMatch(p, relativePath) || globMatch(p, `${relativePath}/`))
}

interface Candidate {
  dir: string
  kind: ModSourceKind
  rootIndex: number
  linkedWorktree: boolean
  workshopId?: number
}

const ALWAYS_EXCLUDE = ['**/.worktrees/**', '**/.claude/worktrees/**']

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

async function gameDataDir(game: GameConfig): Promise<string | null> {
  if (game.gameFiles.source === 'mount') {
    const host = game.gameFiles.host
    return host === undefined ? null : join(resolvePath(expandHome(host)), 'Data')
  }
  const ref = game.image?.ref
  if (ref === undefined || ref === '') return null
  const id = await imageDigest(ref)
  if (id === null) return null
  const out = join(cacheDir(), 'official', id.replace(/[^A-Za-z0-9]/g, '-'), 'Data')
  if (!existsSync(out)) await copyOfficialManifests(game, ref, out)
  return existsSync(out) ? out : null
}

const MARK = '@@gamecrate@@ '

async function copyOfficialManifests(game: GameConfig, ref: string, out: string): Promise<void> {
  const script = [
    'for d in ' + game.gameFiles.container + '/Data/*/; do',
    '  f="${d}' + game.manifest.file + '"',
    '  [ -f "$f" ] || continue',
    '  echo "' + MARK + '$(basename "${d%/}")"',
    '  cat "$f"',
    'done',
  ].join('\n')

  const { code, stdout } = await capture(['docker', 'run', '--rm', '--entrypoint', 'sh', ref, '-c', script])
  if (code !== 0) return

  for (const block of stdout.split(MARK).slice(1)) {
    const cut = block.indexOf('\n')
    if (cut === -1) continue
    const name = block.slice(0, cut).trim()
    if (name === '' || name.includes('/')) continue
    const file = join(out, name, game.manifest.file)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, block.slice(cut + 1))
  }
}

async function scanGameData(
  game: GameConfig,
  rootIndex: number,
  found: Candidate[],
  problems: Problem[],
  gameName: string,
): Promise<void> {
  const data = await gameDataDir(game)
  if (data === null) {
    const ref = game.image?.ref
    if (game.gameFiles.source !== 'mount' && ref !== undefined && ref !== '') {
      problems.push({
        where: `/games/${gameName}/image/ref`,
        message: `${ref} is not present, so ${gameName} has no core or expansions to load`,
        suggestion: `gamecrate steam build --game ${gameName}, or docker pull ${ref}`,
      })
    }
    return
  }
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

const CACHE_VERSION = 4

interface CacheFile {
  version: number
  stamp: string
  records: ModRecord[]
}

function acfPath(root: string, steamAppId: number): string {
  return join(dirname(dirname(resolvePath(expandHome(root)))), `appworkshop_${steamAppId}.acf`)
}

function contentPairs(acf: string): string[] | null {
  let text: string
  try {
    text = readFileSync(acf, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return null
  }
  const pairs = [...installedItems(text)].map(([id, item]) => `${id}:${item.manifest}`)
    .sort((a, b) => Number(a > b) - Number(a < b))
  if (pairs.length === 0 && text.trim() !== '' && Object.keys(parseAcf(text)).length === 0) return null
  return pairs
}

/**
 * Content hash across every download root, mtime for `game.workshopRoot`. The steam client owns
 * that one and leaves it alone when idle, and an unreadable acf there still means no caching.
 */
export function workshopStamp(game: GameConfig, dataRoot: string | undefined): string | null {
  const pairs: string[] = []
  for (const root of dataRoot === undefined ? [] : [downloadRoot(dataRoot, game)]) {
    const found = contentPairs(acfPath(root, game.steamAppId))
    if (found === null) return null
    pairs.push(...found)
  }
  const download = createHash('sha256')
    .update(pairs.toSorted((a, b) => Number(a > b) - Number(a < b)).join('\n'))
    .digest('hex')
  if (game.workshopRoot === null) return download
  try {
    const info = statSync(acfPath(game.workshopRoot, game.steamAppId))
    return `${download}|${info.mtimeMs}:${info.size}`
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

function rank(a: ModRecord, b: ModRecord): number {
  return compareTiers(a, b) || byClone(a, b) || Number(a.dir > b.dir) - Number(a.dir < b.dir)
}

function byClone(a: ModRecord, b: ModRecord): number {
  if (a.clonedAt === undefined || b.clonedAt === undefined) return 0
  return b.clonedAt - a.clonedAt
}

/**
 * Stamps every record inside a requested worktree, then scans the worktree itself. Only a caller
 * who stood in, typed, or exported a directory can produce `selectedWorktree`.
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
      stampOwner(record, requests)
    }
  }

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
      markWorktree(record, request)
      insert(index, record)
    }
  }

  for (const bucket of index.byPackageId.values()) bucket.sort(rank)
}

function stampOwner(record: ModRecord, requests: WorktreeRequest[]): void {
  for (const request of requests) {
    if (!contains(request, record.dir)) continue
    markWorktree(record, request)
    return
  }
}

function markWorktree(record: ModRecord, request: WorktreeRequest): void {
  record.worktree = { root: request.root, branch: request.branch, source: request.source }
  record.selectedWorktree = request.order
}

const WORKTREE_SCAN_DEPTH = 5
const WORKTREE_EXCLUDE = ['**/.retired/**', '**/node_modules/**', '**/bin/**', '**/obj/**']

/**
 * Forces one packageId to come from a named directory, whatever the profile pinned. This is the
 * only override that reaches a mod already in preCore/core/dlc/base.
 */
export function applySourceOverrides(
  index: ModIndex,
  overrides: string[],
  config: GameConfig,
): Problem[] {
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
 * Scans the game install, then every scan root in declaration order, then the source cache, then
 * the workshop roots. Without `dataRoot` there is no download root to scan.
 */
export async function buildIndex(
  game: string,
  config: GameConfig,
  plugin: GamePlugin,
  sourcesDir?: string,
  dataRoot?: string,
): Promise<ModIndex> {
  const index: ModIndex = {
    game,
    plugin,
    byPackageId: new Map(),
    byWorkshopId: new Map(),
    byShortName: new Map(),
    problems: [],
  }

  const cacheIndex = config.scanRoots.length
  await indexLocal(index, config, sourcesDir, cacheIndex)
  await indexWorkshop(index, config, dataRoot, cacheIndex)

  for (const bucket of index.byPackageId.values()) bucket.sort(rank)
  return index
}

async function indexLocal(
  index: ModIndex,
  config: GameConfig,
  sourcesDir: string | undefined,
  cacheIndex: number,
): Promise<void> {
  const local: Candidate[] = []
  await scanGameData(config, -1, local, index.problems, index.game)
  for (const [i, root] of config.scanRoots.entries()) {
    await scanLocalRoot(root, i, config.manifest.file, local)
  }
  const parsed = await parseAll(local, config, index.plugin, index.problems)
  if (sourcesDir !== undefined) {
    const cache: Candidate[] = []
    // <name-hash>/<ref>/<subdir>/<mod>
    await scanLocalRoot({ path: sourcesDir, maxDepth: 4 }, cacheIndex, config.manifest.file, cache)
    const records = await parseAll(cache, config, index.plugin, index.problems)
    parsed.push(...oneModPerClone(records, sourcesDir))
  }
  for (const record of parsed) insert(index, record)
}

async function indexWorkshop(
  index: ModIndex,
  config: GameConfig,
  dataRoot: string | undefined,
  cacheIndex: number,
): Promise<void> {
  const roots: string[] = []
  if (dataRoot !== undefined) roots.push(downloadRoot(dataRoot, config))
  if (config.workshopRoot !== null) roots.push(config.workshopRoot)
  if (roots.length === 0) return

  const stamp = workshopStamp(config, dataRoot)
  const cached = stamp === null ? null : await readWorkshopCache(index.game, stamp)
  if (cached) {
    for (const record of cached) insert(index, record)
    return
  }

  const items: Candidate[] = []
  for (const [i, root] of roots.entries()) {
    await scanWorkshopRoot(root, cacheIndex + 1 + i, config.manifest.file, items)
  }
  const records = await parseAll(items, config, index.plugin, index.problems)
  for (const record of records) insert(index, record)
  if (stamp !== null) await writeWorkshopCache(index.game, stamp, records)
}

function oneModPerClone(records: ModRecord[], sourcesDir: string): ModRecord[] {
  const kept = new Map<string, ModRecord>()
  const stamps = new Map<string, number>()
  for (const record of [...records].sort((a, b) => Number(a.dir > b.dir) - Number(a.dir < b.dir))) {
    const parts = relative(sourcesDir, record.dir).split(sep)
    const clone = parts.slice(0, 2).join(sep)
    if (parts[1]?.startsWith(RELEASE_PREFIX) === true) record.kind = 'release'
    const at = join(sourcesDir, clone)
    let stamp = stamps.get(at)
    if (stamp === undefined) {
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

/**
 * `path:` and `workshop:` are explicit; a bare string resolves as exact packageId, then the
 * game's alias map, then a CLI-only short name. Ambiguity that the ladder cannot break is fatal.
 */
export function resolveModRef(index: ModIndex, ref: string, game: GameConfig): ModRecord | null {
  return honorOverride(index, resolveRaw(index, ref, game))
}

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
  if (short?.length === 1) return pick(index, short[0]!.toLowerCase(), ref)
  if (short !== undefined && short.length > 1) {
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
    if (best.selectedWorktree !== undefined || runnerUp.selectedWorktree !== undefined) {
      throw new GamecrateError(
        `"${ref}" is declared by ${bucket!.length} indistinguishable directories`,
        Exit.Resolution,
        bucket!.map((r) => r.dir).join('\n'),
      )
    }
    if (byClone(best, runnerUp) !== 0) return best
    index.problems.push({
      where: ref,
      message: `resolved by directory name: ${bucket!.length} candidates tie on every rule`,
      suggestion: `using ${best.dir}`,
    })
  }
  return best
}

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
