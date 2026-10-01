import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { emit } from '../src/channels'
import { stripAnsi } from '../src/cli/logpane'
import { Screen } from '../src/cli/screen'
import { startSession } from '../src/cli/session'
import type { Identity } from '../src/cli/dashboard'
import type { LogRecord, RecordTailOptions } from '../src/cli/records'

const ESC = '\u001b'

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
  isTTY = true
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

const identity: Identity = {
  game: 'rimworld',
  profile: 'mpf17',
  container: 'gamecrate-rimworld-mpf17',
  mode: 'headed',
  mods: { local: 6, official: 5, workshop: 1, core: 1 },
}

function harness(over: { onStop?: () => void; colour?: boolean; recordDir?: string } = {}) {
  const out = new FakeOut()
  const input = new FakeIn()
  const screen = new Screen({
    out: out as unknown as NodeJS.WriteStream,
    input: input as unknown as NodeJS.ReadStream,
    intervalMs: 1_000_000,
    escapeMs: 5,
  })
  let feed: ((record: LogRecord) => void) | undefined
  const session = startSession({
    identity,
    container: 'nope',
    onStop: over.onStop ?? (() => {}),
    screen,
    probes: false,
    colour: over.colour ?? true,
    ...(over.recordDir === undefined
      ? {}
      : {
          recordDir: over.recordDir,
          tail: (opts: RecordTailOptions) => {
            feed = opts.onRecord
            return () => {
              feed = undefined
            }
          },
        }),
  })
  const type = (text: string) => input.emit('data', Buffer.from(text))
  const key = (name: string) => input.emit('keypress', undefined, { name })
  const frame = () => {
    out.written = []
    screen.paint(
      [],
    )
    out.written = []
    out.emit('resize')
    return stripAnsi(out.written.join(''))
  }
  const record = (fields: Partial<LogRecord> = {}) => {
    if (feed === undefined) throw new Error('no record tail was installed')
    feed({
      ts: '2026-09-28T19:04:31.217Z',
      level: 'INFO',
      channel: 'RimWorks.Core.Boot',
      msg: 'loaded 41 mods',
      ...fields,
    })
  }
  return { out, input, screen, session, type, key, frame, record }
}

