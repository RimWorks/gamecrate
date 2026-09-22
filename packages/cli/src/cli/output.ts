import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { STDOUT_LOG } from '../docker/run'
import { containerName } from '../docker/spec'
import { staleWarning } from '../mods/staleness'
import type { LaunchPlan, Problem, ResolvedMod } from '../types'
import { GamecrateError, Exit } from '../types'

/** Tool status. Never stdout: stdout belongs to the game. */
export function status(message: string): void {
  process.stderr.write(line(message))
}

export function warn(message: string): void {
  process.stderr.write(line(`warning: ${message}`))
}

export interface OutputRedirect {
  close(): void
}

export function redirectOutput(path: string, keep = false): OutputRedirect {
  const fd = openSync(path, keep ? 'a' : 'w')
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  let open = true
  const write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    append(fd, chunk)
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    done?.()
    return true
  }) as typeof process.stdout.write
  process.stdout.write = write
  process.stderr.write = write

  return {
    close() {
      if (!open) return
      open = false
      process.stdout.write = stdout
      process.stderr.write = stderr
      closeSync(fd)
    },
  }
}

export async function forwardOutput(stream: Readable, target: NodeJS.WriteStream): Promise<void> {
  for await (const chunk of stream) target.write(chunk as Buffer)
}

function line(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`
}

/**
 * Every collected failure at once, grouped by location. Resolution stops before any
 * side effect, so reporting the first problem only would hide the rest.
 */
export function reportProblems(problems: Problem[]): never {
  if (problems.length === 0) {
    throw new GamecrateError('resolution failed with no reported detail', Exit.Resolution)
  }

  const groups = new Map<string, Problem[]>()
  for (const problem of problems) {
    const group = groups.get(problem.where)
    if (group) group.push(problem)
    else groups.set(problem.where, [problem])
  }

  const out: string[] = []
  for (const [where, group] of groups) {
    out.push(`  ${where}`)
    for (const problem of group) {
      out.push(`    ${problem.message}`)
      if (problem.suggestion) out.push(`      did you mean ${problem.suggestion}?`)
    }
  }
  throw new GamecrateError(
    `${problems.length} problem${problems.length === 1 ? '' : 's'}`,
    Exit.Resolution,
    out.join('\n'),
  )
}

export interface PlanModPayload {
  packageId: string
  kind: ResolvedMod['kind']
  hostDir: string
  containerDir: string
  origin: 'explicit' | 'auto'
  stale: boolean
  staleReport?: NonNullable<ResolvedMod['staleReport']>
  workshopId?: number
}

export interface PlanPayload {
  game: string
  profile: string
  instance?: string
  mode: string
  marker?: string
  timeoutSeconds: number
  renderWaitSeconds: number
  profileDir: string
  instanceDir: string
  containerName: string
  dataDirHost: string
  stageDirHost: string
  logsDirHost: string
  mods: PlanModPayload[]
  warnings: string[]
}

/**
 * Regenerated from the mods rather than stored, because a successful `--build` clears a stale
 * report and the warning has to disappear with it.
 */
export function planWarnings(plan: LaunchPlan): string[] {
  if (!plan.warnOnStale) return plan.warnings
  const stale = plan.mods
    .filter((mod) => mod.staleReport !== undefined)
    .map((mod) => staleWarning(mod.packageId, mod.staleReport!))
  return [...plan.warnings, ...stale]
}

/** The `--print-plan --json` payload. Bind mounts leave no host-readable link to assert on. */
export function planPayload(plan: LaunchPlan): PlanPayload {
  return {
    game: plan.game,
    profile: plan.profile,
    ...(plan.instance === undefined ? {} : { instance: plan.instance }),
    mode: plan.mode,
    ...(plan.marker === undefined ? {} : { marker: plan.marker }),
    timeoutSeconds: plan.timeoutSeconds,
    renderWaitSeconds: plan.renderWaitSeconds,
    profileDir: resolve(plan.profileDir),
    instanceDir: resolve(plan.instanceDir),
    containerName: containerName(plan),
    dataDirHost: resolve(plan.dataDirHost),
    stageDirHost: resolve(plan.stageDirHost),
    logsDirHost: resolve(plan.logsDirHost),
    mods: plan.mods.map((mod) => ({
      packageId: mod.packageId,
      kind: mod.kind,
      hostDir: resolve(mod.hostDir),
      containerDir: mod.containerDir,
      origin: mod.explicit ? 'explicit' : 'auto',
      stale: mod.stale === true,
      ...(mod.staleReport === undefined ? {} : { staleReport: mod.staleReport }),
      ...(mod.workshopId === undefined ? {} : { workshopId: mod.workshopId }),
    })),
    warnings: planWarnings(plan),
  }
}

export function printPlan(plan: LaunchPlan, asJson: boolean): void {
  const payload = planPayload(plan)
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  const title = payload.instance === undefined
    ? `${payload.game} ${payload.profile} (${payload.mode})`
    : `${payload.game} ${payload.profile} / ${payload.instance} (${payload.mode})`
  const out = [
    title,
    `  profile   ${payload.profileDir}`,
    `  instance  ${payload.instanceDir}`,
    `  container ${payload.containerName}`,
    `  data      ${payload.dataDirHost}`,
    `  stage     ${payload.stageDirHost}`,
    `  logs      ${payload.logsDirHost}`,
  ]
  if (payload.marker !== undefined) out.push(`  marker    ${payload.marker}`)
  out.push(
    `  timeout   ${payload.timeoutSeconds}s, render wait ${payload.renderWaitSeconds}s`,
    `  mods      ${payload.mods.length}`,
  )

  const width = Math.max(0, ...payload.mods.map((m) => m.packageId.length))
  for (const mod of payload.mods) {
    const notes: string[] = [mod.kind, mod.origin]
    if (mod.stale) notes.push('stale')
    out.push(`    ${mod.packageId.padEnd(width)}  ${notes.join(' ')}  ${mod.hostDir} -> ${mod.containerDir}`)
  }
  for (const warning of payload.warnings) out.push(`  warning: ${warning}`)
  process.stdout.write(`${out.join('\n')}\n`)
}

/** Sortable lexicographically and safe on every filesystem: 20260730T142335123Z. */
export function runTimestamp(now: Date = new Date()): string {
  return now.toISOString().replaceAll(/[-:.]/g, '')
}

/** Makes <logsDir>/runs/<ts>, repoints `current` at it, rotates the old ones, returns the dir. */
export function openRunLog(logsDir: string, now?: Date): string {
  const runsDir = join(logsDir, 'runs')
  mkdirSync(runsDir, { recursive: true })

  const dir = uniqueRunDir(runsDir, runTimestamp(now))
  mkdirSync(dir)
  linkCurrent(logsDir, dir)
  rotateRuns(logsDir, 10)
  return dir
}

const encoder = new TextEncoder()

function append(fd: number, chunk: string | Uint8Array): void {
  writeSync(fd, typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
}

function uniqueRunDir(runsDir: string, stamp: string): string {
  let candidate = join(runsDir, stamp)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(runsDir, `${stamp}-${n}`)
    n++
  }
  return candidate
}

/** Below the first a wait is not worth mentioning; the log normally appears in milliseconds. */
export interface NoticeSchedule {
  firstMs: number
  everyMs: number
}

export const WAIT_NOTICE: NoticeSchedule = { firstMs: 2_000, everyMs: 30_000 }

/**
 * The elapsed label when a wait is due a line, else undefined. Driven by elapsed time and not
 * by poll count: a quarter-second poll would scroll a line per pass and read as its own kind
 * of broken, while a silent ten-minute image build looks exactly like a hang. Both branches
 * floor, so the label never claims more time than has passed.
 */
export function waitNotice(
  waitedMs: number,
  lastNoticeMs: number,
  schedule: NoticeSchedule = WAIT_NOTICE,
): string | undefined {
  if (waitedMs < schedule.firstMs) return undefined
  if (lastNoticeMs > 0 && waitedMs - lastNoticeMs < schedule.everyMs) return undefined
  return waitedMs < 60_000 ? `${Math.floor(waitedMs / 1000)}s` : `${Math.floor(waitedMs / 60_000)}m`
}

/** Inverse of runTimestamp. Anchored at the start, so the -2 collision suffix is tolerated. */
export function runStartedAt(name: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name)
  if (m === null) return undefined
  const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`)
  return Number.isNaN(at) ? undefined : at
}

