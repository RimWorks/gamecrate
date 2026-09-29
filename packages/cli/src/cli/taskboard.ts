import { useBaseSink } from '../channels'
import type { Channel, OutputRedirect, OutputSink } from '../channels'
import { BRIGHT, CYAN, DIM, GREEN, OFF, RED, YELLOW, bar, closeStyle, displayWidth, stripAnsi, truncateAnsi } from './logpane'
import { Screen } from './screen'

export type TaskState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface Task {
  /** Stable key the caller reports against, such as `public/linux`. */
  id: string
  label: string
  /** A second column, such as the base image a variant appends onto. */
  note?: string
  state: TaskState
  /** What it is doing now, or why it ended. */
  detail?: string
  /** 0 to 1. Absent draws an empty track, which is what a step with no size looks like. */
  fraction?: number
  /** Right of the bar, such as `1893 MB`. */
  amount?: string
}

const MARK: Readonly<Record<TaskState, string>> = {
  pending: `${DIM}·${OFF}`,
  running: `${YELLOW}◐${OFF}`,
  done: `${GREEN}✔${OFF}`,
  skipped: `${DIM}↓${OFF}`,
  failed: `${RED}✗${OFF}`,
}

const HEADER_AND_FOOTER_ROWS = 4
const MAX_PARTIAL = 64 * 1024

