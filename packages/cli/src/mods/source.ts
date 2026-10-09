import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, open, readFile, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { wantsSteam } from '../cli/args'
import { globToRegExp, resolveProfile } from '../config/load'
import { isRunning } from '../launch/prepare'
import { Exit, GamecrateError, own } from '../types'
import type { GameConfig, LibraryEntry, ModEntry, ParsedArgs, ProfileConfig } from '../types'
import { installRelease, parseRepo, readRelease } from './release'
import type { ReleasePin } from './release'
import { ago } from './staleness'

export type GitRef = { kind: 'branch' | 'tag' | 'commit'; value: string }

const SLUG_LIMIT = 24

/** The directory-name prefix that tells the index an extraction is not a checkout. */
export const RELEASE_PREFIX = 'release-'

/**
 * A library pin by id, case-blind. Exact then lowercase covers every normal config without a
 * scan; the scan is the only way to reach a mixed-case key from a ref spelled differently.
 */
export function libraryPin(game: GameConfig, id: string): LibraryEntry | undefined {
  const lower = id.toLowerCase()
  const direct = own(game.library, id) ?? own(game.library, lower)
  if (direct !== undefined) return direct
  const key = Object.keys(game.library ?? {}).find((k) => k.toLowerCase() === lower)
  return key === undefined ? undefined : own(game.library, key)
}

export function sourcesRoot(dataRoot: string): string {
  return join(dataRoot, 'sources')
}

// `a/b`, `a/b.git`, `a/b/` and `a/b/.git/` are one clone. scheme and host fold because they are
// case-insensitive; path and userinfo do not, some forges treat both as significant.
export function normalizeUrl(url: string): string {
  let trimmed = url
  while (trimmed.endsWith('/') || trimmed.endsWith('.git')) {
    trimmed = trimmed.slice(0, trimmed.endsWith('/') ? -1 : -4)
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed.replace(
      /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@]*@)?([^/]*)/,
      (_, scheme: string, user: string | undefined, host: string) =>
        `${scheme.toLowerCase()}${user ?? ''}${host.toLowerCase()}`,
    )
  }
  return trimmed.replace(/^([^@/:]+@)?([^@/:]+):/, (_, user: string | undefined, host: string) =>
    `${user ?? ''}${host.toLowerCase()}:`)
}

export function cloneDir(dataRoot: string, url: string, ref: GitRef): string {
  const normal = normalizeUrl(url)
  const name = `${slug(lastSegment(normal))}-${hash(normal, 12)}`
  return join(sourcesRoot(dataRoot), name, `${ref.kind}-${slug(ref.value)}-${hash(ref.value, 6)}`)
}

export function releaseDir(dataRoot: string, repo: string, tag: string): string {
  const normal = parseRepo(repo)
  const name = `${slug(lastSegment(normal))}-${hash(normal, 12)}`
  return join(sourcesRoot(dataRoot), name, `${RELEASE_PREFIX}${slug(tag)}-${hash(tag, 6)}`)
}

export function releasePinOf(entry: LibraryEntry): ReleasePin | undefined {
  if (entry.release === undefined) return undefined
  return {
    repo: entry.release,
    ...(entry.tag === undefined ? {} : { tag: entry.tag }),
    ...(entry.asset === undefined ? {} : { asset: entry.asset }),
  }
}

/**
 * The extraction an unpinned `release` left behind, when there is exactly one. Ambiguous means
 * no answer, so a command that may not reach the network says "not fetched" instead of guessing.
 */
