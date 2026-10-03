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

export interface InstanceDir {
  game: string
  profile: string
  instance?: string
  dir: string
}

/** <dataRoot>/<game>/<profile>, plus one level of instances under each. */
export async function walkInstanceDirs(dataRoot: string): Promise<InstanceDir[]> {
  const out: InstanceDir[] = []
  for (const game of await entries(dataRoot)) {
    const gameDir = join(dataRoot, game)
    for (const profile of await entries(gameDir)) {
      const profileDir = join(gameDir, profile)
      out.push({ game, profile, dir: profileDir })
      const instancesDir = join(profileDir, 'instances')
      for (const instance of await entries(instancesDir)) {
        out.push({ game, profile, instance, dir: join(instancesDir, instance) })
      }
    }
  }
  return out
}

export async function walkLocks(dataRoot: string): Promise<LockRecord[]> {
  const out: LockRecord[] = []
  for (const found of await walkInstanceDirs(dataRoot)) {
    await push(out, lockIn(found.dir))
  }
  return out
}

export function lockIn(instanceDir: string): string {
  return join(instanceDir, '.gamecrate', 'lock')
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
    if (match === undefined) out.push(fromLock(lock))
    else mergeLock(match, lock)
  }
  return out
}

function mergeLock(match: RunRecord, lock: LockRecord): void {
  const stale = match.pid !== undefined && !isRunning(match.pid, match.startedAt)
  if (match.pid !== undefined && !(stale && isRunning(lock.pid, lock.startedAt))) return
  match.pid = lock.pid
  match.startedAt = lock.startedAt
  if (lock.mode !== undefined) match.mode = lock.mode
}

function fromLock(lock: LockRecord): RunRecord {
  return {
    game: lock.game,
    profile: lock.profile,
    ...(lock.instance === undefined ? {} : { instance: lock.instance }),
    container: lock.container,
    pid: lock.pid,
    ...(lock.mode === undefined ? {} : { mode: lock.mode }),
    startedAt: lock.startedAt,
    status: isRunning(lock.pid, lock.startedAt) ? 'starting' : 'orphaned',
  }
}
