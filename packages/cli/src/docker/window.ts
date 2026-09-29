import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { warn } from '../cli/output'
import { setWindowIcon } from './icon'
import { capture } from './run'

const WAIT_MS = 180_000
const POLL_MS = 500

export interface WindowWatch {
  stop: () => void
}

export interface Toplevel {
  id: string
  wmClass: string
}

/** Every window that appeared since the snapshot and belongs to this game, in wmctrl's order. */
export function newMatches(now: Toplevel[], seen: Set<string>, executable: string): Toplevel[] {
  const wanted = basename(executable).toLowerCase()
  return now.filter((w) => !seen.has(w.id) && classMatches(w.wmClass, wanted))
}

function classMatches(wmClass: string, wanted: string): boolean {
  return wmClass
    .toLowerCase()
    .split('.')
    .some((part) => part.length >= 3 && (wanted.includes(part) || part.includes(wanted)))
}

export function parseWindowPid(stdout: string): number | undefined {
  const match = /_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/.exec(stdout)
  const pid = Number(match?.[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** Another supervisor's window. Our own claim, or a dead or non-gamecrate pid, is not. */
export function isPeerClaim(pid: number, self: number): boolean {
  if (pid === self) return false
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    return argv.some((arg) => basename(arg).startsWith('gamecrate'))
  } catch {
    return false
  }
}

async function claimedByPeer(id: string): Promise<boolean> {
  const { stdout } = await capture(['xprop', '-id', id, '_NET_WM_PID'])
  const pid = parseWindowPid(stdout)
  return pid !== undefined && isPeerClaim(pid, process.pid)
}

async function toplevels(): Promise<Toplevel[] | null> {
  const { code, stdout } = await capture(['wmctrl', '-lx'])
  if (code === 127) return null

  const found: Toplevel[] = []
  for (const line of stdout.split('\n')) {
    const [id, , wmClass] = line.trim().split(/\s+/)
    if (id !== undefined && wmClass !== undefined) found.push({ id, wmClass })
  }
  return found
}

export interface AdoptOptions {
  executable: string
  title: string
  /** An image the adopted window takes as its icon. Absolute, already resolved. */
  icon?: string
  /** Set for an engine that claims WM_DELETE_WINDOW and ignores it, RimWorld being the one. */
  stripDelete: boolean
  /** Called once the window a stripDelete run adopted is gone. */
  onClosed: () => void
}

/**
 * Retitles the window a headed X11 run opens and fixes what the WM knows about it. Once
 * adopted, _NET_WM_PID holds our pid, so a second run sees it is already spoken for.
 */
export async function adoptNewWindow(opts: AdoptOptions): Promise<WindowWatch> {
  const before = await toplevels()
  if (before === null) {
    warn('wmctrl is not installed, so the window keeps the game\'s own title')
    return { stop: () => {} }
  }

  const seen = new Set(before.map((w) => w.id))
  let stopped = false

  void pollForWindow(seen, opts, () => stopped)

  return {
    stop: () => {
      stopped = true
    },
  }
}

async function pollForWindow(seen: Set<string>, opts: AdoptOptions, stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (!stopped() && Date.now() < deadline) {
    await sleep(POLL_MS)
    if (stopped()) return
    if (await adoptFirstMatch(seen, opts, stopped)) return
  }
}

async function adoptFirstMatch(seen: Set<string>, opts: AdoptOptions, stopped: () => boolean): Promise<boolean> {
  for (const match of newMatches((await toplevels()) ?? [], seen, opts.executable)) {
    if (stopped()) return true
    if (await claimedByPeer(match.id)) continue
    if (!(await adopt(match.id, opts))) continue

    await capture(['wmctrl', '-i', '-r', match.id, '-N', opts.title])
    if (opts.icon !== undefined) await setWindowIcon(match.id, opts.icon)
    if (opts.stripDelete) await watchForClose(match.id, stopped, opts.onClosed)
    return true
  }
  return false
}

async function watchForClose(id: string, stopped: () => boolean, onClosed: () => void) {
  let misses = 0
  while (!stopped()) {
    await sleep(POLL_MS)
    if (stopped()) return

    const now = await toplevels()
    if (now === null) return

    misses = now.some((w) => w.id === id) ? 0 : misses + 1
    if (misses >= 2) {
      onClosed()
      return
    }
  }
}

async function adopt(id: string, opts: AdoptOptions): Promise<boolean> {
  const protocols = await capture(['xprop', '-id', id, 'WM_PROTOCOLS'])
  if (protocols.code === 127) {
    warn('xprop is not installed, so nothing out here can fix the window\'s close button')
    return true
  }

  if (!(await claimPid(id))) return false
  if (opts.stripDelete) await dropDeleteProtocol(id, parseAtoms(protocols.stdout))
  return true
}

async function claimPid(id: string): Promise<boolean> {
  const pid = String(process.pid)
  await capture(['xprop', '-id', id, '-f', '_NET_WM_PID', '32c', '-set', '_NET_WM_PID', pid])
  const readBack = await capture(['xprop', '-id', id, '_NET_WM_PID'])
  return parseWindowPid(readBack.stdout) === process.pid
}

async function dropDeleteProtocol(id: string, atoms: string[]): Promise<void> {
  if (!atoms.includes('WM_DELETE_WINDOW')) return

  const kept = atoms.filter((atom) => atom !== 'WM_DELETE_WINDOW')
  if (kept.length === 0) {
    await capture(['xprop', '-id', id, '-remove', 'WM_PROTOCOLS'])
    return
  }

  const format = `32${'a'.repeat(kept.length)}`
  await capture([
    'xprop', '-id', id, '-f', 'WM_PROTOCOLS', format, '-set', 'WM_PROTOCOLS', kept.join(', '),
  ])
}

/** `WM_PROTOCOLS(ATOM): protocols  WM_DELETE_WINDOW, WM_TAKE_FOCUS`, or `:  not found.` */
export function parseAtoms(stdout: string): string[] {
  const list = stdout.slice(stdout.indexOf(':') + 1).replace(/^\s*protocols\s*/, '')
  return list
    .split(',')
    .map((atom) => atom.trim())
    .filter((atom) => /^[A-Za-z_]\w*$/.test(atom))
}
