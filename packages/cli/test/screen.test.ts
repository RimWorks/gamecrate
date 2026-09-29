import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Screen, toKey } from '../src/cli/screen'
import type { Key } from '../src/cli/screen'

const ESC = '\u001b'

class FakeOut extends EventEmitter {
  written: string[] = []
  rows = 24
  columns = 80
  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }
  get all(): string {
    return this.written.join('')
  }
}

class FakeIn extends EventEmitter {
  isTTY = true
  raw: boolean | undefined
  resumed = false
  paused = false
  setRawMode(on: boolean): this {
    this.raw = on
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.paused = true
    return this
  }
}

const screenFor = (out: FakeOut, input: FakeIn) =>
  new Screen({
    out: out as unknown as NodeJS.WriteStream,
    input: input as unknown as NodeJS.ReadStream,
    intervalMs: 1_000_000,
  })

describe('toKey', () => {
  test('a chord is never mistaken for the bare character', () => {
    expect(toKey('q', { name: 'q', meta: true })).toBeUndefined()
    expect(toKey('d', { name: 'd', meta: true })).toBeUndefined()
    expect(toKey('c', { name: 'c', ctrl: true })).toEqual({ name: 'ctrlC' })
    expect(toKey('a', { name: 'a', ctrl: true })).toBeUndefined()
  })

  test('an editing key is not an escape', () => {
    for (const name of ['delete', 'insert', 'left', 'right', 'f1', 'tab']) {
      expect(toKey(undefined, { name })).toBeUndefined()
    }
  })

  test('the keys the pane acts on are named', () => {
    expect(toKey(undefined, { name: 'up' })).toEqual({ name: 'up' })
    expect(toKey(undefined, { name: 'down' })).toEqual({ name: 'down' })
    expect(toKey(undefined, { name: 'pageup' })).toEqual({ name: 'pageUp' })
    expect(toKey(undefined, { name: 'pagedown' })).toEqual({ name: 'pageDown' })
    expect(toKey(undefined, { name: 'home' })).toEqual({ name: 'home' })
    expect(toKey(undefined, { name: 'end' })).toEqual({ name: 'end' })
    expect(toKey('\r', { name: 'return' })).toEqual({ name: 'enter' })
    expect(toKey(undefined, { name: 'backspace' })).toEqual({ name: 'backspace' })
    expect(toKey(undefined, { name: 'escape' })).toEqual({ name: 'escape' })
  })

  test('a printable character comes through, a control byte does not', () => {
    expect(toKey('a', { name: 'a' })).toEqual({ name: 'char', value: 'a' })
    expect(toKey('/', {})).toEqual({ name: 'char', value: '/' })
    expect(toKey('\u0001', {})).toBeUndefined()
    expect(toKey('\u007f', { name: 'backspace' })).toEqual({ name: 'backspace' })
  })
})

