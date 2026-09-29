import { describe, expect, test } from 'bun:test'
import {
  LogBuffer,
  displayWidth,
  highlightMatches,
  renderColorTags,
  stripAnsi,
  truncateAnsi,
  view,
} from '../src/cli/logpane'

const ESC = '\u001b'

describe('renderColorTags', () => {
  test('a six-digit tag becomes truecolor and the close restores the default', () => {
    expect(renderColorTags('<color=#A5C2A5>hi</color> there')).toBe(
      `${ESC}[38;2;165;194;165mhi${ESC}[39m there`,
    )
  })

  test('a three-digit tag doubles each nibble, the way unity reads it', () => {
    expect(renderColorTags('<color=#f0a>x</color>')).toBe(`${ESC}[38;2;255;0;170mx${ESC}[39m`)
  })

  test('a nested close restores the enclosing colour', () => {
    const out = renderColorTags('<color=#ff0000>a<color=#00ff00>b</color>c</color>')
    expect(out).toBe(
      `${ESC}[38;2;255;0;0ma${ESC}[38;2;0;255;0mb${ESC}[38;2;255;0;0mc${ESC}[39m`,
    )
  })

  test('a tag naming a colour we cannot map is dropped, keeping its text', () => {
    expect(renderColorTags('<color=nonsense>x</color>')).toBe('x')
  })

  test('a line with no tags is returned untouched', () => {
    const line = `${ESC}[33mWARN${ESC}[0m something`
    expect(renderColorTags(line)).toBe(line)
  })
})

describe('width and truncation', () => {
  test('escapes take no columns', () => {
    expect(displayWidth(`${ESC}[33mWARN${ESC}[0m`)).toBe(4)
    expect(stripAnsi(`${ESC}[33mWARN${ESC}[0m`)).toBe('WARN')
  })

  test('a short line is not touched', () => {
    const line = `${ESC}[33mWARN${ESC}[0m`
    expect(truncateAnsi(line, 40)).toBe(line)
  })

  test('a cut keeps the colour that was already open and closes it', () => {
    const out = truncateAnsi(`${ESC}[33mabcdefgh`, 3)
    expect(out).toBe(`${ESC}[33mabc${ESC}[0m`)
    expect(displayWidth(out)).toBe(3)
  })

  test('a cut never lands inside an escape', () => {
    const out = truncateAnsi(`ab${ESC}[38;2;1;2;3mcdef`, 3)
    expect(stripAnsi(out)).toBe('abc')
    expect(stripAnsi(out)).not.toContain(ESC)
    expect(out).toContain(`${ESC}[38;2;1;2;3m`)
    expect(out.endsWith(`${ESC}[0m`)).toBe(true)
  })

  test('zero width is empty', () => {
    expect(truncateAnsi(`${ESC}[33mabc`, 0)).toBe('')
  })
})

describe('utf-8 and width', () => {
  test('a character split across two chunks survives', () => {
    const raw = Buffer.from('mod \u00dcber\n', 'utf8')
    for (let cut = 1; cut < raw.length; cut++) {
      const buffer = new LogBuffer()
      buffer.push('game', raw.subarray(0, cut))
      buffer.push('game', raw.subarray(cut))
      expect(buffer.all()[0]?.text).toBe('mod \u00dcber')
    }
  })

  test('emoji that terminals draw wide are counted wide, and a flag stays two', () => {
    expect(displayWidth('\u{1F680}')).toBe(2)
    expect(displayWidth('\u{1F697}')).toBe(2)
    expect(displayWidth('\u{1FA9B}')).toBe(2)
    expect(displayWidth('\u{1F1FA}\u{1F1F8}')).toBe(2)
  })

  test('a wide character counts two columns', () => {
    expect(displayWidth('\u65e5\u672c\u8a9e')).toBe(6)
    expect(displayWidth('ab')).toBe(2)
  })

  test('an astral character is never cut in half', () => {
    expect(truncateAnsi('a\u{1F600}b', 2)).toBe('a')
    expect(truncateAnsi('a\u{1F600}b', 3)).toBe('a\u{1F600}')
    expect(truncateAnsi('\u{1F600}', 1)).toBe('')
  })

  test('a wide line is cut to the column count, not the character count', () => {
    expect(displayWidth(truncateAnsi('\u65e5\u672c\u8a9e\u65e5\u672c\u8a9e', 5))).toBeLessThanOrEqual(5)
  })
})

