import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { emit, useBaseSink } from '../src/channels'
import { displayWidth, stripAnsi } from '../src/cli/logpane'
import { Screen } from '../src/cli/screen'
import { readSteamProgress, renderBoard, startBoard } from '../src/cli/taskboard'
import type { Task } from '../src/cli/taskboard'
  const ESC = '\u001b'

const tasks = (): Task[] => [
  { id: 'public/linux', label: 'linux', note: 'xvfb', state: 'done', detail: 'buildid-changed', fraction: 1, amount: '3.7 GiB' },
  { id: 'public/windows', label: 'windows', note: 'proton', state: 'running', detail: 'downloading', fraction: 0.45, amount: '1.8 GiB' },
  { id: 'public/linux-ref', label: 'linux-ref', note: 'none', state: 'skipped', detail: 'reference-only, use --push' },
]

const frame = (over: Partial<Parameters<typeof renderBoard>[0]> = {}) =>
  renderBoard({ title: 'rimworld', subtitle: 'public', tasks: tasks(), live: '', elapsed: '01:14', cols: 110, rows: 24, ...over })

describe('readSteamProgress', () => {
  test('reads the line steamcmd actually prints', () => {
    expect(readSteamProgress('Update state (0x61) downloading, progress: 14.02 (4026377 / 28725720)')).toEqual({
      fraction: 0.1402,
      amount: '4 MiB',
    })
  })

  test('uses the percentage steamcmd gives, not a byte ratio', () => {
    const out = readSteamProgress('progress: 90.00 (1 / 100)')
    expect(out?.fraction).toBe(0.9)
  })

  test('a state with nothing to transfer is not progress', () => {
    expect(readSteamProgress('Update state (0x0) unknown, progress: 0.00 (0 / 0)')).toBeUndefined()
  })

  test('a line that is not progress is ignored', () => {
    for (const line of ['Success! App 294100 fully installed.', '', 'progress: nonsense']) {
      expect(readSteamProgress(line)).toBeUndefined()
    }
  })

  test('escapes in the line do not hide the numbers', () => {
    expect(readSteamProgress('\u001b[33mprogress: 50.00 (1 / 2)\u001b[0m')?.fraction).toBe(0.5)
  })

  test('a percentage over one hundred is clamped', () => {
    expect(readSteamProgress('progress: 110.0 (110 / 100)')?.fraction).toBe(1)
  })

  test('bytes are shown in units a person reads', () => {
    expect(readSteamProgress('progress: 1.0 (3947888640 / 4000000000)')?.amount).toBe('3.7 GiB')
  })
})

