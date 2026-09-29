import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LaunchPlan } from '../src/types'

const procfs = { broken: false }

const stopped = { names: [] as string[] }

const fsHooks = { afterExists: undefined as ((path: string, answer: boolean) => void) | undefined }

const realFs = { ...(await import('node:fs')) }

await mock.module('node:fs', () => {
  const real = realFs
  const patched = {
    ...real,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (procfs.broken && String(path).startsWith('/proc/')) throw new Error('no procfs here')
      return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    },
    existsSync: (path: unknown, ...rest: unknown[]) => {
      const answer = (real.existsSync as (...args: unknown[]) => boolean)(path, ...rest)
      fsHooks.afterExists?.(String(path), answer)
      return answer
    },
  }
  return { ...patched, default: patched }
})

const { existsSync, writeFileSync } = await import('node:fs')

const realRun = { ...(await import('../src/docker/run')) }

await mock.module('../src/docker/run', () => ({
  ...realRun,
  stopContainer: (name: string) => {
    stopped.names.push(name)
    return Promise.resolve()
  },
}))

const { capture, spawnArgv, STOP_TIMEOUT_SECONDS } = await import('../src/docker/run')
const { openRunLog, runStartedAt, runTimestamp, tailArgv, waitNotice } = await import('../src/cli/output')
const { awaitExit, awaitRunLog, lastExit, recordExit, supervisorFailed } = await import('../src/launch/supervisor')
const {
  isRunning,
  lockPath,
  readLock,
  replacePrevious,
  stopRun,
  STOP_RELEASE_WAIT_MS,
  takeLock,
  writeLock,
} = await import('../src/launch/prepare')
import { GamecrateError, Exit } from '../src/types'
const { deadPids } = await import('./pids')

beforeEach(() => {
  stopped.names.length = 0
  fsHooks.afterExists = undefined
})

let tmp = ''
let counter = 0

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-lock-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const GAME = 'dockergame-test'
const PROFILE = 'lock-fixture'

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
      startedAt: new Date().toISOString(),
    }),
  )
}

const [DEAD_PID, OTHER_DEAD_PID] = deadPids(2) as [number, number]

const DOCKER_OK = process.env['GAMECRATE_TEST_DOCKER'] === '1'

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
    const marker = join(plan.instanceDir, 'precious.txt')
    await writeFile(marker, 'save file')

    await replacePrevious(plan)
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(join(plan.instanceDir, '.gamecrate'))).toBe(true)
    expect(existsSync(lockPath(plan))).toBe(false)
    expect(stopped.names).toEqual([])
  })

  test('an unreadable lock is left for the takeLock that follows', async () => {
    const plan = await planFor()
    await writeFile(lockPath(plan), 'not json at all')

    await replacePrevious(plan)
    expect(existsSync(lockPath(plan))).toBe(true)
    expect(stopped.names).toEqual([])
  })

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

  test.each([0, -1, 1.5])('readLock rejects a pid of %s', async (pid) => {
    const plan = await planFor()
    await writeFile(lockPath(plan), JSON.stringify({ pid, detached: false, startedAt: 'x' }))
    expect(await readLock(lockPath(plan))).toBeUndefined()
  })
})

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

describe('exit record', () => {
  test('recordExit writes the reason beside the code', async () => {
    const plan = await planFor()
    await recordExit(plan, { code: 130, reason: 'stopped' })
    const record = JSON.parse(await readFile(join(plan.instanceDir, '.gamecrate', 'last-exit.json'), 'utf8'))
    expect(record.code).toBe(130)
    expect(record.reason).toBe('stopped')
    expect(Date.parse(record.at)).not.toBeNaN()
  })

  test('supervisorFailed records the failure and clears the lock', async () => {
    const plan = await planFor()
    await writeFile(lockPath(plan), JSON.stringify({ pid: process.pid }))
    expect(await supervisorFailed(plan.instanceDir, 3)).toBe(3)
    expect(existsSync(join(plan.instanceDir, '.gamecrate', 'last-exit.json'))).toBe(true)
    expect(await lastExit(plan.instanceDir)).toMatchObject({ code: 3, reason: 'failed' })
    expect(Date.parse((await lastExit(plan.instanceDir))!.at)).not.toBeNaN()
    expect(existsSync(lockPath(plan))).toBe(false)
  })

  test('supervisorFailed keeps the lock when the record cannot be written', async () => {
    const plan = await planFor()
    await mkdir(join(plan.instanceDir, '.gamecrate', 'last-exit.json'))
    await writeFile(lockPath(plan), JSON.stringify({ pid: process.pid }))
    expect(await supervisorFailed(plan.instanceDir, 3)).toBe(3)
    expect(existsSync(lockPath(plan))).toBe(true)
  })
})

