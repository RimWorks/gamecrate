import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { installedItems } from './acf'

const ENDPOINT = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'
const CHUNK = 100
const TIMEOUT_MS = 5_000

export interface DriftReport {
  /** Ids that need steamcmd, because they drifted, are absent from the .acf, or are not on disk. */
  needed: string[]
  /** Ids steam will not serve: removed, private or hidden. Not the same as up to date. */
  unavailable: string[]
  warnings: string[]
}

type Detail = { result: number; timeUpdated: number }

/**
 * Which of these items changed, without spawning anything. `roots` is every workshop content
 * root, what `downloadRoots` returns, and none of them has to exist. The whole check is best
 * effort: any failure downgrades to the items that are not on disk, never to fetching everything.
 */
export async function checkDrift(
  ids: string[],
  roots: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<DriftReport> {
  const wanted = [...new Set(ids)]
  const { loaded, listed } = await installs(wanted, roots)
  const missing: string[] = []
  for (const id of wanted) {
    if (!listed.has(id) || !(await onDisk(roots, id))) missing.push(id)
  }

  let details: Map<string, Detail>
  try {
    details = await published(wanted, fetchImpl)
  } catch (error) {
    return {
      needed: missing,
      unavailable: [],
      warnings: [`could not ask steam which items changed (${reason(error)}); only missing items will download`],
    }
  }

  const needed = new Set(missing)
  const unavailable: string[] = []
  const warnings: string[] = []
  for (const id of wanted) {
    const detail = details.get(id)
    if (detail === undefined) continue
    if (detail.result !== 1) {
      // removed, private or hidden: anonymous steamcmd cannot fetch it, so queueing it only fails later
      warnings.push(`workshop item ${id} is not available (result ${detail.result}); skipping it`)
      needed.delete(id)
      unavailable.push(id)
      continue
    }
    const local = loaded.get(id)
    if (local !== undefined && detail.timeUpdated > local) needed.add(id)
  }
  return { needed: [...needed], unavailable, warnings }
}

/**
 * `loaded` is the `timeupdated` of the copy a launch actually mounts: the first root, in
 * `downloadRoots` order, that both lists the id and has its directory on disk. The index picks
 * by root order and never by mtime, so comparing steam against any other copy leaves a stale
 * mod loaded forever. `listed` is every id any .acf claims, which is what decides whether an
 * id is missing. A root with no readable .acf contributes nothing.
 */
async function installs(ids: string[], roots: string[]): Promise<{ loaded: Map<string, number>; listed: Set<string> }> {
  const loaded = new Map<string, number>()
  const listed = new Set<string>()
  for (const root of roots) {
    const items = installedItems(await readText(acfPath(root)))
    for (const id of ids) {
      const item = items.get(id)
      if (item === undefined) continue
      listed.add(id)
      if (!loaded.has(id) && (await exists(join(root, id)))) loaded.set(id, item.timeupdated)
    }
  }
  return { loaded, listed }
}

async function onDisk(roots: string[], id: string): Promise<boolean> {
  for (const root of roots) {
    if (await exists(join(root, id))) return true
  }
  return false
}

/** One deadline for every chunk, so a hundred ids still answer inside the 5s budget or not at all. */
async function published(ids: string[], fetchImpl: typeof fetch): Promise<Map<string, Detail>> {
  const out = new Map<string, Detail>()
  if (ids.length === 0) return out
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(`no answer in ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const body = new URLSearchParams({ itemcount: String(chunk.length) })
      chunk.forEach((id, n) => body.set(`publishedfileids[${n}]`, id))
      const response = await fetchImpl(ENDPOINT, { method: 'POST', body, signal: abort.signal })
      if (!response.ok) throw new Error(`steam answered ${response.status}`)
      for (const [id, detail] of readDetails(await response.json())) out.set(id, detail)
    }
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
      throw new Error('steam returned a body this does not understand')
    }
    out.set(id, { result, timeUpdated: Number(entry['time_updated']) || 0 })
  }
  return out
}

/** A content root ends in `workshop/content/<appid>`, and the acf sits two levels above it. */
function acfPath(root: string): string {
  return join(dirname(dirname(root)), `appworkshop_${basename(root)}.acf`)
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
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