describe('startSession', () => {
  test('container output reaches the pane through the channel sink', () => {
    const h = harness()
    try {
      emit('game', 'hello from the game\n')
      expect(h.frame()).toContain('hello from the game')
    } finally {
      h.session.close()
    }
  })

  test('booting becomes running on the first byte from the container', () => {
    const h = harness()
    try {
      expect(h.frame()).toContain('booting')
      emit('status', 'tool chatter is not the game\n')
      expect(h.frame()).toContain('booting')
      emit('game', 'the engine said something\n')
      expect(h.frame()).toContain('running')
    } finally {
      h.session.close()
    }
  })

  test('an exit code reaches the header', () => {
    const h = harness()
    try {
      h.session.setPhase('exited 134')
      expect(h.frame()).toContain('exited 134')
    } finally {
      h.session.close()
    }
  })

  test('q and ctrl-c both stop', () => {
    let stops = 0
    const h = harness({ onStop: () => (stops += 1) })
    try {
      h.type('q')
      h.type('\u0003')
      expect(stops).toBe(2)
    } finally {
      h.session.close()
    }
  })

  test('d is not a key, so it cannot claim a detach that never happened', () => {
    let stops = 0
    const h = harness({ onStop: () => (stops += 1) })
    try {
      h.type('d')
      expect(stops).toBe(0)
      expect(h.frame()).not.toContain('detach')
    } finally {
      h.session.close()
    }
  })

  test('slash opens the filter and typing narrows the pane', () => {
    const h = harness()
    try {
      emit('game', 'keep this one\n')
      emit('game', 'drop the other\n')
      h.type('/keep')
      const text = h.frame()
      expect(text).toContain('keep this one')
      expect(text).not.toContain('drop the other')
      expect(text).toContain('enter to keep, esc to clear')
    } finally {
      h.session.close()
    }
  })

  test('scrollback stops at the ends, so the keys never go dead', () => {
    const h = harness()
    try {
      for (let i = 0; i < 40; i++) emit('game', `line ${i}\n`)
      for (let i = 0; i < 100; i++) h.key('up')
      const top = /line (\d+)/.exec(h.frame())![1]
      h.key('down')
      h.key('down')
      h.key('down')
      expect(/line (\d+)/.exec(h.frame())![1]).not.toBe(top)

      for (let i = 0; i < 100; i++) h.key('down')
      const bottom = h.frame()
      h.key('down')
      expect(h.frame()).toBe(bottom)
    } finally {
      h.session.close()
    }
  })

  test('ctrl-c stops even with the filter open', () => {
    let stops = 0
    const h = harness({ onStop: () => (stops += 1) })
    try {
      h.type('/some text')
      h.type('\u0003')
      expect(stops).toBe(1)
    } finally {
      h.session.close()
    }
  })

  test('q inside the filter types a q instead of stopping', () => {
    let stops = 0
    const h = harness({ onStop: () => (stops += 1) })
    try {
      h.type('/q')
      expect(stops).toBe(0)
      expect(h.frame()).toContain('/q')
    } finally {
      h.session.close()
    }
  })

  test('escape clears the filter, enter keeps it', async () => {
    const h = harness()
    try {
      emit('game', 'alpha\n')
      emit('game', 'beta\n')
      h.type('/alpha')
      h.type('\r')
      expect(h.frame()).not.toContain('beta')
      expect(h.frame()).toContain('/alpha')

      h.type('/')
      h.type(ESC)
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(h.frame()).toContain('beta')
    } finally {
      h.session.close()
    }
  })

  test('backspace deletes one character of the filter', () => {
    const h = harness()
    try {
      emit('game', 'alpha\n')
      emit('game', 'alps\n')
      h.type('/alpha')
      expect(h.frame()).not.toContain('alps')
      h.type('\u007f\u007f')
      expect(h.frame()).toContain('alps')
    } finally {
      h.session.close()
    }
  })

  test('colour off strips the escapes the game wrote too', () => {
    const h = harness({ colour: false })
    try {
      emit('game', `${ESC}[31mred from the game${ESC}[0m\n`)
      const text = h.frame()
      expect(text).toContain('red from the game')
      expect(text).not.toContain(`${ESC}[31m`)
    } finally {
      h.session.close()
    }
  })

  test('a crash keeps the pane up until the user leaves', async () => {
    const h = harness()
    try {
      h.session.setPhase('exited 134')
      let left = false
      void h.session.waitForQuit().then(() => (left = true))
      await Promise.resolve()
      expect(left).toBe(false)

      h.type('q')
      await h.session.waitForQuit()
      expect(left).toBe(true)
    } finally {
      h.session.close()
    }
  })

  test('quitting after a crash does not try to stop a dead container', () => {
    let stops = 0
    const h = harness({ onStop: () => (stops += 1) })
    try {
      h.session.setPhase('exited 1')
      h.type('q')
      expect(stops).toBe(0)
      expect(h.session.quitRequested).toBe(true)
    } finally {
      h.session.close()
    }
  })

  test('a user stop is remembered, so the caller can skip the wait', () => {
    const h = harness()
    try {
      expect(h.session.quitRequested).toBe(false)
      h.type('q')
      expect(h.session.quitRequested).toBe(true)
    } finally {
      h.session.close()
    }
  })

  test('the footer says how to leave once the run has ended', () => {
    const h = harness()
    try {
      expect(h.frame()).toContain('quit and stop')
      h.session.setPhase('exited 134')
      const text = h.frame()
      expect(text).toContain('run ended')
      expect(text).not.toContain('quit and stop')
    } finally {
      h.session.close()
    }
  })

  test('waitForQuit does not wait when nothing can send a key', async () => {
    const out = new FakeOut()
    const input = new FakeIn()
    input.isTTY = false
    const session = startSession({
      identity,
      container: 'nope',
      onStop: () => {},
      probes: false,
      colour: false,
      screen: new Screen({
        out: out as unknown as NodeJS.WriteStream,
        input: input as unknown as NodeJS.ReadStream,
        intervalMs: 1_000_000,
      }),
    })
    try {
      session.setPhase('exited 1')
      await expect(session.waitForQuit()).resolves.toBeUndefined()
    } finally {
      session.close()
    }
  })

  test('waitForQuit resolves at once when the user already left', async () => {
    const h = harness()
    try {
      h.type('q')
      await expect(h.session.waitForQuit()).resolves.toBeUndefined()
    } finally {
      h.session.close()
    }
  })

  test('a stats socket that is not up yet is retried until it answers', async () => {
    const out = new FakeOut()
    const input = new FakeIn()
    let attempts = 0
    const stats = ((_id: string, onEvent: (e: { kind: string; cpuPct?: number; memUsed?: number; memLimit?: number }) => void) => {
      attempts += 1
      if (attempts === 1) queueMicrotask(() => onEvent({ kind: 'error' }))
      else queueMicrotask(() => onEvent({ kind: 'sample', cpuPct: 41, memUsed: 1, memLimit: 2 }))
      return () => {}
    }) as never

    const session = startSession({
      identity,
      container: 'c',
      onStop: () => {},
      colour: false,
      stats,
      retryMs: 5,
      screen: new Screen({
        out: out as unknown as NodeJS.WriteStream,
        input: input as unknown as NodeJS.ReadStream,
        intervalMs: 1_000_000,
      }),
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(attempts).toBeGreaterThanOrEqual(2)
      out.written = []
      out.emit('resize')
      expect(stripAnsi(out.written.join(''))).toContain('41%')
    } finally {
      session.close()
    }
  })

  test('a retry chain stops when the session closes', async () => {
    const out = new FakeOut()
    let attempts = 0
    const stats = ((_id: string, onEvent: (e: { kind: string }) => void) => {
      attempts += 1
      queueMicrotask(() => onEvent({ kind: 'error' }))
      return () => {}
    }) as never
    const session = startSession({
      identity,
      container: 'c',
      onStop: () => {},
      colour: false,
      stats,
      retryMs: 5,
      screen: new Screen({
        out: out as unknown as NodeJS.WriteStream,
        input: new FakeIn() as unknown as NodeJS.ReadStream,
        intervalMs: 1_000_000,
      }),
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    session.close()
    const seen = attempts
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(attempts).toBe(seen)
  })

  test('close restores the terminal and stops feeding the pane', () => {
    const h = harness()
    h.session.close()
    const written = h.out.written.join('')
    expect(written).toContain(`${ESC}[?1049l`)
    expect(written).toContain(`${ESC}[?25h`)

    expect(() => emit('status', 'after close\n')).not.toThrow()
  })

  test('close is safe twice', () => {
    const h = harness()
    h.session.close()
    const count = h.out.written.length
    h.session.close()
    expect(h.out.written).toHaveLength(count)
  })
})

describe('the record pane', () => {
  test('a run with no record directory never mentions records, and r is not a key', () => {
    const h = harness()
    try {
      emit('game', 'raw line here\n')
      h.type('r')
      const text = h.frame()
      expect(text).toContain('raw line here')
      expect(text).toContain('1 lines')
      expect(text).not.toContain('records')
    } finally {
      h.session.close()
    }
  })

  test('a directory with nothing in it yet stays on raw lines and offers no toggle', () => {
    const h = harness({ recordDir: '/tmp/never-written' })
    try {
      emit('game', 'raw line here\n')
      h.type('r')
      const text = h.frame()
      expect(text).toContain('raw line here')
      expect(text).toContain('1 lines')
      expect(text).not.toContain('records')
    } finally {
      h.session.close()
    }
  })

  test('once a record arrives the toggle is offered, and r switches the pane', () => {
    const h = harness({ recordDir: '/tmp/records' })
    try {
      emit('game', 'raw line here\n')
      h.record()
      expect(h.frame()).toContain('rrecords')

      h.type('r')
      const shown = h.frame()
      expect(shown).toContain('loaded 41 mods')
      expect(shown).toContain('INFO')
      expect(shown).toContain('RimWorks.Core.Boot')
      expect(shown).not.toContain('raw line here')
      expect(shown).toContain('1 records')
      expect(shown).toContain('rraw')
    } finally {
      h.session.close()
    }
  })

  test('r again puts the raw lines back', () => {
    const h = harness({ recordDir: '/tmp/records' })
    try {
      emit('game', 'raw line here\n')
      h.record()
      h.type('r')
      h.type('r')
      const text = h.frame()
      expect(text).toContain('raw line here')
      expect(text).not.toContain('loaded 41 mods')
      expect(text).toContain('1 lines')
    } finally {
      h.session.close()
    }
  })

  test('an exception is one row in the pane, not its whole stack', () => {
    const h = harness({ recordDir: '/tmp/records' })
    try {
      h.record({
        level: 'ERROR',
        channel: 'Verse.Log',
        msg: 'def lookup failed',
        exc: {
          type: 'System.InvalidOperationException',
          message: 'no def named Steel',
          stack: '  at A.b()\n  at C.d()\n  at E.f()',
        },
      })
      h.type('r')
      const text = h.frame()
      expect(text).toContain('System.InvalidOperationException: no def named Steel')
      expect(text).not.toContain('at A.b()')
      expect(text).toContain('1 records')
    } finally {
      h.session.close()
    }
  })

  test('the filter narrows the records the same way it narrows raw lines', () => {
    const h = harness({ recordDir: '/tmp/records' })
    try {
      h.record({ msg: 'keep this one' })
      h.record({ msg: 'drop that one' })
      h.type('r')
      h.type('/keep')
      const text = h.frame()
      expect(text).toContain('keep this one')
      expect(text).not.toContain('drop that one')
      expect(text).toContain('1 matches')
    } finally {
      h.session.close()
    }
  })

  test('while the filter is open r is text, not a view switch', () => {
    const h = harness({ recordDir: '/tmp/records' })
    try {
      emit('game', 'raw line here\n')
      h.record()
      h.type('/r')
      const text = h.frame()
      expect(text).toContain('/r')
      expect(text).not.toContain('loaded 41 mods')
    } finally {
      h.session.close()
    }
  })

  test('closing the session stops the record tail', () => {
    const h = harness({ recordDir: '/tmp/records' })
    h.record()
    h.session.close()
    expect(() => h.record()).toThrow('no record tail was installed')
  })
})
