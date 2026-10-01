import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, openSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchPlan } from '../types'
import { warn } from '../cli/output'

export const CONTAINER_OPEN_FIFO = '/run/gamecrate-open.fifo'

export const OPEN_FIFO_FILE = 'xdg-open.fifo'
export const OPEN_SHIM_FILE = 'xdg-open'

const MAX_PENDING = 8192

export function wantsLinkOpener(plan: LaunchPlan): boolean {
  return plan.mode === 'headed'
}

/** Only a web page. A file:// path would reach a format-string bug in xdg-open itself. */
export function allowedUrl(line: string): string | null {
  const text = line.trim()
  return /^https?:\/\/\S+$/i.test(text) ? text : null
}

export interface LinkOpener {
  stop(): void
}

/** Reads URLs the container's `xdg-open` shim writes to a fifo and opens them on the host. */
export function startLinkOpener(
  runDir: string,
  open: (url: string) => void = openOnHost,
): LinkOpener | undefined {
  const fifo = join(runDir, OPEN_FIFO_FILE)
  if (!makeFifo(fifo)) return undefined
  writeFileSync(join(runDir, OPEN_SHIM_FILE), shim(), { mode: 0o755 })

  const fd = openSync(fifo, 'r+')
  const input = createReadStream('', { fd, autoClose: true, encoding: 'utf8' })

  let live = true
  input.on('close', () => {
    live = false
  })
  input.on('error', () => {
    live = false
  })

  let pending = ''
  input.on('data', (chunk) => {
    pending += chunk as string
    for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
      const url = allowedUrl(pending.slice(0, at))
      pending = pending.slice(at + 1)
      if (url !== null) open(url)
    }
    if (pending.length > MAX_PENDING) pending = ''
  })

  return {
    stop() {
      if (!live) return
      live = false
      wakeParkedRead(fd)
      input.destroy()
    },
  }
}

function makeFifo(path: string): boolean {
  try {
    execFileSync('mkfifo', ['-m', '600', path])
    return true
  } catch {
    warn('mkfifo is not available, so links the game opens will not reach the desktop')
    return false
  }
}

/** A read blocked on an empty fifo has to return before the stream can close its fd. */
function wakeParkedRead(fd: number): void {
  try {
    writeSync(fd, '\n')
  } catch {}
}

function openOnHost(url: string): void {
  const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

function shim(): string {
  return `#!/bin/sh\n[ -n "$1" ] && printf '%s\\n' "$1" >> ${CONTAINER_OPEN_FIFO}\nexit 0\n`
}