describe('stopRun', () => {
  test('a live supervisor gets a signal, not a docker stop', async () => {
    const plan = await planFor()
    const child = spawnArgv(['sh', '-c', 'exec -a "gamecrate --supervised" sleep 30'], 'ignore')
    const record = {
      pid: child.pid!,
      container: 'gamecrate-nope-nope',
      game: GAME,
      profile: PROFILE,
      detached: true,
      startedAt: new Date().toISOString(),
    }
    await writeFile(lockPath(plan), JSON.stringify(record))
    expect(await stopRun(record, lockPath(plan))).toBe('signalled')
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(`/proc/${child.pid}`)).toBe(false)
    expect(stopped.names).toEqual([])
  })

  test('the release budget outlasts the stop the supervisor itself runs', () => {
    expect(STOP_RELEASE_WAIT_MS).toBeGreaterThan(STOP_TIMEOUT_SECONDS * 1000)
  })

  test('a holder that outlasts the budget keeps its lock', async () => {
    const plan = await planFor()
    await holdWith(plan, process.pid)
    const child = spawnArgv(['sleep', '30'], 'ignore')
    const record = {
      pid: child.pid!,
      container: 'gamecrate-nope-nope',
      game: GAME,
      profile: PROFILE,
      detached: true,
      startedAt: new Date().toISOString(),
    }

    const real = Date.now.bind(Date)
    let calls = 0
    const clock = spyOn(Date, 'now').mockImplementation(() => {
      return calls++ === 0 ? real() : real() + STOP_RELEASE_WAIT_MS + 1000
    })
    try {
      const outcome = await stopRun(record, lockPath(plan))
      expect(existsSync(lockPath(plan))).toBe(true)
      expect(outcome).toBe('held')
      expect(calls).toBeGreaterThan(1)
    } finally {
      clock.mockRestore()
      child.kill()
    }
  })

  test('a dead pid falls through to docker and clears the lock', async () => {
    const plan = await planFor()
    const record = {
      pid: DEAD_PID,
      container: 'gamecrate-dockergame-test-nope',
      game: GAME,
      profile: PROFILE,
      detached: true,
      startedAt: new Date().toISOString(),
    }
    await writeFile(lockPath(plan), JSON.stringify(record))
    expect(await stopRun(record, lockPath(plan))).toBe('orphaned')
    expect(stopped.names).toEqual([record.container])
    expect(existsSync(lockPath(plan))).toBe(false)
  })

  test('a lock held by a different record is left alone', async () => {
    const plan = await planFor()
    const mine = {
      pid: DEAD_PID,
      container: 'gamecrate-dockergame-test-nope',
      game: GAME,
      profile: PROFILE,
      detached: true,
      startedAt: new Date().toISOString(),
    }
    await holdWith(plan, OTHER_DEAD_PID)

    expect(await stopRun(mine, lockPath(plan))).toBe('orphaned')
    expect((await readLock(lockPath(plan)))?.pid).toBe(OTHER_DEAD_PID)
  })

  test('an unreadable lock is left for clearLock, not deleted', async () => {
    const plan = await planFor()
    await writeFile(lockPath(plan), 'not json at all')

    expect(
      await stopRun(
        {
          pid: DEAD_PID,
          container: 'gamecrate-dockergame-test-nope',
          game: GAME,
          profile: PROFILE,
          detached: true,
          startedAt: new Date().toISOString(),
        },
        lockPath(plan),
      ),
    ).toBe('orphaned')
    expect(existsSync(lockPath(plan))).toBe(true)
  })

  test('a lock taken after the holder released is not deleted', async () => {
    const plan = await planFor()
    const record = {
      pid: DEAD_PID,
      container: 'gamecrate-dockergame-test-nope',
      game: GAME,
      profile: PROFILE,
      detached: true,
      startedAt: new Date().toISOString(),
    }
    fsHooks.afterExists = (path, answer) => {
      if (path !== lockPath(plan) || answer) return
      fsHooks.afterExists = undefined
      writeFileSync(lockPath(plan), JSON.stringify({ ...record, pid: process.pid }))
    }

    expect(await stopRun(record, lockPath(plan))).toBe('orphaned')
    expect((await readLock(lockPath(plan)))?.pid).toBe(process.pid)
  })

  test('the same pid with a different startedAt is a different run', async () => {
    const plan = await planFor()
    await holdWith(plan, DEAD_PID)
    const mine = { ...(await readLock(lockPath(plan)))!, startedAt: '2020-01-01T00:00:00.000Z' }

    await stopRun(mine, lockPath(plan))
    expect(existsSync(lockPath(plan))).toBe(true)
  })
})

