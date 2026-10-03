import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prune } from '../src/run/prune'
import type { PruneAction, PruneOptions } from '../src/run/prune'
import type { GameConfig } from '../src/types'
import { fixtureGame } from './fixture-plugin'
import { deadPid } from './pids'

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const DAY = 86_400_000

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gamecrate-prune-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function stamp(at: number): string {
  return new Date(at).toISOString().replaceAll(/[-:.]/g, '')
}

async function runDirs(profile: string, ages: number[], current?: number): Promise<string[]> {
  const logs = join(root, 'atlas', profile, 'logs')
  const names: string[] = []
  for (const days of ages) {
    const name = stamp(NOW - days * DAY)
    await mkdir(join(logs, 'runs', name), { recursive: true })
    await writeFile(join(logs, 'runs', name, 'stdout.log'), 'x')
    names.push(name)
  }
  if (current !== undefined) await symlink(join('runs', names[current]!), join(logs, 'current'), 'dir')
  return names.map((name) => join(logs, 'runs', name))
}

async function lock(
  profile: string,
  pid: number,
  container = 'gamecrate-atlas-dev',
  startedAt = new Date(NOW - DAY).toISOString(),
): Promise<string> {
  const dir = join(root, 'atlas', profile, '.gamecrate')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'lock')
  await writeFile(
    path,
    JSON.stringify({ pid, container, game: 'atlas', profile, detached: true, startedAt }),
  )
  return path
}

async function workshopItem(id: string, days: number): Promise<string> {
  const dir = join(root, 'steam', 'steamapps', 'workshop', 'content', '294100', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'About.txt'), 'x')
  const at = (NOW - days * DAY) / 1000
  await utimes(dir, at, at)
  return dir
}

function stubDocker(outputs: Record<string, string>, calls: string[][] = []): PruneOptions['docker'] {
  return async (argv) => {
    calls.push(argv)
    const key = argv.includes('-a') ? 'exited' : argv[1] === 'rm' ? 'rm' : 'running'
    return { code: 0, stdout: outputs[key] ?? '' }
  }
}

function options(over: Partial<PruneOptions> = {}): PruneOptions {
  const game: GameConfig = fixtureGame()
  return {
    dataRoot: root,
    games: { atlas: game },
    keepRuns: 10,
    maxAgeDays: 30,
    locks: false,
    downloads: false,
    containers: false,
    dryRun: false,
    now: NOW,
    docker: stubDocker({}),
    ...over,
  }
}

function targets(actions: PruneAction[], kind: PruneAction['kind']): string[] {
  return actions.filter((action) => action.kind === kind).map((action) => action.target)
}

describe('run logs', () => {
  test('keeps the newest keepRuns and deletes the rest', async () => {
    const dirs = await runDirs('dev', [1, 2, 3, 4])

    const result = await prune(options({ keepRuns: 2 }))

    expect(targets(result.actions, 'run').toSorted()).toEqual([dirs[2]!, dirs[3]!].toSorted())
    expect(existsSync(dirs[0]!)).toBe(true)
    expect(existsSync(dirs[1]!)).toBe(true)
    expect(existsSync(dirs[2]!)).toBe(false)
    expect(existsSync(dirs[3]!)).toBe(false)
  })

  test('deletes a run older than the cutoff even inside the keep window', async () => {
    const dirs = await runDirs('dev', [1, 40])

    const result = await prune(options({ keepRuns: 10, maxAgeDays: 30 }))

    expect(targets(result.actions, 'run')).toEqual([dirs[1]!])
    expect(existsSync(dirs[0]!)).toBe(true)
  })

  test('keeps whatever current points at, however old it is', async () => {
    const dirs = await runDirs('dev', [400], 0)

    const result = await prune(options({ keepRuns: 0, maxAgeDays: 1 }))

    expect(result.actions).toEqual([])
    expect(existsSync(dirs[0]!)).toBe(true)
  })

  test('sweeps an instance under a profile, not just the profile', async () => {
    const logs = join(root, 'atlas', 'dev', 'instances', 'wt-a1b2c3', 'logs', 'runs')
    const old = join(logs, stamp(NOW - 90 * DAY))
    await mkdir(old, { recursive: true })

    const result = await prune(options({ keepRuns: 10 }))

    expect(targets(result.actions, 'run')).toEqual([old])
  })

  test('a dry run reports every target and deletes none of them', async () => {
    const dirs = await runDirs('dev', [1, 2, 3])

    const result = await prune(options({ keepRuns: 1, dryRun: true }))

    expect(targets(result.actions, 'run').toSorted()).toEqual([dirs[1]!, dirs[2]!].toSorted())
    expect(existsSync(dirs[1]!)).toBe(true)
    expect(existsSync(dirs[2]!)).toBe(true)
  })
})

