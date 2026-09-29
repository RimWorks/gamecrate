import ansis from 'ansis'
import { StringDecoder } from 'node:string_decoder'
import type { Channel, OutputSink } from '../channels'

/** Bounded so a 1316 line/sec boot burst cannot grow without limit. */
export const DEFAULT_CAPACITY = 20_000
const MAX_PARTIAL = 64 * 1024

export interface LogLine {
  /** Monotonic, so a filtered view can still say where a line sits in the whole run. */
  seq: number
  channel: Channel
  /** Escapes intact. The game already colours 77% of its own output. */
  text: string
  /** `WARN`, `INFO`, and friends when the line carries one. Continuations carry none. */
  level?: string
}

const LEVEL = /(?:^|\s)(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(?:\s|$)/

function rgb(hex: string): [number, number, number] | undefined {
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex)
  if (short)
    return [short[1]!, short[2]!, short[3]!].map((c) => Number.parseInt(c + c, 16)) as [number, number, number]
  const long = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (long) return [long[1]!, long[2]!, long[3]!].map((c) => Number.parseInt(c, 16)) as [number, number, number]
  return undefined
}

const COLOR_TAG = /<color=([^>]+)>|<\/color>/gi

/**
 * Unity markup becomes real escapes. `</color>` restores the enclosing colour rather than
 * resetting, so a nested tag does not wipe the colour it was written inside.
 */
export function renderColorTags(text: string): string {
  if (!text.includes('<color') && !text.includes('</color')) return text
  const stack: (string | null)[] = []
  let emitted = false

  return text.replace(COLOR_TAG, (_match, value: string | undefined) => {
    if (value === undefined) {
      if (stack.length === 0) return ''
      stack.pop()
      const outer = [...stack].reverse().find((code) => code !== null)
      if (outer !== undefined) return outer
      return emitted ? '\u001b[39m' : ''
    }
    const parsed = rgb(value.trim())
    if (parsed === undefined) {
      stack.push(null)
      return ''
    }
    const code = `\u001b[38;2;${parsed[0]};${parsed[1]};${parsed[2]}m`
    stack.push(code)
    emitted = true
    return code
  })
}

/** The palette both terminal views draw with. */
export const DIM = ansis.gray.open
export const OFF = ansis.reset.open
export const BRIGHT = ansis.whiteBright.open
export const CYAN = ansis.cyan.open
export const GREEN = ansis.green.open
export const YELLOW = ansis.yellow.open
export const RED = ansis.red.open
export const BLUE = ansis.blue.open
export const ORANGE = ansis.fg(173).open

const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g')

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f6ff) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function charWidth(code: number): number {
  if (code >= 0x300 && code <= 0x36f) return 0
  return isWide(code) ? 2 : 1
}

/** Printable columns. Escapes take none, and a wide character takes two. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of stripAnsi(text)) width += charWidth(char.codePointAt(0)!)
  return width
}

/**
 * Cut to `width` printable columns, keeping every escape that came before the cut so colour
 * survives, and closing with a reset when any escape was open.
 */
export function truncateAnsi(text: string, width: number): string {
  if (width <= 0) return ''
  if (displayWidth(text) <= width) return text

  let out = ''
  let seen = 0
  let styled = false
  let index = 0

  /** Appends whole code points while they fit. Returns true when the budget ran out. */
  const take = (plain: string): boolean => {
    for (const char of plain) {
      const w = charWidth(char.codePointAt(0)!)
      if (seen + w > width) return true
      out += char
      seen += w
    }
    return false
  }

  for (const match of text.matchAll(ANSI)) {
    if (take(text.slice(index, match.index))) return `${out}${styled ? '\u001b[0m' : ''}`
    out += match[0]
    styled = true
    index = match.index + match[0].length
  }
  take(text.slice(index))
  return styled ? `${out}\u001b[0m` : out
}

/**
 * Reassembles chunks into lines and keeps the last `capacity` of them. A chunk boundary lands
 * mid-line constantly, so the tail is held back until its newline arrives.
 */
export class LogBuffer implements OutputSink {
  private readonly lines: LogLine[] = []
  private readonly partial = new Map<Channel, string>()
  /** Per channel: a multi-byte character can straddle a chunk, and a raw toString loses it. */
  private readonly decoders = new Map<Channel, StringDecoder>()
  private next = 0
  private dropped = 0

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** `OutputSink.write`. A sink installed over the pane feeds it directly. */
  write(channel: Channel, chunk: string | Uint8Array): void {
    this.push(channel, chunk)
  }

  /** `OutputSink.close`. A container that died mid-line still has a tail to keep. */
  close(): void {
    this.flush()
  }

  push(channel: Channel, chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : this.decoderFor(channel).write(Buffer.from(chunk))
    const joined = (this.partial.get(channel) ?? '') + text
    const parts = joined.split(/\r\n|\r|\n/)
    const rest = parts.pop() ?? ''
    this.partial.set(channel, rest.length > MAX_PARTIAL ? rest.slice(-MAX_PARTIAL) : rest)
    for (const part of parts) this.add(channel, part)
  }