const STEAM_PROGRESS = /progress:\s*([\d.]+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i

export interface SteamProgress {
  fraction: number
  amount: string
}

const MIB = 1024 ** 2

function readable(bytes: number): string {
  if (bytes >= 1024 * MIB) return `${(bytes / (1024 * MIB)).toFixed(1)} GiB`
  return `${Math.round(bytes / MIB)} MiB`
}

export function readSteamProgress(line: string): SteamProgress | undefined {
  const found = STEAM_PROGRESS.exec(stripAnsi(line))
  if (found === null) return undefined
  const done = Number(found[2])
  const total = Number(found[3])
  // steamcmd prints `(0 / 0)` for a state with nothing to transfer
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return undefined
  const percent = Number(found[1])
  const fraction = Number.isFinite(percent) && percent > 0 ? percent / 100 : done / total
  return { fraction: Math.min(1, fraction), amount: readable(done) }
}

function pad(text: string, width: number): string {
  const short = width - displayWidth(text)
  return short > 0 ? text + ' '.repeat(short) : text
}

export interface BoardFrame {
  title: string
  subtitle?: string
  tasks: readonly Task[]
  /** The newest line of child output, shown under the rows. */
  live?: string
  elapsed: string
  cols: number
  rows: number
}

export function renderBoard(frame: BoardFrame): string[] {
  const { cols } = frame
  const labelWidth = Math.max(4, ...frame.tasks.map((t) => displayWidth(t.label)))
  const noteWidth = Math.max(0, ...frame.tasks.map((t) => displayWidth(t.note ?? '')))
  const amountWidth = Math.max(0, ...frame.tasks.map((t) => displayWidth(t.amount ?? '')))
  const barWidth = Math.max(6, Math.min(24, cols - labelWidth - noteWidth - amountWidth - 26))

  const lines: string[] = []
  const subtitle = frame.subtitle === undefined ? '' : `  ${DIM}${frame.subtitle}${OFF}`
  const head = `${CYAN}${frame.title}${OFF}${subtitle}`
  lines.push(
    pad(head, Math.max(0, cols - frame.elapsed.length - 1)) + `${DIM}${frame.elapsed}${OFF}`,
    `${DIM}${'─'.repeat(cols)}${OFF}`,
  )

  const budget = Math.max(1, frame.rows - HEADER_AND_FOOTER_ROWS)
  const shown = frame.tasks.length > budget ? frame.tasks.slice(0, budget - 1) : frame.tasks

  for (const task of shown) {
    const cells = [
      ` ${MARK[task.state]}`,
      `${BRIGHT}${pad(task.label, labelWidth)}${OFF}`,
      noteWidth === 0 ? '' : `${DIM}${pad(task.note ?? '', noteWidth)}${OFF}`,
      bar(task.fraction, barWidth, task.state === 'done' ? GREEN : YELLOW),
      amountWidth === 0 ? '' : `${DIM}${pad(task.amount ?? '', amountWidth)}${OFF}`,
      `${DIM}${task.detail ?? ''}${OFF}`,
    ].filter((cell) => cell !== '')
    lines.push(cells.join(' '))
  }

  if (shown.length < frame.tasks.length) {
    lines.push(` ${DIM}and ${frame.tasks.length - shown.length} more${OFF}`)
  }

  lines.push(`${DIM}${'─'.repeat(cols)}${OFF}`)
  if (frame.live !== undefined && frame.live.length > 0) lines.push(` ${DIM}${frame.live}${OFF}`)
  return lines.map((line) => closeStyle(truncateAnsi(line, cols)))
}

export interface BoardOptions {
  title: string
  subtitle?: string
  tasks: readonly Omit<Task, 'state'>[]
  screen?: Screen
  now?: () => number
}

export interface Board extends OutputRedirect {
  update(id: string, patch: Partial<Omit<Task, 'id'>>): void
  /** The rows as they stand, for a caller that prints a summary after closing. */
  readonly tasks: readonly Task[]
}

/**
 * A progress board for a multi-step command. It takes the status channel while it runs, so a
 * child's chatter feeds the live line instead of scrolling the rows away.
 */
export function startBoard(opts: BoardOptions): Board {
  const tasks: Task[] = opts.tasks.map((task) => ({ ...task, state: 'pending' }))
  const screen = opts.screen ?? new Screen()
  const now = opts.now ?? (() => Date.now())
  const startedAt = now()
  let live = ''
  let partial = ''

  const byId = (id: string): Task | undefined => tasks.find((task) => task.id === id)
  const running = (): Task | undefined => tasks.find((task) => task.state === 'running')

  const sink: OutputSink = {
    write(channel: Channel, chunk: string | Uint8Array) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      partial += text
      const parts = partial.split(/\r\n|\r|\n/)
      partial = parts.pop() ?? ''
      if (partial.length > MAX_PARTIAL) partial = partial.slice(-MAX_PARTIAL)
      for (const part of parts) {
        const line = stripAnsi(part).trimEnd()
        if (line.length === 0) continue
        live = line
        const progress = readSteamProgress(line)
        const task = running()
        if (progress !== undefined && task !== undefined) {
          task.fraction = progress.fraction
          task.amount = progress.amount
        }
      }
    },
    close() {},
  }

  const restore = useBaseSink(sink)

  const elapsed = (): string => {
    const total = Math.floor(Math.max(0, now() - startedAt) / 1000)
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }

  try {
    screen.start(
      (size) =>
        renderBoard({
          title: opts.title,
          ...(opts.subtitle === undefined ? {} : { subtitle: opts.subtitle }),
          tasks,
          live,
          elapsed: elapsed(),
          cols: size.cols,
          rows: size.rows,
        }),
      (key) => {
        if (key.name !== 'ctrlC') return
        screen.stop()
        restore.close()
        process.kill(process.pid, 'SIGINT')
      },
    )

  } catch (error) {
    restore.close()
    throw error
  }
  let open = true
  return {
    tasks,
    update(id, patch) {
      if (!open) return
      const task = byId(id)
      if (task === undefined) return
      Object.assign(task, patch)
      if (patch.state === 'done') task.fraction = 1
      if (patch.state === 'skipped' || patch.state === 'failed') task.fraction = undefined
    },
    close() {
      if (!open) return
      open = false
      screen.paint(
        renderBoard({
          title: opts.title,
          ...(opts.subtitle === undefined ? {} : { subtitle: opts.subtitle }),
          tasks,
          live: '',
          elapsed: elapsed(),
          cols: screen.size.cols,
          rows: screen.size.rows,
        }),
      )
      screen.stop()
      restore.close()
    },
  }
}