describe('heldLock release', () => {
  test('release drops only a lock this process still holds', async () => {
    const plan = await planFor()
    const lock = await takeLock(plan)
    await holdWith(plan, DEAD_PID)

    await lock.release()
    expect((await readLock(lockPath(plan)))?.pid).toBe(DEAD_PID)
  })
})

async function writeRecord(plan: LaunchPlan, text: string): Promise<void> {
  await writeFile(join(plan.instanceDir, '.gamecrate', 'last-exit.json'), text)
}

describe('lastExit', () => {
  test('the recorded code and reason come back', async () => {
    const plan = await planFor()
    await recordExit(plan, { code: 6, reason: 'marker-timeout' })
    const found = await lastExit(plan.instanceDir)
    expect(found?.code).toBe(6)
    expect(found?.reason).toBe('marker-timeout')
  })

  test('no record is undefined, not a throw', async () => {
    const plan = await planFor()
    expect(await lastExit(plan.instanceDir)).toBeUndefined()
  })

  test('a truncated record is undefined, not a throw', async () => {
    const plan = await planFor()
    await writeRecord(plan, '{"at":"now","co')
    expect(await lastExit(plan.instanceDir)).toBeUndefined()
  })

  test('a record whose code is not an integer is undefined', async () => {
    const plan = await planFor()
    for (const code of ['null', '"3"', '1.5', 'undefined']) {
      await writeRecord(plan, `{"at":"${new Date().toISOString()}","code":${code},"reason":"exited"}`)
      expect(await lastExit(plan.instanceDir)).toBeUndefined()
    }
  })
})

describe('tailArgv', () => {
  test('a live holder gets -f bounded by its pid', () => {
    expect(tailArgv('/l/stdout.log', true, 42)).toEqual([
      'tail', '-n', '+1', '-f', '--pid', '42', '/l/stdout.log',
    ])
  })

  test('with no live holder there is no -f, so tail cannot hang on a dead writer', () => {
    expect(tailArgv('/l/stdout.log', false)).toEqual(['tail', '/l/stdout.log'])
    expect(tailArgv('/l/stdout.log', true)).toEqual(['tail', '-n', '+1', '/l/stdout.log'])
  })
})

describe('awaitExit', () => {
  test('a finished run answers from its record without waiting', async () => {
    const plan = await planFor()
    await recordExit(plan, { code: 3, reason: 'exited' })
    expect(await awaitExit(plan.instanceDir, 10)).toMatchObject({ code: 3, reason: 'exited' })
  })

  test('a run that never happened is absent, not a wait', async () => {
    const plan = await planFor()
    expect(await awaitExit(plan.instanceDir, 10)).toBe('absent')
  })

  test('a dead holder with no record is orphaned rather than waited on forever', async () => {
    const plan = await planFor()
    await holdWith(plan, DEAD_PID)
    expect(await awaitExit(plan.instanceDir, 10)).toBe('orphaned')
    expect(existsSync(lockPath(plan))).toBe(true)
  })

  test('a dead holder that did record an exit still answers with it', async () => {
    const plan = await planFor()
    await holdWith(plan, DEAD_PID)
    await recordExit(plan, { code: 7, reason: 'stopped' })
    expect(await awaitExit(plan.instanceDir, 10)).toMatchObject({ code: 7 })
  })

  test('a live holder blocks until its record lands', async () => {
    const plan = await planFor()
    await holdWith(plan, process.pid)

    setTimeout(() => void recordExit(plan, { code: 0, reason: 'window-closed' }), 120)

    expect(await awaitExit(plan.instanceDir, 10)).toMatchObject({ code: 0, reason: 'window-closed' })
  })

  test('a record newer than the lock answers at once, lock still held', async () => {
    const plan = await planFor()
    await holdWith(plan, process.pid)
    await recordExit(plan, { code: 4, reason: 'exited' })

    expect(await awaitExit(plan.instanceDir, 10)).toMatchObject({ code: 4, reason: 'exited' })
    expect(existsSync(lockPath(plan))).toBe(true)
  })
})

describe('runStartedAt', () => {
  test('round-trips runTimestamp', () => {
    const at = new Date('2026-09-19T00:57:39.074Z')
    expect(runTimestamp(at)).toBe('20260919T005739074Z')
    expect(runStartedAt('20260919T005739074Z')).toBe(at.getTime())
  })

  test('the collision suffix does not make a run undatable', () => {
    expect(runStartedAt('20260919T005739074Z-2')).toBe(Date.parse('2026-09-19T00:57:39.074Z'))
  })

  test('anything that is not a run stamp is undefined', () => {
    for (const name of ['current', '', 'runs', '2026-09-19']) {
      expect(runStartedAt(name)).toBeUndefined()
    }
  })
})

