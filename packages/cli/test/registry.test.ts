import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listRuns, parseDockerRuns, walkLocks } from '../src/run/registry'
import { deadPid } from './pids'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gamecrate-registry-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Fixture {
  pid: number
  instance?: string
  /** Leave unset for a stamp old enough that any live pid reads as a different process. */
  startedAt?: string
  root?: string
}

/** Mirrors containerName: the instance is part of the docker name, so two locks cannot share one. */
async function lock(game: string, profile: string, f: Fixture): Promise<void> {
  const base = f.root ?? root
  const dir = f.instance === undefined
    ? join(base, game, profile, '.gamecrate')
    : join(base, game, profile, 'instances', f.instance, '.gamecrate')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'lock'),
    JSON.stringify({
      pid: f.pid,
      container: `gamecrate-${game}-${profile}${f.instance === undefined ? '' : `-${f.instance}`}`,
      game,
      profile,
      ...(f.instance === undefined ? {} : { instance: f.instance }),
      detached: true,
      startedAt: f.startedAt ?? '2026-09-18T12:00:00.000Z',
    }),
  )
}

describe('parseDockerRuns', () => {
  test('tab separated label output becomes records', () => {
    const out =
      'gamecrate-rimworld-dev\trimworld\tdev\t\tUp 4 minutes\n' +
      'gamecrate-rimworld-dev-wt\trimworld\tdev\twt-a1b2c3\tUp 2 seconds\n'
    expect(parseDockerRuns(out)).toEqual([
      { game: 'rimworld', profile: 'dev', container: 'gamecrate-rimworld-dev', uptime: 'Up 4 minutes', status: 'running' },
      { game: 'rimworld', profile: 'dev', instance: 'wt-a1b2c3', container: 'gamecrate-rimworld-dev-wt', uptime: 'Up 2 seconds', status: 'running' },
    ])
  })

  test('empty output is an empty list, not a one-entry list', () => {
    expect(parseDockerRuns('')).toEqual([])
    expect(parseDockerRuns('\n')).toEqual([])
  })
})

describe('walkLocks', () => {
  test('profile and instance locks are both found', async () => {
    await lock('rimworld', 'dev', { pid: 111 })
    await lock('rimworld', 'dev', { pid: 222, instance: 'wt-a1b2c3' })
    const found = await walkLocks(root)
    expect(found.map((l) => l.pid).sort()).toEqual([111, 222])
    expect(found.find((l) => l.pid === 222)?.instance).toBe('wt-a1b2c3')
  })

  test('a missing data root is empty, not a throw', async () => {
    await expect(walkLocks(join(root, 'nope'))).resolves.toEqual([])
  })
})

describe('listRuns', () => {
  // both statuses asserted exactly, and each fixture pid is one this machine agrees with: a
  // hardcoded 'starting' or 'orphaned' in place of the isRunning call now fails one of them.
  test('a lock with no container is reported, with the status its pid earns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-status-'))
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      await lock('rimworld', 'gone', { pid: deadPid(), root: dir })
      await lock('rimworld', 'booting', {
        pid: child.pid!,
        root: dir,
        // the child began before this, which is what isRunning demands of a live holder
        startedAt: new Date().toISOString(),
      })
      const runs = await listRuns(dir, () => Promise.resolve(''))
      expect(runs.length).toBe(2)
      expect(runs.find((r) => r.profile === 'gone')?.status).toBe('orphaned')
      expect(runs.find((r) => r.profile === 'booting')?.status).toBe('starting')
    } finally {
      child.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // the two fixtures hold different container names, so no tie-break runs and no pid liveness
  // decides the answer. the merge's own tie-break is pinned in `listRuns merge` below.
  test('a container and its lock are one row, not two', async () => {
    const docker = 'gamecrate-rimworld-dev\trimworld\tdev\t\tUp 4 minutes\n'
    const runs = await listRuns(root, () => Promise.resolve(docker))
    expect(runs.length).toBe(2)
    expect(runs.filter((r) => r.container === 'gamecrate-rimworld-dev').length).toBe(1)
    expect(runs.find((r) => r.container === 'gamecrate-rimworld-dev')?.status).toBe('running')
    expect(runs.find((r) => r.container === 'gamecrate-rimworld-dev')?.pid).toBe(111)
    expect(runs.find((r) => r.container === 'gamecrate-rimworld-dev-wt-a1b2c3')?.pid).toBe(222)
  })
})

interface Held {
  pid: number
  startedAt: string
}

const DEAD: Held = { pid: 2 ** 22 - 1, startedAt: '2020-01-01T00:00:00.000Z' }

function live(pid: number): Held {
  return { pid, startedAt: new Date().toISOString() }
}

/**
 * Two locks can land on one container name: profile `dev-wt` and profile `dev` instance `wt`.
 * walkLocks always visits a profile lock before its instances, so `profile` merges first.
 */
async function collidingRoot(profile: Held, instance: Held): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gamecrate-collide-'))
  const write = async (path: string, held: Held): Promise<void> => {
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, 'lock'),
      JSON.stringify({
        ...held,
        container: 'gamecrate-rimworld-dev-wt',
        game: 'rimworld',
        profile: 'dev',
        detached: true,
      }),
    )
  }
  await write(join(dir, 'rimworld', 'dev', '.gamecrate'), profile)
  await write(join(dir, 'rimworld', 'dev', 'instances', 'wt', '.gamecrate'), instance)
  return dir
}

describe('listRuns merge', () => {
  const docker = 'gamecrate-rimworld-dev-wt\trimworld\tdev\twt\tUp 4 minutes\n'

  async function mergedPid(profile: Held, instance: Held): Promise<number | undefined> {
    const dir = await collidingRoot(profile, instance)
    try {
      const runs = await listRuns(dir, () => Promise.resolve(docker))
      expect(runs.length).toBe(1)
      return runs[0]!.pid
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test('a live lock replaces the dead one that merged before it', async () => {
    expect(await mergedPid(DEAD, live(process.pid))).toBe(process.pid)
  })

  // pins the merge against a guard that tests the incoming lock: that one is last-wins, which
  // is readdir order again with a different answer. the second live pid is a child this test
  // spawns, not process.ppid, so nothing here depends on how vitest parents its workers.
  test('a live lock does not replace a live one that merged before it', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      expect(await mergedPid(live(process.pid), live(child.pid!))).toBe(process.pid)
    } finally {
      child.kill()
    }
  })
})
