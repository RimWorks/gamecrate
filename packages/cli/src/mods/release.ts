import { spawnSync } from 'node:child_process'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { globToRegExp } from '../config/load'
import { Exit, GamecrateError } from '../types'

export interface ReleasePin {
  /** `owner/repo`. */
  repo: string
  /** Release tag. Absent means whichever release GitHub calls latest. */
  tag?: string
  /** Glob over asset names. Absent means `*.zip`. */
  asset?: string
}

export interface ReleaseAsset {
  name: string
  url: string
}

export interface Release {
  tag: string
  assets: ReleaseAsset[]
}

const API = 'https://api.github.com'
const TIMEOUT_MS = 20_000
const DEFAULT_ASSET = '*.zip'
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

export function parseRepo(spec: string): string {
  const trimmed = spec.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
  if (!REPO_PATTERN.test(trimmed)) {
    throw new GamecrateError(`"${spec}" is not a GitHub repository`, Exit.Config, 'write it as owner/repo')
  }
  return trimmed
}

/** `GITHUB_TOKEN` then `GH_TOKEN`, the two names the gh CLI already reads. */
export function releaseToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function headers(accept: string, env?: NodeJS.ProcessEnv): Record<string, string> {
  const token = releaseToken(env)
  return {
    accept,
    'user-agent': 'gamecrate',
    'x-github-api-version': '2022-11-28',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

async function call(url: string, accept: string, fetchImpl: typeof fetch, env?: NodeJS.ProcessEnv): Promise<Response> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(`no answer in ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  try {
    return await fetchImpl(url, { headers: headers(accept, env), signal: abort.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

function rateLimited(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false
  return response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429
}

function rateLimitError(repo: string, response: Response): GamecrateError {
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : 'later'
  const authed = releaseToken() !== undefined
  return new GamecrateError(
    `github rate-limited the release lookup for ${repo}`,
    Exit.Environment,
    authed ? `the limit resets at ${when}` : `set GITHUB_TOKEN to raise the limit, or wait until ${when}`,
  )
}

function notFoundError(repo: string, what: string): GamecrateError {
  return new GamecrateError(
    `github has no ${what} for ${repo}`,
    Exit.Resolution,
    `check the spelling, and set GITHUB_TOKEN if ${repo} is private`,
  )
}

export async function readRelease(
  pin: ReleasePin,
  fetchImpl: typeof fetch = fetch,
  env?: NodeJS.ProcessEnv,
): Promise<Release> {
  const repo = parseRepo(pin.repo)
  const where = pin.tag === undefined ? 'releases/latest' : `releases/tags/${encodeURIComponent(pin.tag)}`
  const response = await call(`${API}/repos/${repo}/${where}`, 'application/vnd.github+json', fetchImpl, env)
  if (rateLimited(response)) throw rateLimitError(repo, response)
  if (response.status === 404) {
    throw notFoundError(repo, pin.tag === undefined ? 'published release' : `release tagged ${pin.tag}`)
  }
  if (!response.ok) {
    throw new GamecrateError(`github answered ${response.status} for ${repo}`, Exit.Environment)
  }
  return readReleaseBody(repo, await response.json())
}

function readReleaseBody(repo: string, payload: unknown): Release {
  const body = payload as { tag_name?: unknown; assets?: unknown }
  const tag = body?.tag_name
  if (typeof tag !== 'string' || tag === '') {
    throw new GamecrateError(`github returned a release for ${repo} with no tag`, Exit.Environment)
  }
  const list = Array.isArray(body.assets) ? (body.assets as Record<string, unknown>[]) : []
  const assets: ReleaseAsset[] = []
  for (const entry of list) {
    const name = entry['name']
    const url = entry['url']
    if (typeof name === 'string' && typeof url === 'string') assets.push({ name, url })
  }
  return { tag, assets }
}

export function pickAsset(release: Release, repo: string, glob = DEFAULT_ASSET): ReleaseAsset {
  const pattern = globToRegExp(glob)
  const matched = release.assets.filter((asset) => pattern.test(asset.name))
  const listed = release.assets.length === 0
    ? '  (the release publishes no assets)'
    : release.assets.map((asset) => `  ${asset.name}`).join('\n')
  if (matched.length === 0) {
    throw new GamecrateError(
      `no asset of ${repo} ${release.tag} matches "${glob}"`,
      Exit.Resolution,
      `assets in that release:\n${listed}`,
    )
  }
  if (matched.length > 1) {
    const names = matched.map((asset) => `  ${asset.name}`).join('\n')
    throw new GamecrateError(
      `${matched.length} assets of ${repo} ${release.tag} match "${glob}"`,
      Exit.Resolution,
      `narrow "asset" to one of:\n${names}`,
    )
  }
  return matched[0] as ReleaseAsset
}

export async function downloadAsset(
  asset: ReleaseAsset,
  repo: string,
  dest: string,
  fetchImpl: typeof fetch = fetch,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const response = await call(asset.url, 'application/octet-stream', fetchImpl, env)
  if (rateLimited(response)) throw rateLimitError(repo, response)
  if (!response.ok) {
    throw new GamecrateError(
      `could not download ${asset.name} from ${repo}: github answered ${response.status}`,
      Exit.Environment,
    )
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.from(await response.arrayBuffer()))
}

const WINDOWS_ABSOLUTE = /^([a-zA-Z]:|\\)/

function escapes(entry: string): boolean {
  const name = entry.replace(/\\/g, '/')
  if (name.startsWith('/') || WINDOWS_ABSOLUTE.test(entry)) return true
  return name.split('/').includes('..')
}

function listZip(flag: string, zip: string): string[] {
  const r = spawnSync('unzip', [flag, zip], { encoding: 'utf8' })
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new GamecrateError('unzip is not on PATH', Exit.Environment, 'install unzip, then run this again')
  }
  if ((r.status ?? 1) !== 0) {
    throw new GamecrateError(`could not read ${zip}`, Exit.Environment, (r.stderr ?? '').trim() || undefined)
  }
  return (r.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function refuse(zip: string, what: string, entry: string): never {
  throw new GamecrateError(
    `${zip} holds ${what}: ${entry}`,
    Exit.Resolution,
    'that entry can write outside the mod directory, so gamecrate unpacks nothing. ask the release author for a clean asset, or point this mod at a path or git source',
  )
}

/** Refuses an archive that could write outside `dir`, rather than trusting the host unzip to sanitize it. */
export function checkZip(zip: string): void {
  for (const entry of listZip('-Z1', zip)) {
    if (escapes(entry)) refuse(zip, 'an entry with a path outside the archive', entry)
  }
  for (const line of listZip('-Z', zip)) {
    if (!line.startsWith('l')) continue
    refuse(zip, 'a symlink entry', line.split(/\s+/).slice(8).join(' ') || line)
  }
}

export function unzipInto(zip: string, dir: string): void {
  checkZip(zip)
  const r = spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { encoding: 'utf8' })
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new GamecrateError('unzip is not on PATH', Exit.Environment, 'install unzip, then run this again')
  }
  if ((r.status ?? 1) !== 0) {
    throw new GamecrateError(`could not unpack ${zip}`, Exit.Environment, (r.stderr ?? '').trim() || undefined)
  }
}

export function unzipPresent(): boolean {
  const r = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
  return r.error === undefined && (r.status ?? 1) === 0
}

/** Downloads the one asset a pin selects and unpacks it into `dir`, which it owns and replaces. */
export async function installRelease(
  pin: ReleasePin,
  release: Release,
  dir: string,
  fetchImpl: typeof fetch = fetch,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const repo = parseRepo(pin.repo)
  const asset = pickAsset(release, repo, pin.asset)
  const staging = `${dir}.part`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    const zip = join(staging, 'asset.zip')
    await downloadAsset(asset, repo, zip, fetchImpl, env)
    const unpacked = join(staging, 'unpacked')
    await mkdir(unpacked, { recursive: true })
    unzipInto(zip, unpacked)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dirname(dir), { recursive: true })
    await rename(unpacked, dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