describe('awaitRunLog', () => {
  test('a current link left by an earlier run is not the run we locked', async () => {
    const plan = await planFor()
    const logsDir = join(plan.instanceDir, 'logs')
    const old = openRunLog(logsDir, new Date(Date.now() - 60_000))
    writeFileSync(join(old, 'stdout.log'), 'the previous run\n')

    await holdWith(plan, process.pid)
    const lock = (await readLock(lockPath(plan)))!

    let opened = false
    setTimeout(() => {
      writeFileSync(join(openRunLog(logsDir), 'stdout.log'), '')
      opened = true
    }, 120)

    expect(await awaitRunLog(plan.instanceDir, lock, 20)).toBe(true)
    expect(opened).toBe(true)
  })

  test('a repointed link whose stdout.log has not appeared yet is not ready either', async () => {
    const plan = await planFor()
    const logsDir = join(plan.instanceDir, 'logs')
    writeFileSync(join(openRunLog(logsDir, new Date(Date.now() - 60_000)), 'stdout.log'), 'old\n')

    await holdWith(plan, process.pid)
    const lock = (await readLock(lockPath(plan)))!
    const fresh = openRunLog(logsDir)

    let created = false
    setTimeout(() => {
      writeFileSync(join(fresh, 'stdout.log'), '')
      created = true
    }, 120)

    expect(await awaitRunLog(plan.instanceDir, lock, 20)).toBe(true)
    expect(created).toBe(true)
  })

  test('a holder that dies before opening a log ends the wait instead of hanging', async () => {
    const plan = await planFor()
    const child = spawnArgv(['sleep', '30'], 'ignore')
    await holdWith(plan, child.pid!)
    const lock = (await readLock(lockPath(plan)))!

    setTimeout(() => child.kill(), 150)
    expect(await awaitRunLog(plan.instanceDir, lock, 20)).toBe(false)
  })
})

describe('awaitExit and a lock cleared by a third party', () => {
  test('a stale record does not answer for the run whose lock was cleared', async () => {
    const plan = await planFor()
    await writeRecord(plan, JSON.stringify({ at: '2020-01-01T00:00:00.000Z', code: 0, reason: 'exited' }))
    const child = spawnArgv(['sleep', '30'], 'ignore')
    await holdWith(plan, child.pid!)

    setTimeout(() => void rm(lockPath(plan), { force: true }), 80)
    setTimeout(() => child.kill(), 260)

    expect(await awaitExit(plan.instanceDir, 20)).toBe('orphaned')
  })

  test('once the holder records its own exit, that answers', async () => {
    const plan = await planFor()
    await writeRecord(plan, JSON.stringify({ at: '2020-01-01T00:00:00.000Z', code: 0, reason: 'exited' }))
    await holdWith(plan, process.pid)

    setTimeout(() => void rm(lockPath(plan), { force: true }), 60)
    setTimeout(() => void recordExit(plan, { code: 9, reason: 'exited' }), 160)

    expect(await awaitExit(plan.instanceDir, 20)).toMatchObject({ code: 9 })
  })
})

describe('waitNotice', () => {
  test('a wait that ends quickly says nothing at all', () => {
    for (const waited of [0, 250, 1000, 1999]) expect(waitNotice(waited, 0)).toBeUndefined()
  })

  test('the first line lands once the wait is worth mentioning', () => {
    expect(waitNotice(2000, 0)).toBe('2s')
    expect(waitNotice(45_000, 0)).toBe('45s')
  })

  test('seconds floor too, so no label outruns the wait', () => {
    expect(waitNotice(2600, 0)).toBe('2s')
    expect(waitNotice(59_999, 0)).toBe('59s')
  })

  test('it repeats on elapsed time, not on every poll', () => {
    expect(waitNotice(2250, 2000)).toBeUndefined()
    expect(waitNotice(31_999, 2000)).toBeUndefined()
    expect(waitNotice(32_000, 2000)).toBe('32s')
  })

  test('past a minute it reads in minutes', () => {
    expect(waitNotice(62_000, 32_000)).toBe('1m')
    expect(waitNotice(119_000, 62_000)).toBe('1m')
    expect(waitNotice(120_000, 62_000)).toBe('2m')
  })
})

describe('awaitRunLog says so while it waits', () => {
  test('it prints on the schedule and stops when the holder does', async () => {
    const plan = await planFor()
    const child = spawnArgv(['sleep', '30'], 'ignore')
    await holdWith(plan, child.pid!)
    const lock = (await readLock(lockPath(plan)))!

    const lines: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    setTimeout(() => child.kill(), 200)
    try {
      expect(await awaitRunLog(plan.instanceDir, lock, 20, { firstMs: 40, everyMs: 100 })).toBe(false)
    } finally {
      process.stderr.write = real
    }

    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toContain(`${GAME} ${PROFILE} to open its log (`)
    expect(lines[0]).toContain('(0s)')
  })
})
