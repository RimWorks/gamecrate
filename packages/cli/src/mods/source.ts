import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, open, readFile, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { globToRegExp, resolveProfile } from '../config/load'
import { isRunning } from '../launch/prepare'
import { Exit, GamecrateError, own } from '../types'
import type { GameConfig, LibraryEntry, ModEntry, ParsedArgs, ProfileConfig } from '../types'
import { ago } from './staleness'

export type GitRef = { kind: 'branch' | 'tag' | 'commit'; value: string }

const SLUG_LIMIT = 24

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

// derived, never interpolated: `git reset --hard` runs in here and a url path segment of `..`
// would aim it outside the cache. the hash also covers file:// and ssh urls, which have no
// host/owner/repo triple.
export function cloneDir(dataRoot: string, url: string, ref: GitRef): string {
  const normal = normalizeUrl(url)
  const name = `${slug(lastSegment(normal))}-${hash(normal, 12)}`
  return join(sourcesRoot(dataRoot), name, `${ref.kind}-${slug(ref.value)}-${hash(ref.value, 6)}`)
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

// `ref` is a parameter, never derived here. working it out needs `ls-remote`, and resolution does
// that once per launch, so deriving it here would put a network call inside `verify`
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

// `.git` presence is not validity: a clone killed with SIGKILL leaves HEAD, config, objects and refs
// behind with no commit and no fetch refspec, so every later fetch exits 0 writing only FETCH_HEAD and
// every reset fails, forever. HEAD resolving is the real test, and `existsSync` keeps the common
// absent case from paying for a spawn
function cloned(dir: string): boolean {
  if (!existsSync(join(dir, '.git'))) return false
  return git(dir, ['rev-parse', '--verify', 'HEAD']).code === 0
}

async function create(dir: string, url: string, ref: GitRef, mode: SyncMode): Promise<SyncResult> {
  if (mode === 'use') {
    throw new GamecrateError(`no clone of ${url} on disk`, Exit.Resolution, 'fetch it with: gamecrate mods sync')
  }
  // git refuses to clone into a non-empty directory, so a half-created one goes first
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

// a tag needs `--force` to move at all, and a commit has to be fetched by name to reset toward
function syncSteps(ref: GitRef): string[][] {
  if (ref.kind === 'branch') return [['fetch', 'origin', ref.value], ['reset', '--hard', `origin/${ref.value}`]]
  if (ref.kind === 'tag') return [['fetch', '--tags', '--force', 'origin'], ['reset', '--hard', ref.value]]
  return [['fetch', 'origin', ref.value], ['reset', '--hard', ref.value]]
}

// a clone already on disk is usable, so a dead remote is a warning naming what we fell back to
function staleWarning(dir: string, url: string, step: string): string {
  const what = step === 'fetch' ? `could not fetch ${url}` : `could not reset the clone of ${url}`
  const r = git(dir, ['log', '-1', '--format=%h %ct'])
  const [sha, seconds] = r.stdout.trim().split(' ')
  if (sha === undefined || seconds === undefined) return `${what}, using the clone already on disk`
  return `${what}, using ${sha} from ${ago(Number(seconds) * 1000)}`
}

// scope is the caller's call: `prepareSources` holds it across a whole build, `mods sync` wraps
// it tightly around one `ensureClone`. the record is the launch lock's pid/startedAt shape, so
// `isRunning` can tell a live holder from a crashed one and this takes the lock over rather than
// wedging the directory forever
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

// a lock naming no live holder is one nobody will ever release. an unreadable one is left alone on
// purpose: a lock is created empty and written a moment later, so stealing on a parse failure would
// race the holder that just took it
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

// unlinks only while the lock still reads as the dead record we saw, so two processes stealing one
// orphan cannot both end up holding it
// residual: the re-read and the unlink are two syscalls, the same window `unlinkHeld` carries
export async function unlinkOrphan(path: string, seen: string): Promise<boolean> {
  const now = await readFile(path, 'utf8').catch(() => undefined)
  if (now !== seen) return false
  await unlink(path).catch(() => {})
  return true
}

// once only, a second call would unlink whatever lock the next holder has since taken
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
  // every slot collectSlots emits, not just base: a pin named from preCore, core or dlc is
  // still a pin, and one that never clones fails the launch it was added for.
  const out: ModEntry[] = [...(game.preCore ?? []), game.core, ...game.dlc]
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

// only ids a library pin could name: a `workshop:`/`path:` ref and an inline path or workshop id
// already say where the mod lives, and a `match:` glob needs the index the clone has to precede.
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

/**
 * The map `prepareSources` builds, read off the cache alone: no lock, no clone, no network.
 * `mods` and `verify` must not fetch, but with no map at all a git pin's `subdir` is dropped and
 * the scan answers by packageId instead, which is a coin flip between two directories of one
 * repo. An unpinned entry has no ref to derive a directory from, so it takes the one `branch-*`
 * clone already on disk.
 */
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
    if (pin?.git === undefined) continue
    const ref = gitRefOf(pin)
    const dir = ref === undefined ? soleBranchClone(dataRoot, pin.git) : cloneDir(dataRoot, pin.git, ref)
    if (dir !== undefined && existsSync(dir)) dirs.set(key, dir)
  }
  return dirs
}

// two default-branch clones of one url is not worth guessing at: no entry leaves the scan in
// charge, which is where an unmapped id was already.
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

/**
 * Clones or fetches every git-pinned mod the run will ask for, before the index is built, and
 * keeps one lock per clone until the caller releases it. `git()` is spawnSync, so these
 * serialize whatever this function looks like.
 */
export async function prepareSources(
  game: GameConfig,
  profileName: string,
  args: ParsedArgs,
  dataRoot: string,
  allowFetch: boolean,
): Promise<PreparedSources> {
  const dirs = new Map<string, string>()
  const warnings: string[] = []
  const fetched: string[] = []
  const locks: (() => Promise<void>)[] = []
  const release = async (): Promise<void> => {
    for (const unlock of locks) await unlock()
  }
  // one ls-remote per url, not per pin
  const branches = new Map<string, GitRef>()
  const jobs = new Map<string, { pin: GitPin; ref: GitRef }>()
  for (const id of pinnableIds(game, resolveProfile(game, profileName), args)) {
    const key = id.toLowerCase()
    if (dirs.has(key)) continue
    const pin = libraryPin(game, id)
    if (pin?.git === undefined) continue
    let ref = gitRefOf(pin)
    if (ref === undefined) {
      const url = normalizeUrl(pin.git)
      ref = branches.get(url) ?? defaultBranch(pin.git)
      branches.set(url, ref)
    }
    const dir = cloneDir(dataRoot, pin.git, ref)
    dirs.set(key, dir)
    if (jobs.has(dir)) continue
    jobs.set(dir, { pin: { url: pin.git }, ref })
  }

  try {
    // ordered by clone directory, never by id: two ids can name one clone, so sorting ids lets
    // two runs take the same pair of locks in opposite order and sit on the timeout
    for (const dir of [...jobs.keys()].sort()) {
      const job = jobs.get(dir) as { pin: GitPin; ref: GitRef }
      locks.push(await lockDir(dir))
      const result = await ensureClone(dataRoot, job.pin, job.ref, allowFetch ? 'fetch' : 'use')
      fetched.push(result.dir)
      if (result.warning !== undefined) warnings.push(result.warning)
    }
  } catch (error) {
    await release()
    throw error
  }
  return { dirs, warnings, fetched, release }
}