export function soleReleaseDir(dataRoot: string, repo: string): string | undefined {
  const at = dirname(releaseDir(dataRoot, repo, 'x'))
  let names: string[]
  try {
    names = readdirSync(at, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(RELEASE_PREFIX))
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  return names.length === 1 ? join(at, names[0]!) : undefined
}

/**
 * A pinned tag never moves, so its extraction is reused untouched. Unpinned asks github which
 * release is latest, which is what makes a new release refetch. `force` re-downloads either way.
 */
export async function ensureRelease(
  dataRoot: string,
  pin: ReleasePin,
  mode: SyncMode,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult> {
  if (pin.tag !== undefined) {
    const dir = releaseDir(dataRoot, pin.repo, pin.tag)
    if (existsSync(dir) && mode !== 'force') return { dir }
    if (mode === 'use') {
      throw new GamecrateError(
        `no extraction of ${pin.repo} ${pin.tag} on disk`,
        Exit.Resolution,
        'fetch it with: gamecrate mods sync',
      )
    }
    await installRelease(pin, await readRelease(pin, fetchImpl), dir, fetchImpl)
    return { dir }
  }

  if (mode === 'use') {
    const found = soleReleaseDir(dataRoot, pin.repo)
    if (found !== undefined) return { dir: found }
    throw new GamecrateError(
      `no extraction of ${pin.repo} on disk`,
      Exit.Resolution,
      'fetch it with: gamecrate mods sync',
    )
  }
  const release = await readRelease(pin, fetchImpl)
  const dir = releaseDir(dataRoot, pin.repo, release.tag)
  if (existsSync(dir) && mode !== 'force') return { dir }
  await installRelease(pin, release, dir, fetchImpl)
  return { dir }
}

function lastSegment(url: string): string {
  return url.split(/[/:]/).findLast((part) => part.length > 0) ?? 'repo'
}

function slug(value: string): string {
  const out = value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')
  return (out.length === 0 ? 'x' : out).slice(0, SLUG_LIMIT)
}

function hash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

export interface GitPin { url: string; ref?: GitRef; subdir?: string }

// `use` never touches the network, `fetch` moves a branch, `force` also moves a tag or commit
export type SyncMode = 'use' | 'fetch' | 'force'

export interface SyncResult { dir: string; warning?: string }

const LOCK_POLL_MS = 50
const LOCK_TIMEOUT_MS = 30_000

export function isMoving(ref: GitRef): boolean {
  return ref.kind === 'branch'
}

export function gitRefOf(pin: { branch?: string; tag?: string; commit?: string }): GitRef | undefined {
  if (pin.branch !== undefined) return { kind: 'branch', value: pin.branch }
  if (pin.tag !== undefined) return { kind: 'tag', value: pin.tag }
  if (pin.commit !== undefined) return { kind: 'commit', value: pin.commit }
  return undefined
}

function git(cwd: string | undefined, argv: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('git', argv, { cwd, encoding: 'utf8' })
  if (r.error) throw new GamecrateError('git is not on PATH', Exit.Environment)
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function defaultBranch(url: string): GitRef {
  const r = git(undefined, ['ls-remote', '--symref', url, 'HEAD'])
  const match = r.code === 0 ? /^ref:\s+refs\/heads\/(\S+)/m.exec(r.stdout) : null
  if (match === null) {
    throw new GamecrateError(`could not read the default branch of ${url}`, Exit.Environment, r.stderr.trim() || undefined)
  }
  return { kind: 'branch', value: match[1] as string }
}

export async function ensureClone(dataRoot: string, pin: GitPin, ref: GitRef, mode: SyncMode): Promise<SyncResult> {
  const dir = cloneDir(dataRoot, pin.url, ref)
  if (!cloned(dir)) return await create(dir, pin.url, ref, mode)
  if (mode === 'use') return { dir }
  if (!isMoving(ref) && mode !== 'force') return { dir }
  for (const argv of syncSteps(ref)) {
    const r = git(dir, argv)
    if (r.code !== 0) return { dir, warning: staleWarning(dir, pin.url, argv[0] as string) }
  }
  return { dir }
}

function cloned(dir: string): boolean {
  if (!existsSync(join(dir, '.git'))) return false
  return git(dir, ['rev-parse', '--verify', 'HEAD']).code === 0
}

async function create(dir: string, url: string, ref: GitRef, mode: SyncMode): Promise<SyncResult> {
  if (mode === 'use') {
    throw new GamecrateError(`no clone of ${url} on disk`, Exit.Resolution, 'fetch it with: gamecrate mods sync')
  }
  await rm(dir, { recursive: true, force: true })
  await mkdir(dirname(dir), { recursive: true })
  const clone = git(undefined, ['clone', url, dir])
  const target = ref.kind === 'branch' ? `origin/${ref.value}` : ref.value
  const out = clone.code === 0 ? git(dir, ['checkout', '--detach', target]) : clone
  if (out.code !== 0) {
    await rm(dir, { recursive: true, force: true })
    throw new GamecrateError(`could not clone ${url} at ${ref.kind} ${ref.value}`, Exit.Environment, out.stderr.trim() || undefined)
  }
  return { dir }
}

function syncSteps(ref: GitRef): string[][] {
  if (ref.kind === 'branch') return [['fetch', 'origin', ref.value], ['reset', '--hard', `origin/${ref.value}`]]
  if (ref.kind === 'tag') return [['fetch', '--tags', '--force', 'origin'], ['reset', '--hard', ref.value]]
  return [['fetch', 'origin', ref.value], ['reset', '--hard', ref.value]]
}

function staleWarning(dir: string, url: string, step: string): string {
  const what = step === 'fetch' ? `could not fetch ${url}` : `could not reset the clone of ${url}`
  const r = git(dir, ['log', '-1', '--format=%h %ct'])
  const [sha, seconds] = r.stdout.trim().split(' ')
  if (sha === undefined || seconds === undefined) return `${what}, using the clone already on disk`
  return `${what}, using ${sha} from ${ago(Number(seconds) * 1000)}`
}

// scope is the caller's call: `prepareSources` holds it across a whole build, `mods sync` wraps
// it tightly around one `ensureClone`
export async function lockDir(dir: string): Promise<() => Promise<void>> {
  const path = `${dir}.lock`
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    const handle = await open(path, 'wx').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
      return null
    })
    if (handle !== null) {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      await handle.close()
      return releaser(path)
    }
    const seen = await orphaned(path)
    if (seen !== undefined) await unlinkOrphan(path, seen)
    else await sleep(LOCK_POLL_MS)
    if (Date.now() >= deadline) {
      throw new GamecrateError(
        `another gamecrate is using ${dir}`,
        Exit.Environment,
        `if that is wrong, delete ${path}`,
      )
    }
  }
}

