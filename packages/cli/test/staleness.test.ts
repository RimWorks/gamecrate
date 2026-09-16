import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ago,
  decideStale,
  duration,
  scanBuildTimes,
  staleReport,
  staleWarning,
} from '../src/mods/staleness'

let tmp = ''

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-staleness-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

let counter = 0

/** A mod dir with the given files, each `age` seconds old. */
async function modDir(files: Record<string, number>): Promise<string> {
  const dir = join(tmp, `mod-${counter++}`)
  for (const [name, ageSeconds] of Object.entries(files)) {
    const path = join(dir, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'x')
    const at = new Date(Date.now() - ageSeconds * 1000)
    await utimes(path, at, at)
  }
  await mkdir(dir, { recursive: true })
  return dir
}

/** decideStale over a directory, which is how the caller in resolve.ts spells it. */
const isStale = async (dir: string): Promise<boolean> => decideStale(await scanBuildTimes(dir))

describe('isStale', () => {
  test('a .cs newer than the newest Assemblies dll is stale', async () => {
    const dir = await modDir({ 'Source/Main.cs': 0, 'Assemblies/Mod.dll': 60 })
    expect(await isStale(dir)).toBe(true)
  })

  test('a rebuilt assembly is not stale', async () => {
    const dir = await modDir({ 'Source/Main.cs': 60, 'Assemblies/Mod.dll': 0 })
    expect(await isStale(dir)).toBe(false)
  })

  // Auto-build has to fire for a mod nobody has compiled yet, so no assembly counts as stale.
  test('C# with no assembly at all is stale', async () => {
    expect(await isStale(await modDir({ 'Source/Main.cs': 0 }))).toBe(true)
  })

  test('obj/ intermediates never count as sources', async () => {
    const dir = await modDir({ 'obj/AssemblyInfo.cs': 0, 'Assemblies/Mod.dll': 60 })
    expect(await isStale(dir)).toBe(false)
  })

  test('a mod with no C# is never stale', async () => {
    expect(await isStale(await modDir({ 'About/About.xml': 0 }))).toBe(false)
  })

  test('a per-version Assemblies dir counts, the way Atlas ships them', async () => {
    const dir = await modDir({ 'Source/Main.cs': 60, '1.5/Assemblies/Mod.dll': 0 })
    expect(await isStale(dir)).toBe(false)
  })
})

describe('staleReport', () => {
  test('names the newest source and counts every source past the assembly', async () => {
    const dir = await modDir({
      'Source/Old.cs': 600,
      'Source/Newer.cs': 120,
      'Source/Newest.cs': 30,
      'Assemblies/Mod.dll': 300,
    })
    const report = staleReport(await scanBuildTimes(dir))!

    expect(report).not.toBeNull()
    expect(report.newestSource).toBe(join('Source', 'Newest.cs'))
    expect(report.assembly).toBe(join('Assemblies', 'Mod.dll'))
    expect(report.newerCount).toBe(2)
  })

  // Never blocks: an XML-only mod is a normal mod, not a broken build.
  test('null when there is no assembly to be stale against', async () => {
    expect(staleReport(await scanBuildTimes(await modDir({ 'Source/Main.cs': 0 })))).toBeNull()
  })

  test('null when the assembly is newer', async () => {
    const dir = await modDir({ 'Source/Main.cs': 60, 'Assemblies/Mod.dll': 0 })
    expect(staleReport(await scanBuildTimes(dir))).toBeNull()
  })

  test('null for a mod with no C# at all', async () => {
    const dir = await modDir({ 'About/About.xml': 0, 'Assemblies/Mod.dll': 60 })
    expect(staleReport(await scanBuildTimes(dir))).toBeNull()
  })
})

describe('staleWarning', () => {
  test('names the file, the assembly and the age', async () => {
    const dir = await modDir({ 'Source/Main.cs': 240, 'Assemblies/Kitted.dll': 3600 })
    const report = staleReport(await scanBuildTimes(dir))!
    const lines = staleWarning('Kitted.Core', report).split('\n')

    expect(lines[0]).toBe(`Kitted.Core has 1 source file newer than ${join('Assemblies', 'Kitted.dll')}`)
    expect(lines[1]).toContain(`newest: ${join('Source', 'Main.cs')} (4m ago)`)
    expect(lines[2]).toContain('you are probably running a stale build')
  })

  test('pluralises the count', async () => {
    const dir = await modDir({ 'A.cs': 10, 'B.cs': 20, 'Assemblies/Mod.dll': 60 })
    const report = staleReport(await scanBuildTimes(dir))!
    expect(staleWarning('Some.Mod', report)).toMatch(/^Some\.Mod has 2 source files newer than/)
  })
})

describe('duration', () => {
  test('rounds to one unit', () => {
    expect(duration(45_000)).toBe('45s')
    expect(duration(4 * 60_000)).toBe('4m')
    expect(duration(3 * 3_600_000)).toBe('3h')
    expect(duration(2 * 86_400_000)).toBe('2d')
  })

  test('a clock skewed into the future reads as 0s, never negative', () => {
    expect(ago(Date.now() + 60_000)).toBe('0s ago')
  })
})
