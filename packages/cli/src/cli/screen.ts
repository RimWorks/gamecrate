import { emitKeypressEvents } from 'node:readline'

const ALT_ON = '\u001b[?1049h'
const ALT_OFF = '\u001b[?1049l'
const CURSOR_HIDE = '\u001b[?25l'
const CURSOR_SHOW = '\u001b[?25h'
const HOME = '\u001b[H'
const CLEAR_LINE = '\u001b[K'
const CLEAR_BELOW = '\u001b[J'
const RESET = '\u001b[0m'

export interface Size {
  rows: number
  cols: number
}

export interface ScreenOptions {
  /** Defaults to 80x24, which is what a terminal that will not say reports as nothing. */
  out?: NodeJS.WriteStream
  input?: NodeJS.ReadStream
  /** Repaint interval. 16 lines/sec average and 1316 peak both land inside one tick. */
  intervalMs?: number
  /** How long a lone escape waits to see if it starts a sequence. Node's own default is 500ms. */
  escapeMs?: number
}

export type KeyName =
  | 'char'
  | 'enter'
  | 'escape'
  | 'backspace'
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'home'
  | 'end'
  | 'ctrlC'

export type Key = { name: 'char'; value: string } | { name: Exclude<KeyName, 'char'> }

const NAMES: Readonly<Record<string, Exclude<KeyName, 'char'>>> = {
  return: 'enter',
  enter: 'enter',
  escape: 'escape',
  backspace: 'backspace',
  up: 'up',
  down: 'down',
  pageup: 'pageUp',
  pagedown: 'pageDown',
  home: 'home',
  end: 'end',
}

export interface RawKey {
  name?: string
  ctrl?: boolean
  meta?: boolean
  sequence?: string
}

/**
 * A meta chord is dropped rather than decoded: alt+q used to arrive as a bare `q` and stop
 * the run.
 */
export function toKey(str: string | undefined, raw: RawKey): Key | undefined {
  if (raw.ctrl === true) return raw.name === 'c' ? { name: 'ctrlC' } : undefined
  if (raw.meta === true) return raw.name === 'escape' ? { name: 'escape' } : undefined

  const mapped = raw.name === undefined ? undefined : NAMES[raw.name]
  if (mapped !== undefined) return { name: mapped }

  if (str !== undefined && str.length > 0 && str >= ' ' && str !== '\u007f') {
    return { name: 'char', value: str }
  }
  return undefined
}

/**
 * Owns the alternate buffer and one repaint timer. Frames are pulled on the tick, so a burst of
 * input costs one render instead of one per line.
 */
export class Screen {
  private readonly out: NodeJS.WriteStream
  private readonly input: NodeJS.ReadStream
  private readonly intervalMs: number
  private readonly escapeMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private onResize: (() => void) | undefined
  private onKeypress: ((str: string | undefined, raw: RawKey | undefined) => void) | undefined
  private onExit: (() => void) | undefined
  private onHangup: (() => void) | undefined
  private previous: string[] = []
  private open = false

  constructor(opts: ScreenOptions = {}) {
    this.out = opts.out ?? process.stdout
    this.input = opts.input ?? process.stdin
    this.intervalMs = opts.intervalMs ?? 80
    this.escapeMs = opts.escapeMs ?? 50
  }

  get hasKeyboard(): boolean {
    return this.input.isTTY === true
  }

  /** A detached pty reports 0, and `0 ?? 24` is 0, which paints an empty frame. */
  get size(): Size {
    const rows = this.out.rows
    const cols = this.out.columns
    return {
      rows: rows === undefined || rows <= 0 ? 24 : rows,
      cols: cols === undefined || cols <= 0 ? 80 : cols,
    }
  }

  /** Leaves the terminal exactly as it was found, whichever way the process ends. */
  start(render: (size: Size) => string[], keys: (key: Key) => void): void {
    if (this.open) return
    this.open = true

    this.onExit = () => this.stop()
    this.onHangup = () => {
      this.stop()
      process.exit(129)
    }
    process.once('exit', this.onExit)
    process.once('SIGHUP', this.onHangup)

    try {
      this.out.write(ALT_ON + CURSOR_HIDE + HOME + CLEAR_BELOW)

      if (this.input.isTTY) {
        this.input.setRawMode(true)
        this.input.resume()
        emitKeypressEvents(this.input, { escapeCodeTimeout: this.escapeMs } as never)
        this.onKeypress = (str, raw) => {
          const key = toKey(str, raw ?? {})
          if (key !== undefined) keys(key)
        }
        this.input.on('keypress', this.onKeypress)
      }

      const paint = () => {
        this.paint(render(this.size))
      }
      this.onResize = () => {
        this.previous = []
        paint()
      }
      this.out.on('resize', this.onResize)
      this.timer = setInterval(paint, this.intervalMs)
      this.timer.unref()
      paint()
    } catch (error) {
      this.stop()
      throw error
    }
  }

  /** Only the rows that changed are rewritten, so a quiet run costs almost nothing. */
  paint(lines: readonly string[]): void {
    const { rows } = this.size
    const frame = lines.slice(0, rows)
    const out: string[] = []
    for (let i = 0; i < frame.length; i++) {
      if (this.previous[i] === frame[i]) continue
      out.push(`\u001b[${i + 1};1H${frame[i]}${CLEAR_LINE}`)
    }
    if (this.previous.length > frame.length) out.push(`\u001b[${frame.length + 1};1H${CLEAR_BELOW}`)
    if (out.length > 0) this.out.write(out.join(''))
    this.previous = [...frame]
  }

  stop(): void {
    if (!this.open) return
    this.open = false
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.onResize !== undefined) this.out.off('resize', this.onResize)
    if (this.onKeypress !== undefined) this.input.off('keypress', this.onKeypress)
    if (this.onExit !== undefined) {
      process.off('exit', this.onExit)
      if (this.onHangup !== undefined) process.off('SIGHUP', this.onHangup)
    }
    if (this.input.isTTY) {
      this.input.setRawMode(false)
      this.input.pause()
    }
    // SGR survives the buffer switch, so an open colour would follow us out to the shell prompt
    this.out.write(RESET + CURSOR_SHOW + ALT_OFF)
    this.previous = []
  }
}
