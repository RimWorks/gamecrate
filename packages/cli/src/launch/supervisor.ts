import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { supervisorArgv } from '../cli/args'
import { status } from '../cli/output'
import { capture, spawnArgv } from '../docker/run'
import { containerName } from '../docker/spec'
import { clearLock, writeLock } from './prepare'
import { GamecrateError, Exit } from '../types'
import type { ExitReason, LaunchPlan, LaunchResult } from '../types'

/**
 * Written once, after the spawn, with the child's pid: a take-then-rewrite would leave a dead
 * pid over a live child, and the next launcher would unlink it and race the same stage tree.
 */
export async function forkSupervisor(plan: LaunchPlan, argv: string[]): Promise<number> {
  await clearLock(plan)

  const name = containerName(plan)
  const self = supervisorArgv(argv)
  // the spawn is the trust boundary: one check covers undefined, '' and a path that is gone.
  const bin = self[0]
  if (bin === undefined || bin === '') {
    throw new GamecrateError('cannot re-exec gamecrate: argv[0] is empty', Exit.Environment)
  }

  const child = spawnArgv(self, 'ignore', true)
  child.unref()
  if (child.pid === undefined) {
    throw new GamecrateError(`could not fork a supervisor from ${bin}`, Exit.Environment)
  }

  await writeLock(plan, {
    pid: child.pid,
    container: name,
    game: plan.game,
    profile: plan.profile,
    ...(plan.instance === undefined ? {} : { instance: plan.instance }),
    detached: true,
    mode: plan.mode,
  })
  status(`${plan.game} ${plan.profile} -> ${name} (pid ${child.pid})`)
  return Exit.Ok
}

export async function recordExit(plan: LaunchPlan, result: LaunchResult): Promise<void> {
  await writeExit(plan.instanceDir, {
    at: new Date().toISOString(),
    code: result.code,
    reason: result.reason,
    container: containerName(plan),
    runDir: plan.runDirHost,
  })
  const what = plan.instance === undefined ? plan.profile : `${plan.profile}/${plan.instance}`
  await notify(`${plan.game} ${what}: ${result.reason} (${result.code})`, crashed(result))
}

/** Only `exited` means the container ended by itself; every other reason is us stopping it. */
function crashed(result: LaunchResult): boolean {
  return result.code !== 0 && (result.reason === 'exited' || result.reason === 'failed')
}

export async function writeExit(
  instanceDir: string,
  record: { at: string; code: number; reason: ExitReason; container?: string; runDir?: string },
): Promise<void> {
  await writeFile(join(instanceDir, '.gamecrate', 'last-exit.json'), `${JSON.stringify(record)}\n`)
}

/** notify-send is optional. capture() returns 127 for a missing binary, which is not a failure. */
export async function notify(summary: string, urgent: boolean): Promise<void> {
  await capture(['notify-send', '-a', 'gamecrate', '-u', urgent ? 'critical' : 'normal', summary])
}
