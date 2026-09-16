import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { warn } from '../cli/output'
import { capture } from './run'

/** Long enough for a cold RimWorld start on a spinning disk, short enough to give up on. */
const WAIT_MS = 180_000
const POLL_MS = 500

export interface WindowWatch {
  stop: () => void
}

interface Toplevel {
  id: string
  wmClass: string
}

/** `wmctrl -lx` is `id desktop class host title`, so the class is the third field. */
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
  /** Set for an engine that claims WM_DELETE_WINDOW and ignores it, RimWorld being the one. */
  stripDelete: boolean
  /** Called once the window a stripDelete run adopted is gone. */
  onClosed: () => void
}

/**
 * Retitles the window a headed X11 run opens and fixes what the WM knows about it. Snapshots
 * the screen first and takes the first window that was not there: an X client inside a
 * container reports a container-local _NET_WM_PID and hostname, so neither of those identifies
 * the run from out here. The WM_CLASS comes from the executable, which narrows it to this game
 * rather than any window that opened.
 */
export async function adoptNewWindow(opts: AdoptOptions): Promise<WindowWatch> {
  const before = await toplevels()
  if (before === null) {
    warn('wmctrl is not installed, so the window keeps the game\'s own title')
    return { stop: () => {} }
  }

  const seen = new Set(before.map((w) => w.id))
  const wanted = basename(opts.executable).toLowerCase()
  let stopped = false

  void (async () => {
    const deadline = Date.now() + WAIT_MS
    while (!stopped && Date.now() < deadline) {
      await sleep(POLL_MS)
      if (stopped) return

      const now = (await toplevels()) ?? []
      const match = now.find((w) => !seen.has(w.id) && w.wmClass.toLowerCase().includes(wanted))
      if (match === undefined) continue

      await capture(['wmctrl', '-i', '-r', match.id, '-N', opts.title])
      await adopt(match.id, opts)
      if (opts.stripDelete) await watchForClose(match.id, () => stopped, opts.onClosed)
      return
    }
  })()

  return { stop: () => void (stopped = true) }
}

/**
 * KWin answers a stripped close button by destroying the window, and sometimes by signalling
 * the pid as well, so the only dependable news is that the window went away. RimWorld outlives
 * it either way, alive with nothing on screen, which is what leaves the run to be torn down
 * from out here.
 */
async function watchForClose(id: string, stopped: () => boolean, onClosed: () => void) {
  let misses = 0
  while (!stopped()) {
    await sleep(POLL_MS)
    if (stopped()) return

    const now = await toplevels()
    if (now === null) return

    // Two polls, so a window being reconfigured rather than closed is not mistaken for one.
    misses = now.some((w) => w.id === id) ? 0 : misses + 1
    if (misses >= 2) {
      onClosed()
      return
    }
  }
}

async function adopt(id: string, opts: AdoptOptions): Promise<void> {
  const protocols = await capture(['xprop', '-id', id, 'WM_PROTOCOLS'])
  if (protocols.code === 127) {
    warn('xprop is not installed, so nothing out here can fix the window\'s close button')
    return
  }

  await claimPid(id)
  if (opts.stripDelete) await dropDeleteProtocol(id, parseAtoms(protocols.stdout))
}

/**
 * The window carries its container pid, and the spoofed hostname makes the WM read that as
 * local, so a kill by pid would signal whichever host process holds that number out here.
 * Point it at the launcher: its SIGTERM path is a `docker stop`, which is graceful and then
 * final, and RimWorld hangs mid-shutdown often enough that the final part matters.
 */
async function claimPid(id: string): Promise<void> {
  const pid = String(process.pid)
  await capture(['xprop', '-id', id, '-f', '_NET_WM_PID', '32c', '-set', '_NET_WM_PID', pid])
}

/**
 * Withdrawing the claim is what makes the titlebar X do anything: the WM stops asking and kills
 * the client instead. Everything else in the list stays, _NET_WM_PING especially.
 */
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
    .filter((atom) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(atom))
}