describe('LogBuffer', () => {
  test('a chunk boundary mid-line reassembles', () => {
    const buffer = new LogBuffer()
    buffer.push('game', 'hello wo')
    expect(buffer.size).toBe(0)
    buffer.push('game', 'rld\nsecond\n')
    expect(buffer.all().map((l) => l.text)).toEqual(['hello world', 'second'])
  })

  test('channels keep separate partials, so an interleaved write does not splice', () => {
    const buffer = new LogBuffer()
    buffer.push('game', 'out-')
    buffer.push('gameError', 'err-')
    buffer.push('game', 'one\n')
    buffer.push('gameError', 'two\n')
    expect(buffer.all().map((l) => [l.channel, l.text])).toEqual([
      ['game', 'out-one'],
      ['gameError', 'err-two'],
    ])
  })

  test('a carriage-return redraw becomes lines, not one growing string', () => {
    const buffer = new LogBuffer()
    for (let i = 0; i < 5; i++) buffer.push('game', `progress ${i}\r`)
    expect(buffer.size).toBe(5)
    expect(buffer.all().map((l) => l.text)).toEqual(['progress 0', 'progress 1', 'progress 2', 'progress 3', 'progress 4'])
  })

  test('a line that never ends is capped instead of growing forever', () => {
    const buffer = new LogBuffer()
    for (let i = 0; i < 40; i++) buffer.push('game', 'x'.repeat(8 * 1024))
    buffer.flush()
    expect(buffer.all()[0]!.text.length).toBeLessThanOrEqual(64 * 1024)
  })

  test('a tail with no newline survives a flush', () => {
    const buffer = new LogBuffer()
    buffer.push('game', 'died mid-line')
    expect(buffer.size).toBe(0)
    buffer.flush()
    expect(buffer.all()[0]!.text).toBe('died mid-line')
  })

  test('a carriage return is not kept as text', () => {
    const buffer = new LogBuffer()
    buffer.push('game', 'windows\r\n')
    expect(buffer.all()[0]!.text).toBe('windows')
  })

  test('the level is read through the escapes the game already wrote', () => {
    const buffer = new LogBuffer()
    buffer.push('game', `${ESC}[90m22:49:21 ${ESC}[33m WARN ${ESC}[0mSteam missing\n`)
    buffer.push('game', '   at Verse.Root.Start()\n')
    expect(buffer.all()[0]!.level).toBe('WARN')
    expect(buffer.all()[1]!.level).toBeUndefined()
  })

  test('the ring drops the oldest and says how many it lost', () => {
    const buffer = new LogBuffer(3)
    for (let i = 0; i < 10; i++) buffer.push('game', `line ${i}\n`)
    expect(buffer.size).toBe(3)
    expect(buffer.all().map((l) => l.text)).toEqual(['line 7', 'line 8', 'line 9'])
    expect(buffer.lost).toBe(7)
    expect(buffer.all()[0]!.seq).toBe(7)
  })

  test('a filter reads the printable text, never the escapes', () => {
    const buffer = new LogBuffer()
    buffer.push('game', `${ESC}[33mWARN${ESC}[0m Steam missing\n`)
    buffer.push('game', 'all good\n')
    expect(buffer.filter('steam').map((l) => stripAnsi(l.text))).toEqual(['WARN Steam missing'])
    expect(buffer.filter('33m')).toHaveLength(0)
  })
})

