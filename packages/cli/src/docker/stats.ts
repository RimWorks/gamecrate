import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

const DEFAULT_SOCKET = '/var/run/docker.sock'

/** One frame of the daemon's stats stream, only the fields the formulas read. */
export interface StatsFrame {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number }
    system_cpu_usage?: number
    online_cpus?: number
  }
  precpu_stats?: {
    cpu_usage?: { total_usage?: number }
    system_cpu_usage?: number
  }
  memory_stats?: {
    usage?: number
    limit?: number
    stats?: { inactive_file?: number }
  }
}

export interface Sample {
  cpuPct: number
  memPct: number
  memUsed: number
  memLimit: number
}

export type StatsEvent =
  | ({ kind: 'sample' } & Sample)
  | { kind: 'error'; message: string }
  | { kind: 'end' }

export type GpuEvent =
  | { kind: 'sample'; utilPct: number; memUsedMb: number; memTotalMb: number }
  | { kind: 'unavailable'; message: string }

export type SocketChoice = { path: string } | { message: string }

/** A tcp `$DOCKER_HOST` points at another machine, so falling back would report this box's numbers. */
export function dockerSocket(env: NodeJS.ProcessEnv = process.env): SocketChoice {
  const host = env.DOCKER_HOST
  if (host === undefined || host === '') return { path: DEFAULT_SOCKET }
  if (host.startsWith('unix://')) return { path: host.slice('unix://'.length) }
  return {
    message: `DOCKER_HOST "${host}" is not a unix socket, so live stats have no socket to read: unset it, or set a unix:// path`,
  }
}

/**
 * A frame carrying `precpu_stats` is already a rate. cgroup v2 drops `percpu_usage`, so the core
 * count comes from `online_cpus`.
 */
export function sampleOf(frame: StatsFrame): Sample {
  const cpu = frame.cpu_stats
  const pre = frame.precpu_stats
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0)
  // Frame 1 omits pre.system_cpu_usage, and a delta against 0 reads as cpu since boot.
  const systemDelta =
    pre?.system_cpu_usage === undefined ? 0 : (cpu?.system_cpu_usage ?? 0) - pre.system_cpu_usage
  const reported = cpu?.online_cpus
  const cpus = reported === undefined || reported <= 0 ? 1 : reported
  const cpuPct = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0

  const memory = frame.memory_stats
  // inactive_file above usage is a real transient. docker's own cli clamps this too
  const memUsed = Math.max(0, (memory?.usage ?? 0) - (memory?.stats?.inactive_file ?? 0))
  const memLimit = memory?.limit ?? 0
  const memPct = memLimit > 0 ? (memUsed / memLimit) * 100 : 0

  return { cpuPct, memPct, memUsed, memLimit }
}

/**
 * One long-lived streaming request per container. `stream=false` waits two collection cycles and
 * `one-shot=true` zeroes `precpu_stats`, so both would cost either latency or the rate itself.
 */
export function subscribeStats(
  containerId: string,
  onEvent: (event: StatsEvent) => void,
  options: { socketPath?: string; env?: NodeJS.ProcessEnv } = {},
): () => void {
  let closed = false

  const emit = (event: StatsEvent): void => {
    if (!closed) onEvent(event)
  }
  const finish = (event: StatsEvent): void => {
    emit(event)
    closed = true
  }

  let socketPath = options.socketPath
  if (socketPath === undefined) {
    const choice = dockerSocket(options.env)
    if ('message' in choice) {
      queueMicrotask(() => finish({ kind: 'error', message: choice.message }))
      return () => {
        closed = true
      }
    }
    socketPath = choice.path
  }

  const req = request(
    { socketPath, path: `/containers/${encodeURIComponent(containerId)}/stats?stream=true`, method: 'GET' },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        finish({ kind: 'error', message: `docker returned ${res.statusCode} for container ${containerId}` })
        return
      }
      eachLine(res, (line) => {
        const frame = parseFrame(line)
        if (frame) emit({ kind: 'sample', ...sampleOf(frame) })
      })
      res.on('error', (error) => finish({ kind: 'error', message: error.message }))
      res.on('end', () => finish({ kind: 'end' }))
    },
  )
  req.on('error', (error) => finish({ kind: 'error', message: error.message }))
  req.end()

  return () => {
    closed = true
    req.destroy()
  }
}

/**
 * One persistent `nvidia-smi` loop rather than a spawn per tick, which measured 21-28ms each. A
 * missing binary is reported once and never retried; per-container GPU has no reliable source.
 */
export function subscribeGpu(
  onEvent: (event: GpuEvent) => void,
  options: { bin?: string } = {},
): () => void {
  if (gpuUnavailable !== undefined) {
    onEvent({ kind: 'unavailable', message: gpuUnavailable })
    return () => {}
  }

  let closed = false
  let sawLine = false
  const give = (message: string): void => {
    gpuUnavailable = message
    if (!closed) onEvent({ kind: 'unavailable', message })
    closed = true
  }

  const proc = spawn(
    options.bin ?? 'nvidia-smi',
    ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits', '--loop-ms=1000'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  proc.on('error', (error) => give(error.message))
  proc.on('close', (code) => {
    if (!sawLine && code !== 0) give(`nvidia-smi exited ${code}`)
  })
  if (proc.stdout) {
    eachLine(proc.stdout, (line) => {
      const fields = line.split(',').map((field) => Number(field.trim()))
      if (fields.length < 3 || fields.some((value) => value === undefined || Number.isNaN(value))) return
      const [util, used, total] = fields as [number, number, number]
      sawLine = true
      if (!closed) onEvent({ kind: 'sample', utilPct: util, memUsedMb: used, memTotalMb: total })
    })
  }

  return () => {
    closed = true
    proc.kill()
  }
}

let gpuUnavailable: string | undefined

/** Only exists so a test can undo the one-shot memo. */
export function resetGpuProbe(): void {
  gpuUnavailable = undefined
}

function parseFrame(line: string): StatsFrame | undefined {
  if (line.trim() === '') return undefined
  try {
    return JSON.parse(line) as StatsFrame
  } catch {
    return undefined
  }
}

function eachLine(stream: Readable, onLine: (line: string) => void): void {
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine)
}