async function orphaned(path: string): Promise<string | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let held: { pid?: number; startedAt?: string }
  try {
    held = JSON.parse(text) as { pid?: number; startedAt?: string }
  } catch {
    return undefined
  }
  const pid = held.pid
  if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined
  return isRunning(pid as number, held.startedAt) ? undefined : text
}

export async function unlinkOrphan(path: string, seen: string): Promise<boolean> {
  const now = await readFile(path, 'utf8').catch(() => undefined)
  if (now !== seen) return false
  await unlink(path).catch(() => {})
  return true
}

function releaser(path: string): () => Promise<void> {
  let done = false
  return async (): Promise<void> => {
    if (done) return
    done = true
    await unlink(path).catch(() => {})
  }
}

export interface PreparedSources {
  /** lowercased packageId -> clone directory. Handed to resolvePlan as `sources`. */
  dirs: Map<string, string>
  warnings: string[]
  /** One entry per distinct clone this call handled, fetched or reused. Makes dedupe testable. */
  fetched: string[]
  /** Released by execute(), and by run()'s finally. Never before buildLocalMods. */
  release: () => Promise<void>
}

/**
 * Every entry a launch of this profile reaches, in collectSlots order, minus what `exclude` and
 * `--without` drop by id. A `match:` glob has no id to drop by, so it survives to the index.
 */
