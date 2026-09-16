import { mkdirSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DockerRunSpec } from '../types'
import { Exit } from '../types'
import { toDockerArgs } from './spec'

/**
 * Runs a short command and collects both streams. A missing binary is exit 127 with the spawn
 * error as stderr, so every caller can report it the same way rather than throwing.
 */
export async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** The tee'd combined stream, and what waitForMarker watches. */
export const STDOUT_LOG = 'stdout.log'

const MARKER_POLL_MS = 200

export interface RunOptions {
  /** Run log directory; created if missing. Receives stdout.log. */
  logDir: string
  /** Passed to `docker stop --timeout` when a signal arrives. */
  stopTimeoutSeconds?: number
}

/**
 * Spawns docker directly rather than through a pipeline, so the game's status is the status.
 * `exec docker run | tee` returns tee's code, which is why the old scripts always reported 0.
 */
export async function runContainer(spec: DockerRunSpec, opts: RunOptions): Promise<number> {
  const stopTimeout = opts.stopTimeoutSeconds ?? 10

  mkdirSync(opts.logDir, { recursive: true })
  const sink = Bun.file(join(opts.logDir, STDOUT_LOG)).writer()

  const proc = Bun.spawn(['docker', ...toDockerArgs(spec)], {
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let interrupted = false
  const onSignal = () => {
    if (interrupted) return
    interrupted = true
    void stopContainer(spec.name, stopTimeout)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await Promise.all([
      tee(proc.stdout, sink, process.stdout),
      tee(proc.stderr, sink, process.stderr),
    ])
    const code = await proc.exited
    return interrupted ? Exit.Interrupted : code
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await sink.end()
  }
}

export async function stopContainer(name: string, timeoutSeconds: number): Promise<void> {
  const proc = Bun.spawn(['docker', 'stop', '--timeout', String(timeoutSeconds), name], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

/**
 * Host-side marker watch. Watches container stdout AND the game's own log file: RimWorld
 * sends Verse.Log output to -logfile, never to stdout, so a stdout-only watch can never
 * match a RimWorld mod's message.
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
        // Logs/Player-prev.log holds the PREVIOUS run's marker verbatim, so its history
        // would match instantly. Skip what a file already held before this watch began,
        // keyed on mtime so a fresh stdout.log is still read from byte zero.
        state = { offset: await staleSize(path, startedAt), tail: '', decoder: new TextDecoder() }
        seen.set(path, state)
      }

      if (await scan(path, state, marker, carry)) return true
    }

    if (Date.now() >= deadline) return false
    await Bun.sleep(Math.min(MARKER_POLL_MS, Math.max(deadline - Date.now(), 0)))
  }
}

interface Watched {
  offset: number
  tail: string
  /** Per path: a shared streaming decoder corrupts every file after the first. */
  decoder: TextDecoder
}

/** Bytes to skip: a file last written before the watch started is a previous run's log. */
async function staleSize(path: string, startedAt: number): Promise<number> {
  return stat(path).then(
    (info) => (info.mtimeMs < startedAt ? info.size : 0),
    () => 0,
  )
}

/** Never throws: one unreadable file must not reject the whole watch. */
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

/** A source is a file or a directory of logs; directories are rescanned every poll. */
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

async function tee(
  stream: ReadableStream<Uint8Array>,
  sink: Bun.FileSink,
  mirror: NodeJS.WriteStream,
): Promise<void> {
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    mirror.write(value)
    sink.write(value)
  }
}
