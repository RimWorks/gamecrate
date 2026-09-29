import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { BRIGHT, CYAN, DIM, GREEN, OFF, RED, YELLOW } from './logpane'

/** One NDJSON line a structured log sink wrote. Every key past `msg` may be absent or null. */
export interface LogRecord {
  ts?: string
  level: string
  channel: string
  msg: string
  tmpl?: string
  src?: string | null
  stack?: string | null
  mod?: string | null
  tick?: number | null
  repeats?: number
  ctx?: Record<string, unknown> | null
  exc?: { type?: string | null; message?: string | null; stack?: string | null } | null
  patched?: string[] | null
}

/** A line that is not one record is not an error: stdout and a half-written tail both land here. */
export function parseRecord(line: string): LogRecord | undefined {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const row = parsed as Record<string, unknown>
  if (typeof row['level'] !== 'string' || typeof row['channel'] !== 'string' || typeof row['msg'] !== 'string') {
    return undefined
  }
  return row as unknown as LogRecord
}

const LEVEL_COLOUR: Readonly<Record<string, string>> = {
  TRACE: DIM,
  DEBUG: DIM,
  INFO: GREEN,
  WARN: YELLOW,
  ERROR: RED,
  FATAL: RED,
}

const CLOCK = /T(\d{2}:\d{2}:\d{2}\.\d{3})Z?$/

function clock(ts: string | undefined): string {
  return ts === undefined ? '' : (CLOCK.exec(ts)?.[1] ?? '')
}

/** One record, one row. An exception collapses to its type and message, stack dropped. */
export function renderRecord(record: LogRecord): string {
  const colour = LEVEL_COLOUR[record.level] ?? BRIGHT
  const parts = [
    `${DIM}${clock(record.ts).padEnd(12)}${OFF}`,
    `${colour}${record.level.padEnd(5)}${OFF}`,
    `${CYAN}${record.channel}${OFF}`,
    record.msg,
  ]
  const repeats = record.repeats ?? 1
  if (repeats > 1) parts.push(`${DIM}x${repeats}${OFF}`)
  const exc = record.exc
  if (exc !== undefined && exc !== null) {
    parts.push(`${RED}${exc.type ?? 'exception'}: ${exc.message ?? ''}${OFF}`)
  }
  return parts.join(' ').replace(/[\r\n]+/g, ' ')
}

const POLL_MS = 200
const SUFFIX = '.ndjson'
const STALE_SLACK_MS = 5_000

export interface RecordTailOptions {
  dir: string
  onRecord: (record: LogRecord) => void
  intervalMs?: number
  /** Files older than this are a previous run's. Defaults to now. */
  since?: number
}

/**
 * Follows the newest record file in `dir`, from nothing to whatever appears. Returns the stop.
 */
export function tailRecords(opts: RecordTailOptions): () => void {
  const since = opts.since ?? Date.now()
  let stopped = false
  let current: string | undefined
  let offset = 0
  let partial = ''
  let decoder = new StringDecoder('utf8')
  let timer: ReturnType<typeof setTimeout> | undefined

  const newest = async (): Promise<string | undefined> => {
    let names: string[]
    try {
      names = await readdir(opts.dir)
    } catch {
      return undefined
    }
    let best: { name: string; at: number } | undefined
    for (const name of names) {
      if (!name.endsWith(SUFFIX)) continue
      let at: number
      try {
        at = (await stat(join(opts.dir, name))).mtimeMs
      } catch {
        continue
      }
      if (at + STALE_SLACK_MS < since) continue
      if (best === undefined || at > best.at || (at === best.at && name > best.name)) best = { name, at }
    }
    return best?.name
  }

  const rewind = (): void => {
    offset = 0
    partial = ''
    decoder = new StringDecoder('utf8')
  }

  const drain = async (): Promise<void> => {
    if (stopped) return
    const name = await newest()
    if (stopped || name === undefined) return
    if (name !== current) {
      current = name
      rewind()
    }
    const path = join(opts.dir, name)
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return
    }
    if (size < offset) rewind()
    if (size === offset) return

    const buffer = Buffer.alloc(size - offset)
    const handle = await open(path, 'r')
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      offset += bytesRead
      partial += decoder.write(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }

    const lines = partial.split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (stopped) return
      const record = parseRecord(line)
      if (record !== undefined) opts.onRecord(record)
    }
  }

  const tick = (): void => {
    void drain()
      .catch(() => {})
      .then(() => {
        if (stopped) return
        timer = setTimeout(tick, opts.intervalMs ?? POLL_MS)
      })
  }
  tick()

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
