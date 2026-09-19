import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { capture } from '../docker/run'
import { isRunning, readLock } from '../launch/prepare'
import type { LockRecord } from '../launch/prepare'

export interface RunRecord {
  game: string
  profile: string
  instance?: string
  container: string
  pid?: number
  mode?: string
  startedAt?: string
  uptime?: string
  status: 'running' | 'starting' | 'orphaned'
}

const FORMAT =
  '{{.Names}}\t{{.Label "gamecrate.game"}}\t{{.Label "gamecrate.profile"}}\t{{.Label "gamecrate.instance"}}\t{{.Status}}'

export function parseDockerRuns(stdout: string): RunRecord[] {
  const out: RunRecord[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [container, game, profile, instance, uptime] = line.split('\t')
    if (container === undefined || game === undefined || profile === undefined) continue
    out.push({
      game,
      profile,
      ...(instance ? { instance } : {}),
      container,
      ...(uptime ? { uptime } : {}),
      status: 'running',
    })
  }
  return out
}

/** <dataRoot>/<game>/<profile>/.gamecrate/lock, plus one level of instances under each. */
export async function walkLocks(dataRoot: string): Promise<LockRecord[]> {
  const out: LockRecord[] = []
  for (const game of await entries(dataRoot)) {
    const gameDir = join(dataRoot, game)
    for (const profile of await entries(gameDir)) {
      const profileDir = join(gameDir, profile)
      await push(out, join(profileDir, '.gamecrate', 'lock'))
      const instancesDir = join(profileDir, 'instances')
      for (const instance of await entries(instancesDir)) {
        await push(out, join(instancesDir, instance, '.gamecrate', 'lock'))
      }
    }
  }
  return out
}

async function entries(dir: string): Promise<string[]> {
  const found = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return found.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function push(out: LockRecord[], path: string): Promise<void> {
  const record = await readLock(path)
  if (record !== undefined) out.push(record)
}

type Docker = () => Promise<string>

const dockerPs: Docker = async () => {
  const { code, stdout } = await capture([
    'docker', 'ps', '--filter', 'label=gamecrate.game', '--format', FORMAT,
  ])
  return code === 0 ? stdout : ''
}

/**
 * Docker answers for anything with a container. The lock walk covers the phase before one
 * exists (pull, build, stage) and a lock whose container is already gone.
 */
export async function listRuns(dataRoot: string, docker: Docker = dockerPs): Promise<RunRecord[]> {
  const running = parseDockerRuns(await docker())
  const byContainer = new Map(running.map((run) => [run.container, run]))
  const out: RunRecord[] = [...running]

  for (const lock of await walkLocks(dataRoot)) {
    const match = byContainer.get(lock.container)
    if (match !== undefined) {
      // on a shared container name a live lock beats a dead one, and a merged live pid is
      // never replaced, so readdir order stops mattering either way
      const stale = match.pid !== undefined && !isRunning(match.pid, match.startedAt)
      if (match.pid === undefined || (stale && isRunning(lock.pid, lock.startedAt))) {
        match.pid = lock.pid
        match.startedAt = lock.startedAt
        if (lock.mode !== undefined) match.mode = lock.mode
      }
      continue
    }
    out.push({
      game: lock.game,
      profile: lock.profile,
      ...(lock.instance === undefined ? {} : { instance: lock.instance }),
      container: lock.container,
      pid: lock.pid,
      ...(lock.mode === undefined ? {} : { mode: lock.mode }),
      startedAt: lock.startedAt,
      status: isRunning(lock.pid, lock.startedAt) ? 'starting' : 'orphaned',
    })
  }
  return out
}
