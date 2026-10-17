import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { installedItems } from './acf'
import { mapLimit } from '../concurrency'

const ENDPOINT = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'
const CHUNK = 100
const TIMEOUT_MS = 5_000

/** Written inside an item directory once a download completes, holding steam's own `time_updated`. */
export const FETCH_STAMP = '.gamecrate-fetched'

export interface DriftReport {
  /** Ids that need steamcmd, because they drifted, are absent from the .acf, or are not on disk. */
  needed: string[]
  /** Ids steam will not serve: removed, private or hidden. Not the same as up to date. */
  unavailable: string[]
  warnings: string[]
  /** Steam's `time_updated` per id, for the downloader to record on success. */
  published: Map<string, number>
}

type Detail = { result: number; timeUpdated: number }

/**
 * Which of these items changed, without spawning anything. `roots` is every workshop content
 * root, what `mountedRoots` returns, and none of them has to exist.
 */
export async function checkDrift(
  ids: string[],
  roots: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<DriftReport> {
  const wanted = [...new Set(ids)]
  const { loaded, present } = await installs(wanted, roots)
  const missing = wanted.filter((id) => !present.has(id))

  let details: Map<string, Detail>
  try {
    details = await published(wanted, fetchImpl)
  } catch (error) {
    return {
      needed: missing,
      unavailable: [],
      warnings: [`could not ask steam which items changed (${reason(error)}); only missing items will download`],
      published: new Map(),
    }
  }

  const needed = new Set(missing)
  const unavailable: string[] = []
  const warnings: string[] = []
  for (const id of wanted) {
    const detail = details.get(id)
    if (detail === undefined) continue
    if (detail.result !== 1) {
      warnings.push(`workshop item ${id} is not available (result ${detail.result}); skipping it`)
      needed.delete(id)
      unavailable.push(id)
      continue
    }
    const local = loaded.get(id)
    if (local !== undefined && detail.timeUpdated > local) needed.add(id)
  }
  const stamps = new Map<string, number>()
  for (const [id, detail] of details) if (detail.result === 1) stamps.set(id, detail.timeUpdated)
  return { needed: [...needed], unavailable, warnings, published: stamps }
}

async function installs(
  ids: string[],
  roots: string[],
): Promise<{ loaded: Map<string, number>; present: Set<string> }> {
  const loaded = new Map<string, number>()
  const present = new Set<string>()
  for (const root of roots) {
    const fromClient = installedItems(await readText(acfPath(root)))
    const here = await mapLimit(ids, async (id) => {
      const dir = join(root, id)
      const ours = await readFetchStamp(dir)
      const theirs = (await isDirectory(dir)) ? fromClient.get(id)?.timeupdated : undefined
      if (ours === undefined && theirs === undefined) return undefined
      return Math.max(ours ?? 0, theirs ?? 0)
    })
    for (const [i, id] of ids.entries()) {
      const stamp = here[i]
      if (stamp === undefined) continue
      present.add(id)
      if (!loaded.has(id)) loaded.set(id, stamp)
    }
  }
  return { loaded, present }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function readFetchStamp(dir: string): Promise<number | undefined> {
  try {
    const parsed = Number((await readFile(join(dir, FETCH_STAMP), 'utf8')).trim())
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function published(ids: string[], fetchImpl: typeof fetch): Promise<Map<string, Detail>> {
  const out = new Map<string, Detail>()
  if (ids.length === 0) return out
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(`no answer in ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  try {
    const pages = await mapLimit(chunks, async (chunk) => {
      const body = new URLSearchParams({ itemcount: String(chunk.length) })
      chunk.forEach((id, n) => body.set(`publishedfileids[${n}]`, id))
      const response = await fetchImpl(ENDPOINT, { method: 'POST', body, signal: abort.signal })
      if (!response.ok) throw new Error(`steam answered ${response.status}`)
      return readDetails(await response.json())
    })
    for (const page of pages) for (const [id, detail] of page) out.set(id, detail)
  } finally {
    clearTimeout(timer)
  }
  return out
}

function readDetails(payload: unknown): Map<string, Detail> {
  const list = (payload as { response?: { publishedfiledetails?: unknown } })?.response?.publishedfiledetails
  if (!Array.isArray(list)) throw new Error('steam returned a body this does not understand')
  const out = new Map<string, Detail>()
  for (const entry of list as Record<string, unknown>[]) {
    const id = entry['publishedfileid']
    const result = entry['result']
    if (typeof id !== 'string' || typeof result !== 'number') {
      throw new TypeError('steam returned a body this does not understand')
    }
    out.set(id, { result, timeUpdated: Number(entry['time_updated']) || 0 })
  }
  return out
}

function acfPath(root: string): string {
  return join(dirname(dirname(root)), `appworkshop_${basename(root)}.acf`)
}


async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