export function reachedEntries(
  game: GameConfig,
  profile: ProfileConfig,
  args: Partial<ParsedArgs>,
): ModEntry[] {
  const out: ModEntry[] = [...(game.preCore ?? []), game.core, ...game.dlc]
  if (game.steamlessMod !== undefined && !wantsSteam(args, profile)) out.push(game.steamlessMod)
  if (profile.includeBase !== false) out.push(...(game.base ?? []))
  const only = args.only ?? []
  out.push(...(only.length > 0 ? only : (profile.mods ?? [])), ...(args.mods ?? []))
  const dropped = [...(profile.exclude ?? []), ...(args.without ?? [])].map(globToRegExp)
  return out.filter((entry) => {
    if (typeof entry !== 'string' && 'match' in entry) return true
    const id = typeof entry === 'string' ? entry : entry.id
    return !dropped.some((pattern) => pattern.test(id))
  })
}

function pinnableIds(game: GameConfig, profile: ProfileConfig, args: Partial<ParsedArgs>): string[] {
  const out: string[] = []
  for (const entry of reachedEntries(game, profile, args)) {
    if (typeof entry === 'string') {
      if (!entry.includes(':')) out.push(entry)
      continue
    }
    if ('match' in entry) continue
    if (entry.path === undefined && entry.workshop === undefined && !entry.id.includes(':')) out.push(entry.id)
  }
  return out
}

function releaseCacheDir(dataRoot: string, pin: ReleasePin): string | undefined {
  return pin.tag === undefined ? soleReleaseDir(dataRoot, pin.repo) : releaseDir(dataRoot, pin.repo, pin.tag)
}

/** The map `prepareSources` builds, read off the cache alone: no lock, no clone, no network. */
export function cachedSources(
  game: GameConfig,
  profileName: string,
  args: Partial<ParsedArgs>,
  dataRoot: string,
): Map<string, string> {
  const dirs = new Map<string, string>()
  for (const id of pinnableIds(game, resolveProfile(game, profileName), args)) {
    const key = id.toLowerCase()
    if (dirs.has(key)) continue
    const pin = libraryPin(game, id)
    if (pin === undefined) continue
    const dir = cachedDirOf(pin, dataRoot)
    if (dir !== undefined) dirs.set(key, dir)
  }
  return dirs
}

function cachedDirOf(pin: LibraryEntry, dataRoot: string): string | undefined {
  const released = releasePinOf(pin)
  if (released !== undefined) {
    const at = releaseCacheDir(dataRoot, released)
    return at !== undefined && existsSync(at) ? at : undefined
  }
  if (pin.git === undefined) return undefined
  const ref = gitRefOf(pin)
  const dir = ref === undefined ? soleBranchClone(dataRoot, pin.git) : cloneDir(dataRoot, pin.git, ref)
  return dir !== undefined && existsSync(dir) ? dir : undefined
}

function soleBranchClone(dataRoot: string, url: string): string | undefined {
  const repo = dirname(cloneDir(dataRoot, url, { kind: 'branch', value: 'x' }))
  let names: string[]
  try {
    names = readdirSync(repo, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('branch-'))
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  return names.length === 1 ? join(repo, names[0]!) : undefined
}

interface SourcePlan {
  dirs: Map<string, string>
  jobs: Map<string, { pin: GitPin; ref: GitRef }>
  releases: Map<string, { pin: ReleasePin; keys: string[] }>
}

/** Locks are taken in this order, so two gamecrate processes cannot hold each other's. */
function sorted(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => Number(a > b) - Number(a < b))
}

function addReleaseJob(plan: SourcePlan, key: string, released: ReleasePin): void {
  const at = `${parseRepo(released.repo)}\u0000${released.tag ?? ''}\u0000${released.asset ?? ''}`
  const job = plan.releases.get(at)
  if (job === undefined) plan.releases.set(at, { pin: released, keys: [key] })
  else job.keys.push(key)
}

