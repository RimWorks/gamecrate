import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expandHome } from '../config/load'
import { executable, onPath } from '../executable'
import { captureLive } from '../docker/run'
import { currentLanes } from '../concurrency'
import { Exit, GamecrateError } from '../types'
import type { GameConfig, RootConfig } from '../types'
import { downloadRoot, steamHome } from './steamcmd'
import type { DownloadHooks, DownloadOutcome, DownloadReport } from './steamcmd'
import { lockDir } from './source'
import { FETCH_STAMP } from './workshopapi'

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
 * Downloads every id at once, into the layout steamcmd writes. `published` carries steam's own
 * `time_updated` per id, recorded beside each item so later runs compare one clock, not two.
 */
export async function downloadWithPxsteamdl(
  binary: string,
  game: GameConfig,
  dataRoot: string,
  ids: string[],
  published: ReadonlyMap<string, number>,
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
  let code: number
  try {
    ;({ text, code } = await captureLive(
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

  const wanted = new Set(ids)
  const reasons = new Map<string, string>()
  for (const line of text.split(/[\r\n]+/)) {
    const done = OK.exec(line.trim())
    if (done !== null && wanted.has(done[1]!)) {
      const dir = join(root, done[1]!)
      stampFetched(dir, published.get(done[1]!))
      items.set(done[1]!, { ok: true, dir, bytes: sizeOf(dir) })
      continue
    }
    const bad = FAILED.exec(line.trim())
    if (bad !== null && wanted.has(bad[1]!)) reasons.set(bad[1]!, bad[2]!.trim())
  }

  const silent = code !== 0 && reasons.size === 0 && items.size === 0
  for (const id of ids) {
    if (items.get(id)?.ok === true) {
      hooks?.onCell(id, { state: 'done' })
      continue
    }
    const reason =
      reasons.get(id) ?? (silent ? `pxsteamdl exited ${code} without reporting anything` : 'pxsteamdl reported nothing for it')
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

function stampFetched(dir: string, publishedAt: number | undefined): void {
  try {
    writeFileSync(join(dir, FETCH_STAMP), `${publishedAt ?? 0}\n`)
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

