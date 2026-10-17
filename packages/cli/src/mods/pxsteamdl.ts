import { accessSync, constants, existsSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { expandHome } from '../config/load'
import { captureLive } from '../docker/run'
import { currentLanes } from '../concurrency'
import { Exit, GamecrateError } from '../types'
import type { GameConfig, RootConfig } from '../types'
import { downloadRoot, steamHome } from './steamcmd'
import type { DownloadHooks, DownloadOutcome, DownloadReport } from './steamcmd'
import { lockDir } from './source'

const OK = /^ok\s+(\d+)\s+(.*)$/
const FAILED = /^failed\s+(\d+)\s+(.*)$/
const POLL_MS = 250

/**
 * The parallel workshop downloader, when one is installed. A configured path that is not an
 * executable file is an error; nothing installed hands the download back to steamcmd.
 */
export function resolvePxsteamdl(config: RootConfig): string | undefined {
  const configured = config.pxsteamdl?.path
  if (configured === undefined) return onPath('pxsteamdl')
  const path = expandHome(configured)
  if (executable(path)) return path
  throw new GamecrateError(
    `pxsteamdl.path is not an executable file: ${path}`,
    Exit.Environment,
    'point pxsteamdl.path at the pxsteamdl binary, or remove it to use PATH or steamcmd',
  )
}

/**
 * Downloads every id at once, into the layout steamcmd writes. pxsteamdl checks each file
 * against the live manifest itself, so a caller passes every id it wants rather than a diff.
 */
export async function downloadWithPxsteamdl(
  binary: string,
  game: GameConfig,
  dataRoot: string,
  ids: string[],
  hooks?: DownloadHooks,
): Promise<DownloadReport> {
  const items = new Map<string, DownloadOutcome>()
  const warnings: string[] = []
  if (ids.length === 0) return { items, warnings }

  const root = downloadRoot(dataRoot, game)
  mkdirSync(root, { recursive: true })
  const release = await lockDir(steamHome(dataRoot))
  const stop = hooks === undefined ? undefined : markRunningAsItemDirsAppear(root, ids, hooks)
  let text: string
  try {
    ;({ text } = await captureLive(
      [binary, '-o', root, '-j', String(currentLanes()), '--', ...ids],
      process.env,
    ))
  } catch (error) {
    throw new GamecrateError(
      `could not run pxsteamdl: ${binary}`,
      Exit.Environment,
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    stop?.()
    await release()
  }

  const reasons = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const done = OK.exec(line.trim())
    if (done !== null) {
      const dir = join(root, done[1]!)
      stampFetched(dir)
      items.set(done[1]!, { ok: true, dir, bytes: sizeOf(dir) })
      continue
    }
    const bad = FAILED.exec(line.trim())
    if (bad !== null) reasons.set(bad[1]!, bad[2]!.trim())
  }

  for (const id of ids) {
    if (items.get(id)?.ok === true) {
      hooks?.onCell(id, { state: 'done' })
      continue
    }
    const reason = reasons.get(id) ?? 'pxsteamdl reported nothing for it'
    items.set(id, { ok: false, reason })
    warnings.push(`could not download workshop item ${id}: ${reason}`)
    hooks?.onCell(id, { state: 'failed', detail: reason })
  }
  return { items, warnings }
}

function markRunningAsItemDirsAppear(
  root: string,
  ids: string[],
  hooks: DownloadHooks,
): () => void {
  const seen = new Set<string>()
  const tick = (): void => {
    for (const id of ids) {
      if (seen.has(id) || !existsSync(join(root, id))) continue
      seen.add(id)
      hooks.onCell(id, { state: 'running' })
    }
  }
  const timer = setInterval(tick, POLL_MS)
  timer.unref()
  tick()
  return () => clearInterval(timer)
}

/** pxsteamdl rewrites files inside the tree, which leaves the item directory's own mtime behind. */
function stampFetched(dir: string): void {
  const now = new Date()
  try {
    utimesSync(dir, now, now)
  } catch {
    return
  }
}

function sizeOf(dir: string): number {
  try {
    return statSync(dir).size
  } catch {
    return 0
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    if (executable(candidate)) return candidate
  }
  return undefined
}