  private decoderFor(channel: Channel): StringDecoder {
    let decoder = this.decoders.get(channel)
    if (decoder === undefined) {
      decoder = new StringDecoder('utf8')
      this.decoders.set(channel, decoder)
    }
    return decoder
  }

  /** Flush a tail with no trailing newline, which is what a container that dies mid-line leaves. */
  flush(): void {
    for (const [channel, decoder] of this.decoders) {
      const rest = decoder.end()
      if (rest.length > 0) this.partial.set(channel, (this.partial.get(channel) ?? '') + rest)
    }
    this.decoders.clear()
    for (const [channel, rest] of this.partial) {
      if (rest.length > 0) this.add(channel, rest)
      this.partial.set(channel, '')
    }
  }

  private add(channel: Channel, raw: string): void {
    const text = renderColorTags(raw.replace(/\r$/, ''))
    const level = LEVEL.exec(stripAnsi(text))?.[1]
    this.lines.push({ seq: this.next++, channel, text, ...(level === undefined ? {} : { level }) })
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity)
      this.dropped = this.next - this.capacity
    }
  }

  get size(): number {
    return this.lines.length
  }

  /** How many lines fell off the front, so the footer can say the count is not the whole run. */
  get lost(): number {
    return this.dropped
  }

  all(): readonly LogLine[] {
    return this.lines
  }

  /** Case-insensitive substring over the printable text, so a filter never matches an escape. */
  filter(needle: string): readonly LogLine[] {
    if (needle.length === 0) return this.lines
    const lower = needle.toLowerCase()
    return this.lines.filter((line) => stripAnsi(line.text).toLowerCase().includes(lower))
  }
}

export interface ViewOptions {
  rows: number
  width: number
  /** Lines from the bottom. 0 follows the tail, which is what a live run wants. */
  scrollback?: number
  filter?: string
  /** Highlight every match. Skipped when there is no filter. */
  highlight?: boolean
}

export interface View {
  lines: string[]
  /** Matches when filtering, total otherwise. The footer says which. */
  count: number
  /** True when the view sits at the tail, so the caller knows whether to keep following. */
  following: boolean
}

const HIGHLIGHT_ON = '\u001b[7m'
const HIGHLIGHT_OFF = '\u001b[27m'

/** Wraps every match in reverse video without disturbing the colours already in the line. */
export function highlightMatches(text: string, needle: string): string {
  if (needle.length === 0) return text
  const lower = needle.toLowerCase()
  let out = ''
  const spans = [...text.matchAll(ANSI)]
  let cursor = 0
  const segments: { plain: string; escape: string }[] = []
  for (const match of spans) {
    segments.push({ plain: text.slice(cursor, match.index), escape: match[0] })
    cursor = match.index + match[0].length
  }
  segments.push({ plain: text.slice(cursor), escape: '' })

  for (const { plain, escape } of segments) {
    let rest = plain
    let at = rest.toLowerCase().indexOf(lower)
    while (at !== -1) {
      out += rest.slice(0, at) + HIGHLIGHT_ON + rest.slice(at, at + needle.length) + HIGHLIGHT_OFF
      rest = rest.slice(at + needle.length)
      at = rest.toLowerCase().indexOf(lower)
    }
    out += rest + escape
  }
  return out
}

/** A row that leaves a style open bleeds into every row under it, and into the shell on exit. */
export function closeStyle(text: string): string {
  if (!text.includes('\u001b[')) return text
  return text.endsWith('\u001b[0m') ? text : `${text}\u001b[0m`
}

export function view(buffer: LogBuffer, opts: ViewOptions): View {
  const needle = opts.filter ?? ''
  const pool = buffer.filter(needle)
  const scrollback = Math.max(0, Math.min(opts.scrollback ?? 0, Math.max(0, pool.length - opts.rows)))
  const end = pool.length - scrollback
  const start = Math.max(0, end - opts.rows)

  const lines = pool.slice(start, end).map((line) => {
    const marked = opts.highlight === true && needle.length > 0 ? highlightMatches(line.text, needle) : line.text
    return closeStyle(truncateAnsi(marked, opts.width))
  })
  while (lines.length < opts.rows) lines.push('')

  return { lines, count: pool.length, following: scrollback === 0 }
}

/** A filled block bar. Width is columns, so a frame keeps its alignment. */
export function bar(fraction: number | undefined, width: number, colour: string): string {
  if (fraction === undefined) return `${DIM}${'\u2591'.repeat(width)}${OFF}`
  const on = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return `${colour}${'\u2588'.repeat(on)}${DIM}${'\u2591'.repeat(width - on)}${OFF}`
}

/** Pads to `width` printable columns, and cuts anything longer. */
export function padTo(text: string, width: number): string {
  const short = width - displayWidth(text)
  return short > 0 ? text + ' '.repeat(short) : truncateAnsi(text, width)
}
