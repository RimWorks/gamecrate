import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, appendFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRecord, renderRecord, tailRecords } from '../src/cli/records'
import { stripAnsi } from '../src/cli/logpane'
import type { LogRecord } from '../src/cli/records'

const BOOT =
  '{"ts":"2026-09-28T19:04:31.217Z","level":"INFO","channel":"RimWorks.Core.Boot","src":null,"msg":"loaded 41 mods","tmpl":"loaded {Count} mods","ctx":null,"stack":null,"exc":null,"mod":null,"tick":null,"repeats":1,"patched":null}'

const PATCH =
  '{"ts":"2026-09-28T19:04:31.221Z","level":"DEBUG","channel":"RimWorks.Phoenix.Patch","src":"PatchApplier.cs:118","msg":"patched Pawn_HealthTracker.PreApplyDamage","tmpl":"patched {Target}","ctx":{"Target":"Pawn_HealthTracker.PreApplyDamage","Ticks":3,"Ok":true},"stack":null,"exc":null,"mod":"RimWorks.Phoenix","tick":216034,"repeats":3,"patched":["brrainz.harmony","rimworks.phoenix"]}'

const THROWN =
  '{"ts":"2026-09-28T19:04:31.226Z","level":"ERROR","channel":"Verse.Log","src":null,"msg":"def lookup failed","tmpl":"def lookup failed","ctx":null,"stack":null,"exc":{"type":"System.InvalidOperationException","message":"no def named Steel","stack":"   at Gold.Main() in /tmp/ndjgold/Program.cs:line 85"},"mod":null,"tick":216040,"repeats":1,"patched":[]}'

const WARNED =
  '{"ts":"2026-09-28T19:04:31.228Z","level":"WARN","channel":"Vanilla","src":null,"msg":"colour tags gone already","tmpl":"colour tags gone already","ctx":null,"stack":"  at Verse.Log.Warning(String)\\n  at Foo.Bar()","exc":null,"mod":null,"tick":null,"repeats":1,"patched":null}'