describe('renderBoard', () => {
  test('one row per task, plus a header, two rules and nothing else', () => {
    expect(frame({ live: '' })).toHaveLength(2 + 3 + 1)
  })

  test('a narrow row keeps its content, not just its bar', () => {
    const one: Task[] = [
      { id: 'a', label: 'windows', note: 'proton', state: 'running', detail: 'downloading', fraction: 0.45, amount: '1.8 GiB' },
    ]
    const row = renderBoard({ title: 't', tasks: one, elapsed: '00:01', cols: 60, rows: 10 })
      .find((l) => stripAnsi(l).includes('windows'))!
    expect(stripAnsi(row)).toContain('1.8 GiB')
    expect(stripAnsi(row)).toContain('downloading')
    expect(displayWidth(row)).toBeLessThanOrEqual(60)
  })

  test('no row is wider than the terminal, at any width', () => {
    for (const cols of [40, 60, 80, 110, 200]) {
      for (const line of frame({ cols })) expect(displayWidth(line)).toBeLessThanOrEqual(cols)
    }
  })

  test('every column the caller gave is on screen', () => {
    const text = stripAnsi(frame().join('\n'))
    expect(text).toContain('rimworld')
    expect(text).toContain('linux-ref')
    expect(text).toContain('proton')
    expect(text).toContain('1.8 GiB')
    expect(text).toContain('reference-only, use --push')
    expect(text).toContain('01:14')
  })

  test('each state draws its own mark', () => {
    const text = stripAnsi(frame().join('\n'))
    expect(text).toContain('✔')
    expect(text).toContain('◐')
    expect(text).toContain('↓')
  })

  test('labels line up even when their lengths differ', () => {
    const rows = stripAnsi(frame().join('\n')).split('\n').filter((r) => /linux|windows/.test(r))
    const noteAt = rows.map((r) => r.indexOf('xvfb') + r.indexOf('proton') + r.indexOf('none'))
    expect(new Set(rows.map((r) => r.search(/xvfb|proton|none/))).size).toBe(1)
    expect(noteAt).toHaveLength(3)
  })

  test('a matrix taller than the terminal keeps the live line and says what it hid', () => {
    const many: Task[] = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, label: `cell${i}`, state: 'pending' }))
    const out = renderBoard({ title: 't', tasks: many, live: 'downloading', elapsed: '00:10', cols: 80, rows: 24 })
    expect(out.length).toBeLessThanOrEqual(24)
    const text = stripAnsi(out.join('\n'))
    expect(text).toContain('downloading')
    expect(text).toContain('and 11 more')
  })

  test('a matrix that fits hides nothing', () => {
    const few: Task[] = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, label: `cell${i}`, state: 'pending' }))
    const text = stripAnsi(renderBoard({ title: 't', tasks: few, live: 'x', elapsed: '00:00', cols: 80, rows: 24 }).join('\n'))
    expect(text).not.toContain('more')
  })

  test('the live line appears only when there is one', () => {
    expect(frame({ live: 'Update state (0x61)' }).some((l) => l.includes('Update state'))).toBe(true)
    expect(frame({ live: '' })).toHaveLength(6)
  })

  test('a task with no size draws an empty track, not a full bar', () => {
    const only: Task[] = [{ id: 'a', label: 'a', state: 'pending' }]
    expect(stripAnsi(renderBoard({ title: 't', tasks: only, elapsed: '00:00', cols: 60, rows: 10 }).join(''))).toContain('░')
  })
})

class FakeOut extends EventEmitter {
  written: string[] = []
  rows = 24
  columns = 100
  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }
}

