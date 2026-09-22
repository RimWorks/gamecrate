import { readFileSync } from 'node:fs'
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

export interface Toplevel {
  id: string
  wmClass: string
}

/** Every window that appeared since the snapshot and belongs to this game, in wmctrl's order. */
export function newMatches(now: Toplevel[], seen: Set<string>, executable: string): Toplevel[] {
  const wanted = basename(executable).toLowerCase()
  return now.filter((w) => !seen.has(w.id) && w.wmClass.toLowerCase().includes(wanted))
}

export function parseWindowPid(stdout: string): number | undefined {
  const match = /_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/.exec(stdout)
  const pid = Number(match?.[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Another supervisor's window. Our own claim, or a dead or non-gamecrate pid, is not.
 * Deliberately not `isRunning`: the cmdline read already throws for a dead pid, and it stays
 * readable for a supervisor owned by another user, where a signal check is denied and would
 * have us steal that run's window.
 *
 * Matched on each argument's own basename rather than anywhere in the raw cmdline, so a
 * gamecrate log path or data directory in an unrelated process's arguments is not a peer. An
 * editor opened on a directory literally named gamecrate still is; nothing in /proc separates
 * those two.
 *
 * It also stops matching `bun run src/index.ts`, where the old substring match caught the repo
 * directory in the script path. Installed users are unaffected, the bin and gamecrate.js both
 * match; it costs peer detection between two concurrent from-source dev runs.
 *
 * Residual: before adoption `_NET_WM_PID` is the container's pid namespace, so this looks a
 * container-local number up in the host's `/proc`. A false hit makes the run skip its own
 * window for the whole wait. Container game pids are small and low host pids are kernel
 * threads with an empty cmdline, so in practice the read returns nothing and no match happens.
 */
export function isPeerClaim(pid: number, self: number): boolean {
  if (pid === self) return false
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    return argv.some((arg) => basename(arg).startsWith('gamecrate'))
  } catch {
    return false
  }
}

/**
 * claimPid stamps our own pid, so a live peer's pid on a window means it got there first.
 * Load-bearing, not an optimisation. This check is what squeezes the window in which two
 * supervisors can both reach claimPid down to about one xprop exec; the read-back in claimPid
 * only detects a loser inside that window. Remove this and two concurrent runs adopt the same
 * window again, with every test still green: the skip has no seam, so covering it means mocking
 * capture, which nothing in docker.test.ts does.
 */
async function claimedByPeer(id: string): Promise<boolean> {
  const { stdout } = await capture(['xprop', '-id', id, '_NET_WM_PID'])
  const pid = parseWindowPid(stdout)
  return pid !== undefined && isPeerClaim(pid, process.pid)
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
 * rather than any window that opened. Once adopted, _NET_WM_PID holds our pid, so a second run
 * starting at the same time can see the window is already spoken for and keep waiting for its own.
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

/** True once the watch is over, whether it adopted a window or was stopped mid-sweep. */
async function adoptFirstMatch(seen: Set<string>, opts: AdoptOptions, stopped: () => boolean): Promise<boolean> {
  for (const match of newMatches((await toplevels()) ?? [], seen, opts.executable)) {
    if (stopped()) return true
    // Another run's window. Leave it alone and keep waiting for ours to open.
    if (await claimedByPeer(match.id)) continue
    if (!(await adopt(match.id, opts))) continue

    await capture(['wmctrl', '-i', '-r', match.id, '-N', opts.title])
    if (opts.stripDelete) await watchForClose(match.id, stopped, opts.onClosed)
    return true
  }
  return false
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

/**
 * True to keep this window: the claim is ours, or there is no xprop to ask with. The caller
 * retitles only after a true, so returning false with no xprop would skip every candidate for
 * the whole wait and give up having done nothing, costing the retitle a missing xprop does not
 * otherwise cost. False only when another run won the claim, so the caller keeps looking.
 */
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

/**
 * The window carries its container pid, and the spoofed hostname makes the WM read that as
 * local, so a kill by pid would signal whichever host process holds that number out here.
 * Point it at the launcher: its SIGTERM path is a `docker stop`, which is graceful and then
 * final, and RimWorld hangs mid-shutdown often enough that the final part matters.
 */
async function claimPid(id: string): Promise<boolean> {
  const pid = String(process.pid)
  await capture(['xprop', '-id', id, '-f', '_NET_WM_PID', '32c', '-set', '_NET_WM_PID', pid])
  // claimedByPeer is what bounds this, not the read-back: a second supervisor only reaches here
  // if its read beat our write, so both writes land within one xprop exec of each other. The
  // read-back is only what catches that overlap. Delete the pre-check and the race is unbounded.
  const readBack = await capture(['xprop', '-id', id, '_NET_WM_PID'])
  return parseWindowPid(readBack.stdout) === process.pid
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
    .filter((atom) => /^[A-Za-z_]\w*$/.test(atom))
}