function ok(line: string): LogRecord {
  const record = parseRecord(line)
  if (record === undefined) throw new Error(`expected a record from ${line}`)
  return record
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function reaches(seen: readonly LogRecord[], count: number): Promise<void> {
  const until = Date.now() + 5_000
  while (seen.length < count && Date.now() < until) await settle(5)
}

describe('parseRecord', () => {
  test('reads every key the sink writes', () => {
    const record = ok(PATCH)
    expect(record.ts).toBe('2026-09-28T19:04:31.221Z')
    expect(record.level).toBe('DEBUG')
    expect(record.channel).toBe('RimWorks.Phoenix.Patch')
    expect(record.msg).toBe('patched Pawn_HealthTracker.PreApplyDamage')
    expect(record.tmpl).toBe('patched {Target}')
    expect(record.src).toBe('PatchApplier.cs:118')
    expect(record.mod).toBe('RimWorks.Phoenix')
    expect(record.tick).toBe(216034)
    expect(record.repeats).toBe(3)
    expect(record.ctx).toEqual({ Target: 'Pawn_HealthTracker.PreApplyDamage', Ticks: 3, Ok: true })
    expect(record.patched).toEqual(['brrainz.harmony', 'rimworks.phoenix'])
    expect(record.exc).toBeNull()
  })

  test('the nulls the sink writes stay null', () => {
    const record = ok(BOOT)
    expect(record.src).toBeNull()
    expect(record.stack).toBeNull()
    expect(record.exc).toBeNull()
    expect(record.mod).toBeNull()
    expect(record.tick).toBeNull()
    expect(record.patched).toBeNull()
  })

  test('an exception arrives as one object', () => {
    const exc = ok(THROWN).exc
    expect(exc?.type).toBe('System.InvalidOperationException')
    expect(exc?.message).toBe('no def named Steel')
    expect(exc?.stack).toContain('at Gold.Main()')
  })

  test('an empty patched list is not the same claim as null', () => {
    expect(ok(THROWN).patched).toEqual([])
    expect(ok(BOOT).patched).toBeNull()
  })

  test('a stack keeps its newlines', () => {
    expect(ok(WARNED).stack).toBe('  at Verse.Log.Warning(String)\n  at Foo.Bar()')
  })

  test('every level the sink can write is accepted', () => {
    for (const level of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']) {
      expect(ok(BOOT.replace('"INFO"', `"${level}"`)).level).toBe(level)
    }
  })

  test('a truncated line is skipped rather than thrown on', () => {
    expect(parseRecord('{"ts":"2026-09-28T19:04:31.217Z","level":"INFO","cha')).toBeUndefined()
  })

  test('anything that is not a record object is skipped', () => {
    expect(parseRecord('')).toBeUndefined()
    expect(parseRecord('   ')).toBeUndefined()
    expect(parseRecord('null')).toBeUndefined()
    expect(parseRecord('[]')).toBeUndefined()
    expect(parseRecord('"a string"')).toBeUndefined()
    expect(parseRecord('12')).toBeUndefined()
    expect(parseRecord('{}')).toBeUndefined()
  })

  test('a record missing level, channel or msg is skipped', () => {
    expect(parseRecord('{"level":"INFO","channel":"a"}')).toBeUndefined()
    expect(parseRecord('{"level":"INFO","msg":"a"}')).toBeUndefined()
    expect(parseRecord('{"channel":"a","msg":"b"}')).toBeUndefined()
    expect(parseRecord('{"level":7,"channel":"a","msg":"b"}')).toBeUndefined()
  })

  test('a raw stdout line is not mistaken for a record', () => {
    expect(parseRecord('RimWorld 1.6.4871 rev598')).toBeUndefined()
    expect(parseRecord('[INFO] plain text log line')).toBeUndefined()
  })
})

describe('renderRecord', () => {
  test('one record is one line with its level and channel visible', () => {
    const plain = stripAnsi(renderRecord(ok(PATCH)))
    expect(plain).not.toContain('\n')
    expect(plain).toContain('DEBUG')
    expect(plain).toContain('RimWorks.Phoenix.Patch')
    expect(plain).toContain('patched Pawn_HealthTracker.PreApplyDamage')
    expect(plain).toContain('19:04:31.221')
  })

  test('a repeat count shows, and a single hit does not', () => {
    expect(stripAnsi(renderRecord(ok(PATCH)))).toContain('x3')
    expect(stripAnsi(renderRecord(ok(BOOT)))).not.toContain('x1')
  })

  test('an exception is one entry, not a wall of stack lines', () => {
    const rendered = renderRecord(ok(THROWN))
    expect(rendered).not.toContain('\n')
    const plain = stripAnsi(rendered)
    expect(plain).toContain('System.InvalidOperationException')
    expect(plain).toContain('no def named Steel')
    expect(plain).not.toContain('at Gold.Main()')
  })

  test('a multi-line stack cannot break the pane apart', () => {
    expect(renderRecord(ok(WARNED))).not.toContain('\n')
    expect(renderRecord({ ...ok(BOOT), msg: 'first\nsecond\r\nthird' })).not.toContain('\n')
  })

  test('a level nobody documented still renders', () => {
    expect(stripAnsi(renderRecord({ ...ok(BOOT), level: 'VERBOSE' }))).toContain('VERBOSE')
  })

  test('an unreadable timestamp does not lose the rest of the line', () => {
    expect(stripAnsi(renderRecord({ ...ok(BOOT), ts: 'not a time' }))).toContain('loaded 41 mods')
  })
})

describe('tailRecords', () => {
  async function box(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'gamecrate-records-'))
  }

  test('a directory that does not exist yet is waited out, not thrown on', async () => {
    const dir = join(await box(), 'made-later')
    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    await settle()
    expect(seen).toHaveLength(0)
    stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('records appended after the tail starts arrive', async () => {
    const dir = await box()
    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    await writeFile(join(dir, 'RimLogging-20260928-190431-57.ndjson'), `${BOOT}\n`)
    await reaches(seen, 1)
    await appendFile(join(dir, 'RimLogging-20260928-190431-57.ndjson'), `${PATCH}\n${THROWN}\n`)
    await reaches(seen, 3)
    stop()
    expect(seen.map((record) => record.channel)).toEqual(['RimWorks.Core.Boot', 'RimWorks.Phoenix.Patch', 'Verse.Log'])
    await rm(dir, { recursive: true, force: true })
  })

  test('a line with no newline yet is held back until it finishes', async () => {
    const dir = await box()
    const file = join(dir, 'RimLogging-20260928-190431-57.ndjson')
    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    await writeFile(file, `${BOOT}\n${PATCH.slice(0, 60)}`)
    await reaches(seen, 1)
    await settle()
    expect(seen).toHaveLength(1)
    await appendFile(file, `${PATCH.slice(60)}\n`)
    await reaches(seen, 2)
    stop()
    expect(seen).toHaveLength(2)
    expect(seen[1]?.channel).toBe('RimWorks.Phoenix.Patch')
    await rm(dir, { recursive: true, force: true })
  })

  test('a malformed line is skipped and the ones around it still arrive', async () => {
    const dir = await box()
    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    await writeFile(join(dir, 'RimLogging-20260928-190431-57.ndjson'), `${BOOT}\n{"level":"INF\n\n${THROWN}\n`)
    await reaches(seen, 2)
    stop()
    expect(seen.map((record) => record.channel)).toEqual(['RimWorks.Core.Boot', 'Verse.Log'])
    await rm(dir, { recursive: true, force: true })
  })

  test('a file written before the tail started is left alone', async () => {
    const dir = await box()
    const old = join(dir, 'RimLogging-20260101-000000-11.ndjson')
    await writeFile(old, `${BOOT}\n${PATCH}\n`)
    const ancient = new Date(Date.now() - 600_000)
    await utimes(old, ancient, ancient)

    const seen: LogRecord[] = []
    const stop = tailRecords({
      dir,
      intervalMs: 5,
      since: Date.now(),
      onRecord: (record) => seen.push(record),
    })
    await settle()
    expect(seen).toHaveLength(0)
    stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('a newer file takes over from the one being followed', async () => {
    const dir = await box()
    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    await writeFile(join(dir, 'RimLogging-20260928-190431-57.ndjson'), `${BOOT}\n`)
    await reaches(seen, 1)
    await writeFile(join(dir, 'RimLogging-20260928-191002-58.ndjson'), `${THROWN}\n`)
    await reaches(seen, 2)
    await appendFile(join(dir, 'RimLogging-20260928-191002-58.ndjson'), `${WARNED}\n`)
    await reaches(seen, 3)
    stop()
    expect(seen.map((record) => record.channel)).toEqual(['RimWorks.Core.Boot', 'Verse.Log', 'Vanilla'])
    await rm(dir, { recursive: true, force: true })
  })

  test('a file that is not ndjson is never read', async () => {
    const dir = await box()
    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    await writeFile(join(dir, 'RimLogging-20260928-190431-57.log'), `${BOOT}\n`)
    await settle()
    expect(seen).toHaveLength(0)
    stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('a record that lands mid-poll after stop is never delivered', async () => {
    const dir = await box()
    const seen: LogRecord[] = []
    const file = join(dir, 'RimLogging-20260928-190431-57.ndjson')
    await writeFile(file, `${BOOT}\n`)
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    stop()
    await settle()
    expect(seen).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  test('stopping ends the polling', async () => {
    const dir = await box()
    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    stop()
    await writeFile(join(dir, 'RimLogging-20260928-190431-57.ndjson'), `${BOOT}\n`)
    await settle()
    expect(seen).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  test('a multi-byte character split across two polls is not mangled', async () => {
    const dir = await box()
    const file = join(dir, 'RimLogging-20260928-190431-57.ndjson')
    const line = BOOT.replace('loaded 41 mods', 'loaded 41 モッド')
    const bytes = Buffer.from(`${line}\n`, 'utf8')
    const cut = bytes.indexOf(Buffer.from('モ', 'utf8')) + 1

    const seen: LogRecord[] = []
    const stop = tailRecords({ dir, intervalMs: 5, since: 0, onRecord: (record) => seen.push(record) })
    await writeFile(file, bytes.subarray(0, cut))
    await settle()
    await appendFile(file, bytes.subarray(cut))
    await reaches(seen, 1)
    stop()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.msg).toBe('loaded 41 モッド')
    await rm(dir, { recursive: true, force: true })
  })
})
