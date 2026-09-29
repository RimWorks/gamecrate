import { useBaseSink } from '../channels'
import type { OutputRedirect } from '../channels'
import { paneRows, render } from './dashboard'
import type { Identity, Stats } from './dashboard'
import { LogBuffer, stripAnsi } from './logpane'
import { renderRecord, tailRecords } from './records'
import { Screen } from './screen'
import { colourAllowed } from './tty'
import type { Key } from './screen'
import { subscribeGpu, subscribeStats } from '../docker/stats'

const STATS_RETRY_MS = 1_000
const STATS_RETRY_CEILING_MS = 30_000

export interface SessionOptions {
  identity: Identity
  /** Container name or id. Docker accepts either on the stats endpoint. */
  container: string
  onStop: () => void
  screen?: Screen
  /** Skipped in tests, where there is no daemon and no gpu. */
  probes?: boolean
  /** Defaults to what NO_COLOR and the terminal allow. */
  colour?: boolean
  stats?: typeof subscribeStats
  retryMs?: number
  /** Where a mod writes NDJSON records. Unset keeps the run on raw container output. */
  recordDir?: string
  tail?: typeof tailRecords
}

export interface Session extends OutputRedirect {
  /** The phase word in the header. An `exited ...` phase ends the run. */
  setPhase(phase: string): void
  /** True once the user asked to leave, so a caller can skip the wait it would otherwise do. */
  readonly quitRequested: boolean
  /** Resolves when the user presses q or ctrl-c. Already resolved if they have. */
  waitForQuit(): Promise<void>
}

/**
 * The live dashboard: a base sink feeding the pane, a screen painting it, and two stats
 * subscriptions. Closing puts the terminal and the previous sink back.
 */
export function startSession(opts: SessionOptions): Session {
  const buffer = new LogBuffer()
  const screen = opts.screen ?? new Screen()
  const stats: Stats = {}
  const runtime = { phase: 'booting', startedAt: Date.now() }
  const filter = { active: false, text: '' }
  let scrollback = 0

  const sink = useBaseSink({
    write(channel, chunk) {
      if (runtime.phase === 'booting' && (channel === 'game' || channel === 'gameError')) {
        runtime.phase = 'running'
      }
      buffer.write(channel, chunk)
    },
    close: () => buffer.close(),
  })

  const unsubscribes: (() => void)[] = []
  let statsStop: (() => void) | undefined
  let quitRequested = false
  let resolveQuit: (() => void) | undefined
  let ended = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let closed = false

  /**
   * The session opens before `docker run` does, so the first subscribe answers 404. Reconnect
   * until the container exists, and again if it goes away and comes back.
   */
  const firstWait = opts.retryMs ?? STATS_RETRY_MS
  let wait = firstWait
  const watchStats = (): void => {
    if (closed) return
    statsStop = (opts.stats ?? subscribeStats)(opts.container, (event) => {
      if (event.kind === 'sample') {
        wait = firstWait
        stats.cpuPct = event.cpuPct
        stats.memUsed = event.memUsed
        stats.memLimit = event.memLimit
        return
      }
      if (closed) return
      retry = setTimeout(watchStats, wait)
      wait = Math.min(STATS_RETRY_CEILING_MS, wait * 2)
      if (typeof retry.unref === 'function') retry.unref()
    })
  }

  if (opts.probes !== false) {
    watchStats()
    unsubscribes.push(
      subscribeGpu((event) => {
        if (event.kind !== 'sample') return
        stats.gpuPct = event.utilPct
        stats.vramUsedMb = event.memUsedMb
        stats.vramTotalMb = event.memTotalMb
      }),
    )
  }

  const records = opts.recordDir === undefined ? undefined : new LogBuffer()
  let recordView = false
  if (records !== undefined && opts.recordDir !== undefined) {
    unsubscribes.push(
      (opts.tail ?? tailRecords)({
        dir: opts.recordDir,
        onRecord: (record) => records.push('game', `${renderRecord(record)}\n`),
      }),
    )
  }

  const canToggle = (): boolean => records !== undefined && records.size > 0
  const showingRecords = (): boolean => recordView && canToggle()
  const pane = (): LogBuffer => (showingRecords() && records !== undefined ? records : buffer)

  const colour = opts.colour ?? colourAllowed()

  try {
    screen.start(
      (size) => {
        const frame = render({
          identity: opts.identity,
          stats,
          runtime,
          filter,
          buffer: pane(),
          scrollback,
          size,
          view: showingRecords() ? 'records' : 'raw',
          canToggle: canToggle(),
        })
        return colour ? frame : frame.map(stripAnsi)
      },
      (key) => onKey(key),
    )
  } catch (error) {
    sink.close()
    for (const stop of unsubscribes) stop()
    statsStop?.()
    throw error
  }

  /** Stops a live run, or leaves a finished one. A dead container has nothing to stop. */
  function quit(): void {
    quitRequested = true
    resolveQuit?.()
    if (!ended) opts.onStop()
  }

  function onKey(key: Key): void {
    if (key.name === 'ctrlC') {
      quit()
      return
    }
    if (filter.active) {
      editFilter(key)
      return
    }
    if (key.name === 'char' && key.value === 'q') {
      quit()
      return
    }
    if (key.name === 'char' && key.value === '/') {
      filter.active = true
      return
    }
    if (key.name === 'char' && key.value === 'r') {
      if (!canToggle()) return
      recordView = !recordView
      scrollback = 0
      return
    }

    scrollKey(key)
  }

  function scrollKey(key: Key): void {
    const page = paneRows(screen.size.rows)
    const ceiling = Math.max(0, pane().filter(filter.text).length - page)
    const to = (next: number): void => {
      scrollback = Math.max(0, Math.min(ceiling, next))
    }

    if (key.name === 'char' && key.value === 'G') to(0)
    if (key.name === 'char' && key.value === 'g') to(ceiling)
    if (key.name === 'up') to(scrollback + 1)
    if (key.name === 'down') to(scrollback - 1)
    if (key.name === 'pageUp') to(scrollback + page)
    if (key.name === 'pageDown') to(scrollback - page)
    if (key.name === 'end') to(0)
    if (key.name === 'home') to(ceiling)
  }

  function editFilter(key: Key): void {
    if (key.name === 'escape') {
      filter.active = false
      filter.text = ''
      return
    }
    if (key.name === 'enter') {
      filter.active = false
      return
    }
    if (key.name === 'backspace') {
      filter.text = filter.text.slice(0, -1)
      return
    }
    if (key.name === 'char') filter.text += key.value
    scrollback = 0
  }

  let open = true
  return {
    get quitRequested() {
      return quitRequested
    },
    setPhase(phase) {
      runtime.phase = phase
      if (!phase.startsWith('exited')) return
      ended = true
      if (retry !== undefined) clearTimeout(retry)
      statsStop?.()
    },
    waitForQuit() {
      if (quitRequested || !screen.hasKeyboard) return Promise.resolve()
      return new Promise<void>((resolve) => {
        resolveQuit = resolve
      })
    },
    close() {
      if (!open) return
      open = false
      closed = true
      resolveQuit?.()
      if (retry !== undefined) clearTimeout(retry)
      statsStop?.()
      for (const stop of unsubscribes) stop()
      screen.stop()
      sink.close()
    },
  }
}