describe('Screen', () => {
  test('start opens the alt buffer and hides the cursor, stop undoes both', () => {
    const out = new FakeOut()
    const input = new FakeIn()
    const screen = screenFor(out, input)

    screen.start(() => ['hello'], () => {})
    expect(out.all).toContain(`${ESC}[?1049h`)
    expect(out.all).toContain(`${ESC}[?25l`)

    out.written = []
    screen.stop()
    expect(out.all).toContain(`${ESC}[?25h`)
    expect(out.all).toContain(`${ESC}[?1049l`)
  })

  test('raw mode is turned on at start and off at stop', () => {
    const out = new FakeOut()
    const input = new FakeIn()
    const screen = screenFor(out, input)
    screen.start(() => [''], () => {})
    expect(input.raw).toBe(true)
    expect(input.resumed).toBe(true)
    screen.stop()
    expect(input.raw).toBe(false)
    expect(input.paused).toBe(true)
  })

  test('stop resets the style before leaving the alt buffer', () => {
    const out = new FakeOut()
    const screen = screenFor(out, new FakeIn())
    screen.start(() => [`${ESC}[31mred and still open`], () => {})
    out.written = []
    screen.stop()
    const written = out.written.join('')
    expect(written.indexOf(`${ESC}[0m`)).toBeLessThan(written.indexOf(`${ESC}[?1049l`))
  })

  test('a render that throws during start still restores the terminal', () => {
    const out = new FakeOut()
    const input = new FakeIn()
    const screen = screenFor(out, input)
    expect(() =>
      screen.start(() => {
        throw new Error('render exploded')
      }, () => {}),
    ).toThrow('render exploded')
    const written = out.written.join('')
    expect(written).toContain(`${ESC}[?1049l`)
    expect(written).toContain(`${ESC}[?25h`)
    expect(input.raw).toBe(false)
  })

  test('stop is safe to call twice', () => {
    const out = new FakeOut()
    const screen = screenFor(out, new FakeIn())
    screen.start(() => [''], () => {})
    screen.stop()
    const after = out.written.length
    screen.stop()
    expect(out.written).toHaveLength(after)
  })

  test('keys reach the handler', () => {
    const out = new FakeOut()
    const input = new FakeIn()
    const screen = screenFor(out, input)
    const seen: Key[] = []
    screen.start(() => [''], (k) => seen.push(k))
    input.emit('data', Buffer.from(`q${ESC}[A`))
    screen.stop()
    expect(seen).toEqual([{ name: 'char', value: 'q' }, { name: 'up' }])
  })

  test('the handler stops receiving after stop', () => {
    const out = new FakeOut()
    const input = new FakeIn()
    const screen = screenFor(out, input)
    const seen: Key[] = []
    screen.start(() => [''], (k) => seen.push(k))
    screen.stop()
    input.emit('data', Buffer.from('x'))
    expect(seen).toEqual([])
  })

  test('an unchanged frame writes nothing', () => {
    const out = new FakeOut()
    const screen = screenFor(out, new FakeIn())
    screen.paint(['a', 'b'])
    out.written = []
    screen.paint(['a', 'b'])
    expect(out.written).toEqual([])
  })

  test('only the changed row is rewritten', () => {
    const out = new FakeOut()
    const screen = screenFor(out, new FakeIn())
    screen.paint(['a', 'b', 'c'])
    out.written = []
    screen.paint(['a', 'CHANGED', 'c'])
    expect(out.all).toContain(`${ESC}[2;1HCHANGED`)
    expect(out.all).not.toContain('\u001b[1;1H')
    expect(out.all).not.toContain('\u001b[3;1H')
  })

  test('a shorter frame clears the rows it gave up', () => {
    const out = new FakeOut()
    const screen = screenFor(out, new FakeIn())
    screen.paint(['a', 'b', 'c'])
    out.written = []
    screen.paint(['a'])
    expect(out.all).toContain(`${ESC}[2;1H${ESC}[J`)
  })

  test('a frame taller than the terminal is cut, never wrapped', () => {
    const out = new FakeOut()
    out.rows = 3
    const screen = screenFor(out, new FakeIn())
    screen.paint(['1', '2', '3', '4', '5'])
    expect(out.all).not.toContain('4')
    expect(out.all).toContain(`${ESC}[3;1H3`)
  })

  test('a resize forces a full repaint instead of a diff against the old width', () => {
    const out = new FakeOut()
    const screen = screenFor(out, new FakeIn())
    screen.start(() => ['a', 'b'], () => {})
    out.written = []
    out.columns = 40
    out.emit('resize')
    expect(out.all).toContain(`${ESC}[1;1Ha`)
    expect(out.all).toContain(`${ESC}[2;1Hb`)
    screen.stop()
  })

  test('a terminal reporting zero falls back instead of painting nothing', () => {
    const out = new FakeOut()
    out.rows = 0
    out.columns = 0
    const screen = screenFor(out, new FakeIn())
    expect(screen.size).toEqual({ rows: 24, cols: 80 })
    screen.start(() => ['content'], () => {})
    expect(out.written.join('')).toContain('content')
    screen.stop()
  })

  test('size falls back to 80x24 when the terminal will not say', () => {
    const out = new FakeOut()
    out.rows = undefined as unknown as number
    out.columns = undefined as unknown as number
    expect(screenFor(out, new FakeIn()).size).toEqual({ rows: 24, cols: 80 })
  })

  test('a non-tty input is never put in raw mode', () => {
    const out = new FakeOut()
    const input = new FakeIn()
    input.isTTY = false
    const screen = screenFor(out, input)
    screen.start(() => [''], () => {})
    expect(input.raw).toBeUndefined()
    screen.stop()
  })
})