function addGitJob(
  plan: SourcePlan,
  branches: Map<string, GitRef>,
  dataRoot: string,
  key: string,
  pin: LibraryEntry & { git: string },
): void {
  let ref = gitRefOf(pin)
  if (ref === undefined) {
    const url = normalizeUrl(pin.git)
    ref = branches.get(url) ?? defaultBranch(pin.git)
    branches.set(url, ref)
  }
  const dir = cloneDir(dataRoot, pin.git, ref)
  plan.dirs.set(key, dir)
  if (plan.jobs.has(dir)) return
  plan.jobs.set(dir, { pin: { url: pin.git }, ref })
}

function planSources(
  game: GameConfig,
  profileName: string,
  args: ParsedArgs,
  dataRoot: string,
): SourcePlan {
  const plan: SourcePlan = { dirs: new Map(), jobs: new Map(), releases: new Map() }
  const branches = new Map<string, GitRef>()

  for (const id of pinnableIds(game, resolveProfile(game, profileName), args)) {
    const key = id.toLowerCase()
    if (plan.dirs.has(key)) continue
    const pin = libraryPin(game, id)
    if (pin === undefined) continue

    const released = releasePinOf(pin)
    if (released !== undefined) {
      addReleaseJob(plan, key, released)
      continue
    }
    if (pin.git === undefined) continue
    addGitJob(plan, branches, dataRoot, key, { ...pin, git: pin.git })
  }

  return plan
}

interface Acquired {
  locks: (() => Promise<void>)[]
  fetched: string[]
  warnings: string[]
}

async function cloneGitJobs(
  plan: SourcePlan,
  dataRoot: string,
  allowFetch: boolean,
  out: Acquired,
): Promise<void> {
  for (const dir of sorted(plan.jobs.keys())) {
    const job = plan.jobs.get(dir) as { pin: GitPin; ref: GitRef }
    out.locks.push(await lockDir(dir))
    const result = await ensureClone(dataRoot, job.pin, job.ref, allowFetch ? 'fetch' : 'use')
    out.fetched.push(result.dir)
    if (result.warning !== undefined) out.warnings.push(result.warning)
  }
}

async function fetchReleaseJobs(
  plan: SourcePlan,
  dataRoot: string,
  allowFetch: boolean,
  fetchImpl: typeof fetch,
  out: Acquired,
): Promise<void> {
  const held = new Set<string>()
  for (const at of sorted(plan.releases.keys())) {
    const job = plan.releases.get(at) as { pin: ReleasePin; keys: string[] }
    const repoDir = dirname(releaseDir(dataRoot, job.pin.repo, 'x'))
    if (!held.has(repoDir)) {
      held.add(repoDir)
      out.locks.push(await lockDir(repoDir))
    }
    const result = await ensureRelease(dataRoot, job.pin, allowFetch ? 'fetch' : 'use', fetchImpl)
    out.fetched.push(result.dir)
    for (const key of job.keys) plan.dirs.set(key, result.dir)
  }
}

/**
 * Clones or fetches every git-pinned mod the run will ask for, before the index is built, and
 * keeps one lock per clone until the caller releases it.
 */
export async function prepareSources(
  game: GameConfig,
  profileName: string,
  args: ParsedArgs,
  dataRoot: string,
  allowFetch: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedSources> {
  const plan = planSources(game, profileName, args, dataRoot)
  const out: Acquired = { locks: [], fetched: [], warnings: [] }
  const release = async (): Promise<void> => {
    for (const unlock of out.locks) await unlock()
  }

  try {
    await cloneGitJobs(plan, dataRoot, allowFetch, out)
    await fetchReleaseJobs(plan, dataRoot, allowFetch, fetchImpl, out)
  } catch (error) {
    await release()
    throw error
  }
  return { dirs: plan.dirs, warnings: out.warnings, fetched: out.fetched, release }
}