/** linkCurrent keeps `current` pointed at the newest run, so the run dir is never guessed. */
export function currentLog(instanceDir: string): string {
  return join(instanceDir, 'logs', 'current', STDOUT_LOG)
}

/**
 * tail -f never ends on its own, so a live run gets --pid and tail leaves when the holder
 * does. With no live holder nothing will write again, so -f is dropped or it hangs forever.
 */
export function tailArgv(file: string, fromStart: boolean, livePid?: number): string[] {
  const argv = ['tail']
  if (fromStart) argv.push('-n', '+1')
  if (livePid !== undefined) argv.push('-f', '--pid', String(livePid))
  argv.push(file)
  return argv
}

function linkCurrent(logsDir: string, target: string): void {
  const link = join(logsDir, 'current')
  try {
    lstatSync(link)
    unlinkSync(link)
  } catch {
    // No previous link; nothing to clear.
  }
  symlinkSync(join('runs', basename(target)), link, 'dir')
}

/** Landmine 7: a 180MB Player-prev.log was 68% of a profile tree. Retention is the cap. */
export function rotateRuns(logsDir: string, keep: number): string[] {
  const runsDir = join(logsDir, 'runs')
  if (keep < 1 || !existsSync(runsDir)) return []

  const dirs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()

  const removed = dirs.slice(keep)
  for (const name of removed) rmSync(join(runsDir, name), { recursive: true, force: true })
  return removed
}
