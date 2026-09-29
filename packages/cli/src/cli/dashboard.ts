import { BLUE, BRIGHT, CYAN, DIM, GREEN, LogBuffer, OFF, ORANGE, RED, YELLOW, bar, displayWidth, padTo, view } from './logpane'

export interface Identity {
  game: string
  profile: string
  container: string
  mode: string
  /** `6 local / 1 workshop / 5 official / 1 core`, already counted by the caller. */
  mods: Record<string, number>
}

export interface Stats {
  cpuPct?: number
  memUsed?: number
  memLimit?: number
  gpuPct?: number
  vramUsedMb?: number
  vramTotalMb?: number
}

export interface Runtime {
  /** `running`, `booting`, or `exited 134`. */
  phase: string
  startedAt: number
  now?: number
}

export interface Filter {
  active: boolean
  text: string
}

export interface Frame {
  identity: Identity
  stats: Stats
  runtime: Runtime
  filter: Filter
  buffer: LogBuffer
  scrollback: number
  size: { rows: number; cols: number }
  /** Which pane `buffer` is. Defaults to the raw container output. */
  view?: 'raw' | 'records'
  /** True once structured records exist, so the footer can offer the toggle. */
  canToggle?: boolean
}

const HEADER_ROWS = 7
const FOOTER_ROWS = 2

/** Log rows left once the header and footer take theirs. */
export function paneRows(rows: number): number {
  return Math.max(1, rows - HEADER_ROWS - FOOTER_ROWS)
}

const GIB = 1024 ** 3

function gib(bytes: number | undefined): string {
  return bytes === undefined ? '—' : `${(bytes / GIB).toFixed(1)} GiB`
}

function pct(value: number | undefined): string {
  return value === undefined ? '  —' : `${Math.round(value).toString().padStart(3)}%`
}

export function elapsed(runtime: Runtime): string {
  const ms = Math.max(0, (runtime.now ?? Date.now()) - runtime.startedAt)
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

function rule(cols: number, label?: string): string {
  const text = label === undefined ? '' : `─ ${label} `
  const fill = Math.max(0, cols - 1 - displayWidth(text))
  return `${DIM}─${text}${'─'.repeat(fill)}${OFF}`
}

function phaseColour(phase: string): string {
  if (phase.startsWith('exited')) return RED
  if (phase === 'running') return GREEN
  return YELLOW
}

const MOD_ORDER = ['local', 'workshop', 'official', 'core']

function modLine(mods: Record<string, number>): string {
  const colours: Record<string, string> = {
    local: ORANGE, official: BLUE, workshop: CYAN, core: DIM,
  }
  const rank = (kind: string): number => {
    const at = MOD_ORDER.indexOf(kind)
    return at === -1 ? MOD_ORDER.length : at
  }
  const total = Object.values(mods).reduce((a, b) => a + b, 0)
  const parts = Object.entries(mods)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([kind, n]) => `${colours[kind] ?? ''}${n} ${kind}${OFF}`)
  const separator = `${DIM} / ${OFF}`
  return `${BRIGHT}${total} mods${OFF}  ${parts.join(separator)}`
}

export function render(frame: Frame): string[] {
  const { cols } = frame.size
  const { identity: id, stats, runtime } = frame

  const title = `${CYAN}gamecrate${OFF}  ${BRIGHT}${id.game} ${id.profile}${OFF}`
  const barWidth = Math.max(6, Math.min(28, Math.floor((cols - 52) / 2)))
  const vramUsed = stats.vramUsedMb === undefined ? '—' : `${(stats.vramUsedMb / 1024).toFixed(1)} GiB`
  const vramTotal = stats.vramTotalMb === undefined ? '—' : `${(stats.vramTotalMb / 1024).toFixed(1)} GiB`

  const lines: string[] = [
    padTo(`${title}${' '.repeat(2)}${DIM}${id.container}${OFF}`, cols),
    rule(cols),
    padTo(
      ` ${DIM}state${OFF} ${phaseColour(runtime.phase)}${padTo(runtime.phase, 12)}${OFF}` +
        `${DIM}up${OFF} ${BRIGHT}${elapsed(runtime)}${OFF}   ` +
        `${DIM}mode${OFF} ${BRIGHT}${id.mode}${OFF}`,
      cols,
    ),
    padTo(
      ` ${DIM}cpu ${OFF} ${bar(stats.cpuPct === undefined ? undefined : stats.cpuPct / 100, barWidth, GREEN)} ` +
        `${BRIGHT}${pct(stats.cpuPct)}${OFF}   ${DIM}mem${OFF} ` +
        `${BRIGHT}${gib(stats.memUsed)}${OFF} ${DIM}/ ${gib(stats.memLimit)}${OFF}`,
      cols,
    ),
    padTo(
      ` ${DIM}gpu ${OFF} ${bar(stats.gpuPct === undefined ? undefined : stats.gpuPct / 100, barWidth, BLUE)} ` +
        `${BRIGHT}${pct(stats.gpuPct)}${OFF}   ${DIM}vram${OFF} ` +
        `${BRIGHT}${vramUsed}${OFF}` +
        ` ${DIM}/ ${vramTotal}${OFF}`,
      cols,
    ),
    padTo(` ${DIM}mods${OFF} ${modLine(id.mods)}`, cols),
    rule(cols, frame.view === 'records' ? 'records' : 'log'),
  ]

  const rows = Math.max(1, frame.size.rows - lines.length - FOOTER_ROWS)
  const pane = view(frame.buffer, {
    rows,
    width: cols,
    scrollback: frame.scrollback,
    ...(frame.filter.text.length > 0 ? { filter: frame.filter.text, highlight: true } : {}),
  })
  lines.push(...pane.lines, ...footerRows(frame, cols, pane.count))

  return lines.slice(0, frame.size.rows)
}

function filterLabel(filter: Filter): string {
  const typed = `${DIM}/${OFF}${BRIGHT}${filter.text}${OFF}`
  if (filter.active) return `${typed}█`
  if (filter.text.length > 0) return typed
  return `${DIM}/ filter${OFF}`
}

function footerRows(frame: Frame, cols: number, count: number): string[] {
  const left = filterLabel(frame.filter)
  const unit = frame.view === 'records' ? 'records' : 'lines'
  const counted = frame.filter.text.length > 0 ? `${count} matches` : `${count} ${unit}`
  const lost = frame.buffer.lost > 0 ? `${DIM} (+${frame.buffer.lost} dropped)${OFF}` : ''
  const other = frame.view === 'records' ? 'raw' : 'records'
  const toggle = frame.canToggle === true ? `${BRIGHT}r${OFF}${DIM}${other}${OFF} ` : ''
  const quit = frame.runtime.phase.startsWith('exited')
    ? `${DIM}run ended, ${OFF}${BRIGHT}q${OFF}${DIM} to close${OFF}`
    : `${BRIGHT}q${OFF}${DIM}uit and stop${OFF}`
  const keys = frame.filter.active
    ? `${DIM}enter to keep, esc to clear${OFF}`
    : `${BRIGHT}/${OFF}${DIM}filter${OFF} ${BRIGHT}g${OFF}${DIM}/${OFF}${BRIGHT}G${OFF}${DIM}ends${OFF} ` + toggle + quit
  const right = `${DIM}${counted}${OFF}${lost}`
  const gap = Math.max(1, cols - 2 - displayWidth(left) - displayWidth(keys) - displayWidth(right) - 2)
  return [rule(cols), padTo(` ${left}${' '.repeat(gap)}${keys}  ${right}`, cols)]
}
