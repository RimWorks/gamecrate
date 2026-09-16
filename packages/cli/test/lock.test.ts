import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { capture } from '../src/docker/run'
import { replacePrevious, takeLock } from '../src/launch/prepare'
import { GamecrateError, Exit } from '../src/types'
import type { LaunchPlan } from '../src/types'

let tmp = ''
let counter = 0

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-lock-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/**
 * replacePrevious shells out to a real `docker stop`, so the fixture name must be one no
 * container can ever have. `atlas kitted` here would stop an actual running game.
 */
const GAME = 'dockergame-test'
const PROFILE = 'lock-fixture'

/** Only the fields the lock touches; the rest of a plan is irrelevant here. */
async function planFor(instance?: string): Promise<LaunchPlan> {
  const dir = join(tmp, `instance-${counter++}`)
  await mkdir(join(dir, '.gamecrate'), { recursive: true })
  return {
    game: GAME,
    profile: PROFILE,
    instanceDir: dir,
    ...(instance === undefined ? {} : { instance }),
  } as unknown as LaunchPlan
}

function lockPath(plan: LaunchPlan): string {
  return join(plan.instanceDir, '.gamecrate', 'lock')
}

async function holdWith(plan: LaunchPlan, pid: number): Promise<void> {
  await writeFile(lockPath(plan), `${pid}\n2026-08-05T00:00:00Z\n`)
}

/** The kernel hands pids out in order and wraps, so a free one has to be found, not assumed. */
function deadPid(): number {
  for (let pid = 2 ** 22 - 1; pid > 2; pid--) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('every pid on this machine is in use')
}

const DEAD_PID = deadPid()

/** Opt-in: the standard suite must never start a container on someone else's machine. */
const DOCKER_OK = process.env['GAMECRATE_TEST_DOCKER'] === '1'

/** False when docker is missing or the command failed, which skips the container test. */
async function docker(argv: string[]): Promise<boolean> {
  return (await capture(['docker', ...argv])).code === 0
}

describe('takeLock', () => {
  test('a live holder is refused with its own exit code, not a generic one', async () => {
    const plan = await planFor()
    await holdWith(plan, process.pid)

    let error: GamecrateError | undefined
    try {
      await takeLock(plan)
    } catch (thrown) {
      error = thrown as GamecrateError
    }

    expect(error).toBeInstanceOf(GamecrateError)
    expect(error!.code).toBe(Exit.Refused)
    expect(error!.code).not.toBe(Exit.Ok)
    expect(error!.message).toBe(`${GAME} ${PROFILE} is already running (pid ${process.pid})`)
  })

  test('the refusal names the instance when there is one', async () => {
    const plan = await planFor('wt-a')
    await holdWith(plan, process.pid)
    await expect(takeLock(plan)).rejects.toThrow(`${GAME} ${PROFILE} (wt-a) is already running`)
  })

  test('a dead holder is cleaned up and the lock taken', async () => {
    const plan = await planFor()
    await holdWith(plan, DEAD_PID)

    const lock = await takeLock(plan)
    expect((await readFile(lockPath(plan), 'utf8')).split('\n')[0]).toBe(String(process.pid))
    await lock.release()
    expect(existsSync(lockPath(plan))).toBe(false)
  })

  test.skipIf(!DOCKER_OK)('a live container is refused even when no lock file survives', async () => {
    const plan = await planFor()
    const name = `gamecrate-${GAME}-${PROFILE}`
    // The launcher can be killed while the container keeps running, which is the case that
    // used to get past the lock and then stop the container it collided with.
    if (!(await docker(['run', '--rm', '--detach', '--name', name, 'alpine:latest', 'sleep', '60']))) {
      return
    }
    try {
      expect(existsSync(lockPath(plan))).toBe(false)
      await expect(takeLock(plan)).rejects.toThrow(`is already running (container ${name})`)
    } finally {
      await docker(['rm', '--force', name])
    }
  })

  test('release removes the lock so the next run is not refused', async () => {
    const plan = await planFor()
    await (await takeLock(plan)).release()
    await (await takeLock(plan)).release()
    expect(existsSync(lockPath(plan))).toBe(false)
  })
})

describe('replacePrevious', () => {
  test('clears a lock nobody is holding, so the launch is never refused', async () => {
    const plan = await planFor()
    await holdWith(plan, DEAD_PID)

    await replacePrevious(plan)
    expect(existsSync(lockPath(plan))).toBe(false)
    await (await takeLock(plan)).release()
  })

  test('a clean instance is left exactly as it was', async () => {
    const plan = await planFor()
    await replacePrevious(plan)
    expect(existsSync(lockPath(plan))).toBe(false)
  })

  // The container name carries the instance, so --replace on one worktree cannot reach another.
  test('it only ever touches its own instance directory', async () => {
    const mine = await planFor('wt-a')
    const theirs = await planFor('wt-b')
    await holdWith(mine, DEAD_PID)
    await holdWith(theirs, process.pid)

    await replacePrevious(mine)
    expect(existsSync(lockPath(mine))).toBe(false)
    expect(existsSync(lockPath(theirs))).toBe(true)
  })
})