describe('locks', () => {
  test('deletes a lock whose pid and container are both gone', async () => {
    const path = await lock('dev', deadPid())

    const result = await prune(options({ locks: true }))

    expect(targets(result.actions, 'lock')).toEqual([path])
    expect(existsSync(path)).toBe(false)
  })

  test('keeps a lock whose process is alive', async () => {
    const path = await lock('dev', process.pid, 'gamecrate-atlas-dev', new Date().toISOString())

    const result = await prune(options({ locks: true }))

    expect(result.actions).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  test('keeps a lock whose container still runs, dead pid and all', async () => {
    const path = await lock('dev', deadPid(), 'gamecrate-atlas-dev')
    const docker = stubDocker({ running: 'gamecrate-atlas-dev\tatlas\tdev\n' })

    const result = await prune(options({ locks: true, docker }))

    expect(result.actions).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  test('leaves locks alone when the config turns them off', async () => {
    const path = await lock('dev', deadPid())

    const result = await prune(options({ locks: false }))

    expect(result.actions).toEqual([])
    expect(existsSync(path)).toBe(true)
  })
})

describe('downloads', () => {
  test('deletes a stale workshop item and the acf that tracks it', async () => {
    const stale = await workshopItem('111', 90)
    const fresh = await workshopItem('222', 2)
    const acf = join(root, 'steam', 'steamapps', 'workshop', 'appworkshop_294100.acf')
    await writeFile(acf, '"AppWorkshop" {}')

    const result = await prune(options({ downloads: true }))

    expect(targets(result.actions, 'download').toSorted()).toEqual([stale, acf].toSorted())
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(acf)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test('keeps the acf when every item is fresh', async () => {
    await workshopItem('222', 2)

    const result = await prune(options({ downloads: true }))

    expect(result.actions).toEqual([])
  })
})

describe('containers', () => {
  test('removes the exited containers docker reports', async () => {
    const calls: string[][] = []
    const docker = stubDocker({ exited: 'gamecrate-atlas-dev\ngamecrate-atlas-old\n' }, calls)

    const result = await prune(options({ containers: true, docker }))

    expect(targets(result.actions, 'container')).toEqual(['gamecrate-atlas-dev', 'gamecrate-atlas-old'])
    expect(calls.filter((argv) => argv[1] === 'rm')).toEqual([
      ['docker', 'rm', 'gamecrate-atlas-dev'],
      ['docker', 'rm', 'gamecrate-atlas-old'],
    ])
  })

  test('a dry run never calls docker rm', async () => {
    const calls: string[][] = []
    const docker = stubDocker({ exited: 'gamecrate-atlas-dev\n' }, calls)

    const result = await prune(options({ containers: true, dryRun: true, docker }))

    expect(targets(result.actions, 'container')).toEqual(['gamecrate-atlas-dev'])
    expect(calls.filter((argv) => argv[1] === 'rm')).toEqual([])
  })

  test('a failed docker rm lands in errors, not an exception', async () => {
    const docker: PruneOptions['docker'] = async (argv) =>
      argv[1] === 'rm' ? { code: 1, stdout: 'container is running' } : { code: 0, stdout: 'gamecrate-atlas-dev\n' }

    const result = await prune(options({ containers: true, docker }))

    expect(result.errors).toEqual([{ target: 'gamecrate-atlas-dev', message: 'container is running' }])
  })
})

test('an empty data root is not an error', async () => {
  const result = await prune(options({ dataRoot: join(root, 'nothing-here'), locks: true, downloads: true }))

  expect(result).toEqual({ actions: [], errors: [] })
})
