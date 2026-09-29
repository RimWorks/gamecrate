import { existsSync } from 'node:fs'
import { readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { supervisorArgv } from '../cli/args'
import { currentLog, runStartedAt, status, waitNotice, WAIT_NOTICE } from '../cli/output'
import type { NoticeSchedule } from '../cli/output'
import { spawnArgv } from '../docker/run'
import { containerName } from '../docker/spec'
import { clearLock, isRunning, readLock, writeLock } from './prepare'
import type { LockRecord } from './prepare'
import { GamecrateError, Exit } from '../types'
import type { ExitReason, LaunchPlan, LaunchResult } from '../types'

/**
 * Written once, after the spawn, with the child's pid. The child is killed when the write
 * loses the `wx` race.
 */
export async function forkSupervisor(plan: LaunchPlan, argv: string[]): Promise<number> {
  await clearLock(plan)

  const name = containerName(plan)
  const self = supervisorArgv(argv, plan.instanceDir)
  const bin = self[0]
  if (bin === undefined || bin === '') {
    throw new GamecrateError('cannot re-exec gamecrate: argv[0] is empty', Exit.Environment)
  }

  const child = spawnArgv(self, 'ignore', true)
  child.unref()
  if (child.pid === undefined) {
    throw new GamecrateError(`could not fork a supervisor from ${bin}`, Exit.Environment)
  }

  try {
    await writeLock(plan, {
      pid: child.pid,
      container: name,
      game: plan.game,
      profile: plan.profile,
      ...(plan.instance === undefined ? {} : { instance: plan.instance }),
      detached: true,
      mode: plan.mode,
    })
  } catch (error) {
    const failure = kill(child.pid)
    if (failure !== undefined) {
      throw new GamecrateError(
        `could not confirm supervisor ${child.pid} died after the lock write failed`,
        Exit.Environment,
        `${failure}\nkill -9 ${child.pid} before launching this profile again`,
      )
    }
    throw error
  }
  status(`${plan.game} ${plan.profile} -> ${name} (pid ${child.pid})`)
  return Exit.Ok
}

// undefined means gone. ESRCH is gone too; EPERM cannot happen, same uid and we spawned it
function kill(pid: number): string | undefined {
  try {
    process.kill(pid, 'SIGKILL')
    return undefined
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ESRCH' ? undefined : `could not kill it: ${code ?? String(error)}`
  }
}

export async function recordExit(plan: LaunchPlan, result: LaunchResult): Promise<void> {
  await writeExit(plan.instanceDir, {
    at: new Date().toISOString(),
    code: result.code,
    reason: result.reason,
    container: containerName(plan),
    runDir: plan.runDirHost,
  })
}

/**
 * The supervisor has no terminal and its stdio is discarded, so the exit record is the only way
 * a caller ever learns it died. The lock goes only once that record is on disk.
 */
export async function supervisorFailed(dir: string, code: number): Promise<number> {
  const record = { at: new Date().toISOString(), code, reason: 'failed' as const }
  const wrote = await writeExit(dir, record).then(() => true, () => false)
  if (wrote) await rm(join(dir, '.gamecrate', 'lock'), { force: true }).catch(() => {})
  return code
}

async function writeExit(
  instanceDir: string,
  record: ExitRecord,
): Promise<void> {
  await writeFile(join(instanceDir, '.gamecrate', 'last-exit.json'), `${JSON.stringify(record)}\n`)
}

export interface ExitRecord {
  at: string
  code: number
  reason: ExitReason
  container?: string
  runDir?: string
}

/** The other half of writeExit. Missing or corrupt reads as "no exit recorded", never a throw. */
export async function lastExit(instanceDir: string): Promise<ExitRecord | undefined> {
  const text = await readFile(join(instanceDir, '.gamecrate', 'last-exit.json'), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as ExitRecord
    return Number.isInteger(value?.code) ? value : undefined
  } catch {
    return undefined
  }
}

const WAIT_POLL_MS = 500

function endedAfter(record: ExitRecord, notBefore: string | undefined): boolean {
  if (notBefore === undefined) return true
  const began = Date.parse(notBefore)
  if (Number.isNaN(began)) return true
  const at = Date.parse(record.at)
  return !Number.isNaN(at) && at >= began
}

/**
 * Blocks while a live holder has the lock. `orphaned` is a holder that died without recording
 * anything; `absent` is a run that never happened.
 */
export async function awaitExit(
  instanceDir: string,
  poll = WAIT_POLL_MS,
): Promise<ExitRecord | 'orphaned' | 'absent'> {
  const file = join(instanceDir, '.gamecrate', 'lock')
  let watching: LockRecord | undefined

  for (;;) {
    const lock = (await readLock(file)) ?? watching
    const found = await lastExit(instanceDir)
    if (found !== undefined && endedAfter(found, lock?.startedAt)) return found
    if (lock === undefined) return 'absent'
    if (!isRunning(lock.pid, lock.startedAt)) return 'orphaned'
    watching = lock
    await sleep(poll)
  }
}

const RUN_LOG_POLL_MS = 250

/**
 * The lock is written right after the spawn, but the supervisor only opens its run log after
 * preflight, staging and the image. Waiting is bounded by the holder.
 */
export async function awaitRunLog(
  instanceDir: string,
  lock: LockRecord,
  poll = RUN_LOG_POLL_MS,
  notice: NoticeSchedule = WAIT_NOTICE,
): Promise<boolean> {
  const link = join(instanceDir, 'logs', 'current')
  const written = Date.parse(lock.startedAt)
  const since = Date.now()
  let lastNotice = 0

  for (;;) {
    const target = await readlink(link).catch(() => undefined)
    const began = target === undefined ? undefined : runStartedAt(basename(target))
    const current = began !== undefined && (Number.isNaN(written) || began >= written)
    if (current && existsSync(currentLog(instanceDir))) return true
    if (!isRunning(lock.pid, lock.startedAt)) return false

    const waited = Date.now() - since
    const label = waitNotice(waited, lastNotice, notice)
    if (label !== undefined) {
      status(`waiting for ${lock.game} ${lock.profile} to open its log (${label})`)
      lastNotice = waited
    }
    await sleep(poll)
  }
}
