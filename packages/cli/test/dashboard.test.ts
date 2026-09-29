import { describe, expect, test } from 'bun:test'
import { elapsed, paneRows, render } from '../src/cli/dashboard'
import { bar, padTo } from '../src/cli/logpane'
import type { Frame } from '../src/cli/dashboard'
import { LogBuffer, displayWidth, stripAnsi } from '../src/cli/logpane'

function frameOf(over: Partial<Frame> = {}): Frame {
  const buffer = over.buffer ?? new LogBuffer()
  if (over.buffer === undefined) for (let i = 0; i < 200; i++) buffer.push('game', `line ${i}\n`)
  return {
    identity: {
      game: 'rimworld',
      profile: 'mpf17',
      container: 'gamecrate-rimworld-mpf17',
      mode: 'headed',
      mods: { local: 6, official: 5, workshop: 1, core: 1 },
    },
    stats: {
      cpuPct: 41.2,
      memUsed: 9.2 * 1024 ** 3,
      memLimit: 16 * 1024 ** 3,
      gpuPct: 62,
      vramUsedMb: 11571,
      vramTotalMb: 24564,
    },
    runtime: { phase: 'running', startedAt: 1_000_000, now: 1_000_000 + 847_000 },
    filter: { active: false, text: '' },
    buffer,
    scrollback: 0,
    size: { rows: 41, cols: 124 },
    ...over,
  }
}

describe('elapsed', () => {
  test('counts up in hours, minutes and seconds', () => {
    expect(elapsed({ phase: 'running', startedAt: 0, now: 847_000 })).toBe('00:14:07')
    expect(elapsed({ phase: 'running', startedAt: 0, now: 3_661_000 })).toBe('01:01:01')
  })

  test('a clock that went backwards reads zero, never a negative', () => {
    expect(elapsed({ phase: 'running', startedAt: 5_000, now: 0 })).toBe('00:00:00')
  })
})

describe('bar', () => {
  test('the width is columns, so the frame cannot shift', () => {
    for (const f of [0, 0.01, 0.5, 0.999, 1]) expect(displayWidth(bar(f, 20, ''))).toBe(20)
  })

  test('out of range clamps instead of overflowing', () => {
    expect(displayWidth(bar(4, 20, ''))).toBe(20)
    expect(displayWidth(bar(-3, 20, ''))).toBe(20)
  })

  test('an unknown value is all empty blocks, not a full bar', () => {
    expect(stripAnsi(bar(undefined, 5, ''))).toBe('░'.repeat(5))
  })
})

describe('padTo', () => {
  test('escapes are not counted as columns', () => {
    expect(displayWidth(padTo('\u001b[33mhi\u001b[0m', 10))).toBe(10)
  })

  test('something too long is cut, not wrapped', () => {
    expect(displayWidth(padTo('x'.repeat(50), 10))).toBe(10)
  })
})

describe('render', () => {
  test('the frame is exactly as tall as the terminal', () => {
    for (const rows of [10, 24, 41, 60]) {
      expect(render(frameOf({ size: { rows, cols: 124 } }))).toHaveLength(rows)
    }
  })

  test('no row is wider than the terminal, at any width', () => {
    for (const cols of [60, 80, 100, 124, 200]) {
      const out = render(frameOf({ size: { rows: 30, cols } }))
      for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(cols)
    }
  })

  test('a terminal too short to hold the furniture still returns that many rows', () => {
    expect(render(frameOf({ size: { rows: 4, cols: 80 } }))).toHaveLength(4)
  })

  test('the identity and the numbers are on screen', () => {
    const text = stripAnsi(render(frameOf()).join('\n'))
    expect(text).toContain('rimworld mpf17')
    expect(text).toContain('gamecrate-rimworld-mpf17')
    expect(text).toContain('00:14:07')
    expect(text).toContain('41%')
    expect(text).toContain('9.2 GiB')
    expect(text).toContain('13 mods')
    expect(text).toContain('6 local')
  })

  test('mod kinds lead with local, whatever order they arrived in', () => {
    const mods = { workshop: 1, core: 1, official: 5, local: 6 }
    const text = stripAnsi(render(frameOf({ identity: { ...frameOf().identity, mods } })).join('\n'))
    const line = text.split('\n').find((l) => l.includes('13 mods'))!
    expect(line.indexOf('6 local')).toBeLessThan(line.indexOf('1 workshop'))
    expect(line.indexOf('1 workshop')).toBeLessThan(line.indexOf('5 official'))
    expect(line.indexOf('5 official')).toBeLessThan(line.indexOf('1 core'))
  })

  test('an unknown mod kind still renders, sorted last', () => {
    const mods = { mystery: 2, local: 1 }
    const line = stripAnsi(render(frameOf({ identity: { ...frameOf().identity, mods } })).join('\n'))
    expect(line).toContain('3 mods')
    expect(line.indexOf('1 local')).toBeLessThan(line.indexOf('2 mystery'))
  })

  test('missing stats read as unknown rather than zero', () => {
    const text = stripAnsi(render(frameOf({ stats: {} })).join('\n'))
    expect(text).toContain('—')
    expect(text).not.toContain('0%')
  })

  test('the footer counts lines, and matches once a filter is set', () => {
    expect(stripAnsi(render(frameOf()).join('\n'))).toContain('200 lines')
    const filtered = render(frameOf({ filter: { active: false, text: 'line 1' } }))
    expect(stripAnsi(filtered.join('\n'))).toContain('111 matches')
  })

  test('a dropped-line count is admitted in the footer', () => {
    const buffer = new LogBuffer(5)
    for (let i = 0; i < 50; i++) buffer.push('game', `line ${i}\n`)
    expect(stripAnsi(render(frameOf({ buffer })).join('\n'))).toContain('+45 dropped')
  })

  test('an exited phase is stated, not hidden', () => {
    const text = stripAnsi(render(frameOf({ runtime: { phase: 'exited 134', startedAt: 0, now: 0 } })).join('\n'))
    expect(text).toContain('exited 134')
  })

  test('typing a filter swaps the keys for the editing hint', () => {
    const text = stripAnsi(render(frameOf({ filter: { active: true, text: 'Way' } })).join('\n'))
    expect(text).toContain('/Way')
    expect(text).toContain('enter to keep, esc to clear')
    expect(text).not.toContain('detach')
  })
})

describe('LogBuffer as a sink', () => {
  test('every channel lands in the buffer', () => {
    const buffer = new LogBuffer()
    buffer.write('game', 'out\n')
    buffer.write('gameError', 'err\n')
    buffer.write('status', 'tool\n')
    expect(buffer.all().map((l) => [l.channel, l.text])).toEqual([
      ['game', 'out'],
      ['gameError', 'err'],
      ['status', 'tool'],
    ])
  })

  test('close flushes a line that never got its newline', () => {
    const buffer = new LogBuffer()
    buffer.write('game', 'no newline')
    expect(buffer.size).toBe(0)
    buffer.close()
    expect(buffer.size).toBe(1)
  })
})

describe('paneRows', () => {
  test('the pane is the terminal minus the furniture, and never zero', () => {
    expect(paneRows(41)).toBe(32)
    expect(paneRows(24)).toBe(15)
    expect(paneRows(4)).toBe(1)
  })

  test('paneRows matches the rows render actually draws', () => {
    for (const rows of [12, 24, 41, 60]) {
      const out = render(frameOf({ size: { rows, cols: 100 } }))
      const body = out.slice(7, out.length - 2)
      expect(body).toHaveLength(paneRows(rows))
    }
  })
})
