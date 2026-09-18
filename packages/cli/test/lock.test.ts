import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { capture } from '../src/docker/run'
import { isRunning, lockPath, readLock, replacePrevious, takeLock, writeLock } from '../src/launch/prepare'
import { GamecrateError, Exit } from '../src/types'
import type { LaunchPlan } from '../src/types'

/** Flipped on only by the fallback test; everything else reads the real procfs. */
const procfs = vi.hoisted(() => ({ broken: false }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (procfs.broken && String(path).startsWith('/proc/')) throw new Error('no procfs here')
      return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    },
  }
})

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

async function holdWith(plan: LaunchPlan, pid: number): Promise<void> {
  await writeFile(
    lockPath(plan),
    JSON.stringify({
      pid,
      container: `gamecrate-${GAME}-${PROFILE}`,
      game: GAME,
      profile: PROFILE,
      detached: false,
      // now, so a live holder reads as live: its process began before the lock was written
      startedAt: new Date().toISOString(),
    }),
  )
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
    expect((await readLock(lockPath(plan)))?.pid).toBe(process.pid)
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

describe('lock record', () => {
  test('a taken lock round trips as json', async () => {
    const plan = await planFor()
    await writeLock(plan, {
      pid: process.pid,
      container: 'gamecrate-x-y',
      game: GAME,
      profile: PROFILE,
      detached: true,
      mode: 'headed',
    })
    const record = await readLock(lockPath(plan))
    expect(record?.pid).toBe(process.pid)
    expect(record?.detached).toBe(true)
    expect(record?.container).toBe('gamecrate-x-y')
    expect(record?.mode).toBe('headed')
    expect(Date.parse(record!.startedAt)).not.toBeNaN()
  })

  test('writeLock refuses a second holder rather than truncating', async () => {
    const plan = await planFor()
    const record = { pid: process.pid, container: 'c', game: GAME, profile: PROFILE, detached: true }
    await writeLock(plan, record)
    await expect(writeLock(plan, record)).rejects.toBeInstanceOf(GamecrateError)
  })

  test('readLock returns undefined for a missing or corrupt file', async () => {
    const plan = await planFor()
    expect(await readLock(lockPath(plan))).toBeUndefined()
    await writeFile(lockPath(plan), 'not json at all')
    expect(await readLock(lockPath(plan))).toBeUndefined()
  })
})

// Detach leaves a long-lived pid per run, so reuse of a recycled number stops being theoretical.
describe('isRunning', () => {
  test('a live pid with no lock timestamp is running', () => {
    expect(isRunning(process.pid)).toBe(true)
  })

  test('a dead pid is not running', () => {
    expect(isRunning(DEAD_PID)).toBe(false)
    expect(isRunning(DEAD_PID, new Date().toISOString())).toBe(false)
  })

  test('a live pid that began after the lock was written is a recycled number', () => {
    expect(isRunning(process.pid, '1970-01-01T00:00:00Z')).toBe(false)
  })

  test('a live pid that began before the lock was written is the holder', () => {
    expect(isRunning(process.pid, new Date().toISOString())).toBe(true)
    expect(isRunning(process.pid, new Date(Date.now() + 60_000).toISOString())).toBe(true)
  })

  test('an unparsable timestamp falls back to the signal check', () => {
    expect(isRunning(process.pid, 'whenever')).toBe(true)
  })

  test('unreadable procfs falls back to the signal check instead of throwing', () => {
    procfs.broken = true
    try {
      expect(isRunning(process.pid, '1970-01-01T00:00:00Z')).toBe(true)
      expect(isRunning(DEAD_PID, '1970-01-01T00:00:00Z')).toBe(false)
    } finally {
      procfs.broken = false
    }
  })
})