describe('highlightMatches', () => {
  test('every match is wrapped and the surrounding colour survives', () => {
    const out = highlightMatches(`${ESC}[33mfoo bar foo${ESC}[0m`, 'foo')
    expect(out).toContain(`${ESC}[7mfoo${ESC}[27m`)
    expect(stripAnsi(out)).toBe('foo bar foo')
    expect(out.split(`${ESC}[7m`)).toHaveLength(3)
  })

  test('matching is case-insensitive but the original case is kept', () => {
    expect(stripAnsi(highlightMatches('Waylith', 'way'))).toBe('Waylith')
    expect(highlightMatches('Waylith', 'way')).toContain(`${ESC}[7mWay${ESC}[27m`)
  })

  test('an empty needle changes nothing', () => {
    expect(highlightMatches('abc', '')).toBe('abc')
  })
})

describe('colour containment', () => {
  test('every rendered row closes the style it opened', () => {
    const buffer = new LogBuffer()
    buffer.push('game', '<color=#ff0000>red and never closed\n')
    buffer.push('game', 'this row must not be red\n')
    const out = view(buffer, { rows: 2, width: 60 })
    expect(out.lines[0]!.endsWith(`${ESC}[0m`)).toBe(true)
    expect(stripAnsi(out.lines[1]!)).toBe('this row must not be red')
    expect(out.lines[1]).not.toContain(ESC)
  })

  test('a row with no escapes is left plain', () => {
    const buffer = new LogBuffer()
    buffer.push('game', 'nothing to close\n')
    expect(view(buffer, { rows: 1, width: 40 }).lines[0]).toBe('nothing to close')
  })

  test('a tag the parser rejects keeps the colour around it', () => {
    const RED = `${ESC}[38;2;255;0;0m`
    const out = renderColorTags('<color=#ff0000>a<color=orange>b</color>c</color>d')
    expect(out).not.toContain('<color=orange>')
    expect(out).toBe(`${RED}ab${RED}c${ESC}[39md`)
  })

  test('a close with nothing open emits no stray reset', () => {
    expect(renderColorTags('</color>orphan')).toBe('orphan')
  })
})

describe('view', () => {
  const filled = (n: number): LogBuffer => {
    const buffer = new LogBuffer()
    for (let i = 0; i < n; i++) buffer.push('game', `line ${i}\n`)
    return buffer
  }

  test('the tail is what a live run shows', () => {
    const out = view(filled(100), { rows: 3, width: 40 })
    expect(out.lines).toEqual(['line 97', 'line 98', 'line 99'])
    expect(out.count).toBe(100)
    expect(out.following).toBe(true)
  })

  test('scrollback walks backwards and stops following', () => {
    const out = view(filled(100), { rows: 3, width: 40, scrollback: 10 })
    expect(out.lines).toEqual(['line 87', 'line 88', 'line 89'])
    expect(out.following).toBe(false)
  })

  test('scrollback past the top clamps instead of going blank', () => {
    const out = view(filled(10), { rows: 3, width: 40, scrollback: 999 })
    expect(out.lines).toEqual(['line 0', 'line 1', 'line 2'])
  })

  test('a short buffer is padded so the pane keeps its height', () => {
    const out = view(filled(2), { rows: 5, width: 40 })
    expect(out.lines).toHaveLength(5)
    expect(out.lines.slice(2)).toEqual(['', '', ''])
  })

  test('the count is matches when filtering, not the whole run', () => {
    const out = view(filled(100), { rows: 5, width: 40, filter: 'line 1' })
    expect(out.count).toBe(11)
  })

  test('every rendered line fits the width', () => {
    const buffer = new LogBuffer()
    buffer.push('game', `${ESC}[33m${'x'.repeat(500)}${ESC}[0m\n`)
    const out = view(buffer, { rows: 1, width: 80 })
    expect(displayWidth(out.lines[0]!)).toBe(80)
  })

  test('highlight and truncation compose without breaking an escape', () => {
    const buffer = new LogBuffer()
    buffer.push('game', `${ESC}[32mfindme ${'y'.repeat(200)}\n`)
    const out = view(buffer, { rows: 1, width: 20, filter: 'findme', highlight: true })
    expect(displayWidth(out.lines[0]!)).toBe(20)
    expect(out.lines[0]!).toContain(`${ESC}[7mfindme${ESC}[27m`)
  })
})