class FakeIn extends EventEmitter {
  isTTY = false
  setRawMode(): this {
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
}

function board() {
  const out = new FakeOut()
  const screen = new Screen({
    out: out as unknown as NodeJS.WriteStream,
    input: new FakeIn() as unknown as NodeJS.ReadStream,
    intervalMs: 1_000_000,
  })
  const b = startBoard({
    title: 'rimworld',
    tasks: [
      { id: 'public/linux', label: 'linux', note: 'xvfb' },
      { id: 'public/windows', label: 'windows', note: 'proton' },
    ],
    screen,
    now: () => 0,
  })
  const text = () => {
    out.written = []
    out.emit('resize')
    return stripAnsi(out.written.join(''))
  }
  return { board: b, text }
}

describe('startBoard', () => {
  test('every task starts pending and is drawn before any work', () => {
    const h = board()
    try {
      const text = h.text()
      expect(text).toContain('linux')
      expect(text).toContain('windows')
      expect(h.board.tasks.every((t) => t.state === 'pending')).toBe(true)
    } finally {
      h.board.close()
    }
  })

  test('an update reaches the row it names, and an unknown id is ignored', () => {
    const h = board()
    try {
      h.board.update('public/linux', { state: 'running', detail: 'downloading' })
      h.board.update('nope/nope', { state: 'failed' })
      expect(h.board.tasks[0]!.state).toBe('running')
      expect(h.text()).toContain('downloading')
    } finally {
      h.board.close()
    }
  })

  test('a done row shows a full bar and a skipped row shows none', () => {
    const h = board()
    try {
      h.board.update('public/linux', { state: 'done' })
      h.board.update('public/windows', { state: 'skipped' })
      expect(h.board.tasks[0]!.fraction).toBe(1)
      expect(h.board.tasks[1]!.fraction).toBeUndefined()
    } finally {
      h.board.close()
    }
  })

  test('child output becomes the live line instead of scrolling the board', () => {
    const h = board()
    try {
      emit('status', 'Update state (0x61) downloading, progress: 45.77 (1893 / 4137)\n')
      expect(h.text()).toContain('Update state')
    } finally {
      h.board.close()
    }
  })

  test('a captured steamcmd line moves the bar end to end', () => {
    const h = board()
    try {
      h.board.update('public/linux', { state: 'running' })
      emit('status', 'Update state (0x61) downloading, progress: 14.02 (4026377 / 28725720)\n')
      expect(h.board.tasks[0]!.fraction).toBeCloseTo(0.1402, 4)
      expect(h.board.tasks[0]!.amount).toBe('4 MiB')
      expect(h.text()).toContain('4 MiB')
    } finally {
      h.board.close()
    }
  })

  test('a progress line moves the running row, and only the running row', () => {
    const h = board()
    try {
      h.board.update('public/windows', { state: 'running' })
      emit('status', 'progress: 50.00 (2000 / 4000)\n')
      expect(h.board.tasks[1]!.fraction).toBe(0.5)
      expect(h.board.tasks[1]!.amount).toBe('0 MiB')
      expect(h.board.tasks[0]!.fraction).toBeUndefined()
    } finally {
      h.board.close()
    }
  })

  test('a line split across two writes is not read as two lines', () => {
    const h = board()
    try {
      h.board.update('public/linux', { state: 'running' })
      emit('status', 'progress: 25.00 (100')
      expect(h.board.tasks[0]!.fraction).toBeUndefined()
      emit('status', ' / 400)\n')
      expect(h.board.tasks[0]!.fraction).toBe(0.25)
    } finally {
      h.board.close()
    }
  })

  test('ctrl-c gives the terminal back and raises the signal', () => {
    const out = new FakeOut()
    const input = new FakeIn()
    input.isTTY = true
    const screen = new Screen({
      out: out as unknown as NodeJS.WriteStream,
      input: input as unknown as NodeJS.ReadStream,
      intervalMs: 1_000_000,
    })
    const raised: string[] = []
    const realKill = process.kill.bind(process)
    process.kill = ((pid: number, signal?: string) => {
      raised.push(String(signal))
      return true
    }) as typeof process.kill

    const b = startBoard({ title: 't', tasks: [{ id: 'a', label: 'a' }], screen, now: () => 0 })
    try {
      out.written = []
      input.emit('keypress', '\u0003', { name: 'c', ctrl: true })
      expect(raised).toEqual(['SIGINT'])
      expect(out.written.join('')).toContain(`${ESC}[?1049l`)
    } finally {
      process.kill = realKill
      b.close()
    }
  })

  test('a screen that fails to open gives the status channel back', () => {
    class Broken extends EventEmitter {
      rows = 24
      columns = 80
      write(): boolean {
        throw new Error('EPIPE')
      }
    }
    const seen: string[] = []
    const probe = useBaseSink({ write: (_c, chunk) => seen.push(String(chunk)), close() {} })
    try {
      expect(() =>
        startBoard({
          title: 't',
          tasks: [{ id: 'a', label: 'a' }],
          screen: new Screen({
            out: new Broken() as unknown as NodeJS.WriteStream,
            input: new FakeIn() as unknown as NodeJS.ReadStream,
            intervalMs: 1_000_000,
          }),
        }),
      ).toThrow('EPIPE')
      emit('status', 'still reaches someone\n')
    } finally {
      probe.close()
    }
    expect(seen).toEqual(['still reaches someone\n'])
  })

  test('an update after close does not touch the final frame', () => {
    const h = board()
    h.board.update('public/linux', { state: 'running' })
    h.board.close()
    h.board.update('public/linux', { state: 'failed', detail: 'too late' })
    expect(h.board.tasks[0]!.state).toBe('running')
  })

  test('close gives the status channel back', () => {
    const h = board()
    h.board.close()

    const seen: string[] = []
    const probe = useBaseSink({ write: (_c, chunk) => seen.push(String(chunk)), close() {} })
    emit('status', 'after close\n')
    probe.close()
    expect(seen).toEqual(['after close\n'])
  })

  test('close is safe twice', () => {
    const h = board()
    h.board.close()
    expect(() => h.board.close()).not.toThrow()
  })
})
