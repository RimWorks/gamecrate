import { readdir, readlink, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { byteOrder, runStartedAt } from '../cli/output'
import { expandHome } from '../config/load'
import { capture } from '../docker/run'
import { isRunning, readLock } from '../launch/prepare'
import { downloadRoot } from '../mods/steamcmd'
import type { GameConfig } from '../types'
import { lockIn, parseDockerRuns, walkInstanceDirs } from './registry'

export type PruneKind = 'run' | 'lock' | 'download' | 'container'

export interface PruneAction {
  kind: PruneKind
  /** A path for the first three kinds, a container name for the last. */
  target: string
  reason: string
}

export interface PruneResult {
  actions: PruneAction[]
  /** Whatever refused to delete. A busy file is a note, not a failure. */
  errors: { target: string; message: string }[]
}

export interface PruneOptions {
  dataRoot: string
  games: Record<string, GameConfig>
  keepRuns: number
  maxAgeDays: number
  locks: boolean
  downloads: boolean
  containers: boolean
  dryRun: boolean
  now?: number
  docker?: Docker
}

type Docker = (argv: string[]) => Promise<{ code: number; stdout: string }>

const realDocker: Docker = async (argv) => {
  const { code, stdout } = await capture(argv)
  return { code, stdout }
}

const RUNNING_FORMAT = '{{.Names}}\t{{.Label "gamecrate.game"}}\t{{.Label "gamecrate.profile"}}'

/** Sweeps every game, profile and instance under `dataRoot`. A dry run decides and deletes nothing. */
export async function prune(opts: PruneOptions): Promise<PruneResult> {
  const result: PruneResult = { actions: [], errors: [] }
  const cutoff = (opts.now ?? Date.now()) - opts.maxAgeDays * 86_400_000
  const docker = opts.docker ?? realDocker
  const root = expandHome(opts.dataRoot)

  const live = await runningContainers(docker)
  const dirs = await walkInstanceDirs(root)

  for (const found of dirs) await sweepRuns(result, join(found.dir, 'logs'), opts.keepRuns, cutoff)
  if (opts.locks) for (const found of dirs) await sweepLock(result, lockIn(found.dir), live)
  if (opts.downloads) for (const game of Object.values(opts.games)) await sweepDownloads(result, root, game, cutoff)
  if (opts.containers) await sweepContainers(result, docker)

  if (!opts.dryRun) await apply(result, docker)
  return result
}

async function runningContainers(docker: Docker): Promise<Set<string>> {
  const { code, stdout } = await docker([
    'docker', 'ps', '--filter', 'label=gamecrate.game', '--format', RUNNING_FORMAT,
  ])
  if (code !== 0) return new Set()
  return new Set(parseDockerRuns(stdout).map((run) => run.container))
}

async function sweepRuns(result: PruneResult, logsDir: string, keepRuns: number, cutoff: number): Promise<void> {
  const runsDir = join(logsDir, 'runs')
  const names = (await readdir(runsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byteOrder)
    .reverse()
  if (names.length === 0) return

  const current = await readlink(join(logsDir, 'current')).catch(() => undefined)
  const keep = current === undefined ? undefined : basename(current)

  for (const [index, name] of names.entries()) {
    if (name === keep) continue
    if (index >= keepRuns) {
      result.actions.push({ kind: 'run', target: join(runsDir, name), reason: `past the newest ${keepRuns}` })
      continue
    }
    const startedAt = runStartedAt(name)
    if (startedAt !== undefined && startedAt < cutoff) {
      result.actions.push({ kind: 'run', target: join(runsDir, name), reason: 'older than the cutoff' })
    }
  }
}

async function sweepLock(result: PruneResult, path: string, live: Set<string>): Promise<void> {
  const lock = await readLock(path)
  if (lock === undefined) return
  if (isRunning(lock.pid, lock.startedAt) || live.has(lock.container)) return
  result.actions.push({ kind: 'lock', target: path, reason: `pid ${lock.pid} and ${lock.container} are both gone` })
}

async function sweepDownloads(
  result: PruneResult,
  dataRoot: string,
  game: GameConfig,
  cutoff: number,
): Promise<void> {
  const content = downloadRoot(dataRoot, game)
  const items = await readdir(content, { withFileTypes: true }).catch(() => [])
  let stale = 0
  for (const item of items) {
    if (!item.isDirectory()) continue
    const dir = join(content, item.name)
    const info = await stat(dir).catch(() => undefined)
    if (info === undefined || info.mtimeMs >= cutoff) continue
    result.actions.push({ kind: 'download', target: dir, reason: 'workshop item older than the cutoff' })
    stale++
  }
  if (stale === 0) return
  const acf = join(dirname(dirname(content)), `appworkshop_${game.steamAppId}.acf`)
  result.actions.push({
    kind: 'download',
    target: acf,
    reason: 'tracks items that just went, so steamcmd rewrites it on the next download',
  })
}

async function sweepContainers(result: PruneResult, docker: Docker): Promise<void> {
  const { code, stdout } = await docker([
    'docker', 'ps', '-a',
    '--filter', 'label=gamecrate.game',
    '--filter', 'status=exited',
    '--format', '{{.Names}}',
  ])
  if (code !== 0) return
  for (const name of stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
    result.actions.push({ kind: 'container', target: name, reason: 'exited' })
  }
}

async function apply(result: PruneResult, docker: Docker): Promise<void> {
  for (const action of result.actions) {
    if (action.kind === 'container') {
      const { code, stdout } = await docker(['docker', 'rm', action.target])
      if (code !== 0) result.errors.push({ target: action.target, message: stdout.trim() || `docker rm exit ${code}` })
      continue
    }
    try {
      await rm(action.target, { recursive: true, force: true })
    } catch (error) {
      result.errors.push({ target: action.target, message: (error as Error).message })
    }
  }
}
