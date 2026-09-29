import { spawn } from 'node:child_process'
import type { ChildProcess, StdioOptions } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { TextDecoder } from 'node:util'
import type { DockerRunSpec } from '../types'
import { constants } from 'node:os'
import { Exit, STDOUT_LOG } from '../types'
import { toDockerArgs } from './spec'
import { emit } from '../channels'
import type { Channel } from '../channels'

/** argv as one array, the way every caller here has it. */
export function spawnArgv(argv: string[], stdio: StdioOptions, detached = false): ChildProcess {
  return spawn(argv[0]!, argv.slice(1), { stdio, detached })
}

/** A signal death reports a null code. 128+n is what a shell would have reported. */
export function exited(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', (code, signal) => {
      if (code !== null) return resolve(code)
      const number = signal === null ? undefined : constants.signals[signal]
      resolve(number === undefined ? 1 : 128 + number)
    })
  })
}

export async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Runs a short command and collects both streams. A missing binary is exit 127 with the spawn
 * error as stderr, so every caller can report it the same way rather than throwing.
 */
export async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = spawnArgv(argv, ['ignore', 'pipe', 'pipe'])
    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout!),
      collect(proc.stderr!),
      exited(proc),
    ])
    return { code, stdout, stderr }
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Streams a child's output while keeping it, for a caller that parses it too. Both streams as
 * one string because the parse reads them as one, and to stderr because --json owns stdout.
 */
export async function captureLive(
  argv: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; text: string }> {
  const proc = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env })
  const chunks: Buffer[] = []
  const keep = async (stream: Readable): Promise<void> => {
    for await (const chunk of stream) {
      emit('status', chunk as Buffer)
      chunks.push(chunk as Buffer)
    }
  }
  const [, , code] = await Promise.all([keep(proc.stdout!), keep(proc.stderr!), exited(proc)])
  return { code, text: Buffer.concat(chunks).toString('utf8') }
}

const MARKER_POLL_MS = 200

export interface RunOptions {
  /** Run log directory; created if missing. Receives stdout.log. */
  logDir: string
  /** Passed to `docker stop --timeout` when a signal arrives. */
  stopTimeoutSeconds?: number
  /** The dashboard reads the keyboard, so the container must not also hold fd 0. */
  stdin?: 'inherit' | 'ignore'
}

/**
 * Spawns docker directly rather than through a pipeline, so the game's status is the status.
 * `exec docker run | tee` returns tee's code, which is why the old scripts always reported 0.
 */
export async function runContainer(spec: DockerRunSpec, opts: RunOptions): Promise<number> {
  const stopTimeout = opts.stopTimeoutSeconds ?? 10

  mkdirSync(opts.logDir, { recursive: true })
  const sink = createWriteStream(join(opts.logDir, STDOUT_LOG))

  const proc = spawnArgv(['docker', ...toDockerArgs(spec)], [opts.stdin ?? 'inherit', 'pipe', 'pipe'])

  let interrupted = false
  const onSignal = () => {
    if (interrupted) return
    interrupted = true
    void stopContainer(spec.name, stopTimeout)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const code = exited(proc)
  try {
    const [, , status] = await Promise.all([
      tee(proc.stdout!, sink, 'game'),
      tee(proc.stderr!, sink, 'gameError'),
      code,
    ])
    return interrupted ? Exit.Interrupted : status
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await new Promise<void>((resolve) => sink.end(resolve))
  }
}

/** Grace docker gives the game before SIGKILL, and the budget every teardown is measured against. */
export const STOP_TIMEOUT_SECONDS = 10

export async function stopContainer(name: string, timeoutSeconds: number): Promise<void> {
  const proc = spawnArgv(['docker', 'stop', '--timeout', String(timeoutSeconds), name], 'ignore')
  await exited(proc).catch(() => {})
}

/**
 * Host-side marker watch. Watches container stdout AND the game's own log file: RimWorld sends
 * Verse.Log output to -logfile, never to stdout.
 */
export async function waitForMarker(
  sources: string[],
  marker: string,
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000
  const carry = Math.max(marker.length - 1, 0)
  const seen = new Map<string, Watched>()
  const startedAt = Date.now()

  while (true) {
    for (const path of await expandSources(sources)) {
      let state = seen.get(path)
      if (state === undefined) {
        state = { offset: await staleSize(path, startedAt), tail: '', decoder: new TextDecoder() }
        seen.set(path, state)
      }

      if (await scan(path, state, marker, carry)) return true
    }

    if (Date.now() >= deadline) return false
    await sleep(Math.min(MARKER_POLL_MS, Math.max(deadline - Date.now(), 0)))
  }
}

interface Watched {
  offset: number
  tail: string
  decoder: TextDecoder
}

async function staleSize(path: string, startedAt: number): Promise<number> {
  return stat(path).then(
    (info) => (info.mtimeMs < startedAt ? info.size : 0),
    () => 0,
  )
}

async function scan(
  path: string,
  state: Watched,
  marker: string,
  carry: number,
): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => null)
  if (handle === null) return false
  try {
    const { size } = await handle.stat()
    if (size < state.offset) {
      state.offset = 0
      state.tail = ''
      state.decoder = new TextDecoder()
    }
    if (size <= state.offset) return false

    const buffer = Buffer.alloc(size - state.offset)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset)
    state.offset += bytesRead
    const text = state.tail + state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
    if (text.includes(marker)) return true
    state.tail = carry > 0 ? text.slice(-carry) : ''
    return false
  } catch {
    return false
  } finally {
    await handle.close().catch(() => {})
  }
}

async function expandSources(sources: string[]): Promise<string[]> {
  const out: string[] = []
  for (const source of sources) {
    const info = await stat(source).catch(() => null)
    if (info === null) {
      out.push(source)
      continue
    }
    if (!info.isDirectory()) {
      out.push(source)
      continue
    }
    const entries = await readdir(source).catch((): string[] => [])
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.log')) out.push(join(source, entry))
    }
  }
  return out
}

async function tee(stream: Readable, sink: Writable, channel: Channel): Promise<void> {
  for await (const chunk of stream) {
    emit(channel, chunk as Buffer)
    sink.write(chunk as Buffer)
  }
}
