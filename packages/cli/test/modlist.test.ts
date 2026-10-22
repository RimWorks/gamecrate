import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readModlist } from '../src/mods/modlist'
import { parseArgs } from '../src/cli/args'
import { imageFor } from '../src/launch/image'
import { reachedEntries } from '../src/mods/source'
import { Exit, type GameConfig, type GamecrateError } from '../src/types'

let tmp = ''

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-modlist-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const DUMP = [
  '412 active workshop mods of 1026 subscribed (play list read 2026-10-17).',
  '',
  '   0 | Harmony | brrainz.harmony | 2009463077',
  '   1 | Loading Progress | ilyvion.LoadingProgress | 3535481557',
  ' 459 | Better Architect Menu | Tweaks | KobeRiddle.BetterArchitectMenu.Tweaks | 3571749771',
  '',
].join('\n')

async function dump(name: string, body: string): Promise<string> {
  const path = join(tmp, name)
  await writeFile(path, body)
  return path
}

const GAME: GameConfig = {
  core: 'Ludeon.RimWorld',
  dlc: [],
  image: { ref: 'ghcr.io/rimworks/rimworld:1.6' },
  profiles: { debug: { mods: ['some.mod'] } },
} as unknown as GameConfig

describe('readModlist', () => {
  test('keeps the file order and skips the header', async () => {
    const path = await dump('list.txt', DUMP)
    expect(readModlist(path)).toEqual([
      'workshop:2009463077',
      'workshop:3535481557',
      'workshop:3571749771',
    ])
  })

  test('reads past a pipe inside a mod name', async () => {
    const path = await dump('pipe.txt', '  7 | A | B | C | pkg.id | 1234\n')
    expect(readModlist(path)).toEqual(['workshop:1234'])
  })

  test('drops a repeated workshop id', async () => {
    const path = await dump('dupe.txt', '0 | A | a.b | 11\n1 | B | c.d | 11\n')
    expect(readModlist(path)).toEqual(['workshop:11'])
  })

  test('a row with no workshop id resolves by packageId, as Core and the DLC do', async () => {
    const path = await dump('bare.txt', '0 | Core | ludeon.rimworld |\n1 | Local | me.local\n')
    expect(readModlist(path)).toEqual(['ludeon.rimworld', 'me.local'])
  })

  test('a version suffix after the workshop id is ignored', async () => {
    const path = await dump('suffix.txt', '0 | A | a.b | 1234 (1.6)\n')
    expect(readModlist(path)).toEqual(['workshop:1234'])
  })

  test('reads a tab separated ModList.txt, in the order the game loaded them', async () => {
    const path = await dump('tabs.txt', [
      'name\tpackageId\tversion\tactive',
      'Core\tludeon.rimworld\t1.7.4321\ttrue',
      'Harmony\tbrrainz.harmony\t2.3.6\ttrue',
      'RimLogging\trimworks.rimlogging\t2.1.0\ttrue',
      '',
    ].join('\n'))
    expect(readModlist(path)).toEqual(['ludeon.rimworld', 'brrainz.harmony', 'rimworks.rimlogging'])
  })

  test('leaves out a ModList.txt row the game did not have active', async () => {
    const path = await dump('inactive.txt', [
      'name\tpackageId\tversion\tactive',
      'Core\tludeon.rimworld\t1.7.4321\ttrue',
      'Old Thing\tsomeone.oldthing\t1.2.0\tfalse',
      '',
    ].join('\n'))
    expect(readModlist(path)).toEqual(['ludeon.rimworld'])
  })

  test('a ModList.txt row may leave a name or version empty, but not a packageId', async () => {
    const blank = await dump('blankcells.txt', 'name\tpackageId\tversion\tactive\n\tme.local\t\ttrue\n')
    expect(readModlist(blank)).toEqual(['me.local'])
    const noId = await dump('noid.txt', 'name\tpackageId\tversion\tactive\nThing\t\t1.0\ttrue\n')
    expect(() => readModlist(noId)).toThrow(/names no packageId/)
  })

  test('refuses a ModList.txt row that is neither four nor five columns', async () => {
    const path = await dump('widths.txt', 'name\tpackageId\tversion\tactive\nThing\tme.thing\ttrue\n')
    expect(() => readModlist(path)).toThrow(/column\(s\), not 4 or 5/)
  })

  test('a ModList.txt workshopId resolves the row by id, and "local" by packageId', async () => {
    const path = await dump('ids.txt', [
      'name\tpackageId\tversion\tactive\tworkshopId',
      'Core\tludeon.rimworld\t1.7.4321\ttrue\tlocal',
      'Harmony\tbrrainz.harmony\t2.3.6\ttrue\t2009463077',
      'RimLogging\trimworks.rimlogging\t4.0.0\ttrue\t3733484696',
      'Old Thing\tsomeone.oldthing\t1.2.0\tfalse\tlocal',
      '',
    ].join('\n'))
    expect(readModlist(path)).toEqual([
      'ludeon.rimworld',
      'workshop:2009463077',
      'workshop:3733484696',
    ])
  })

  test('a bundle written before the workshopId column reads as every row local', async () => {
    const path = await dump('nocolumn.txt', [
      'name\tpackageId\tversion\tactive',
      'Harmony\tbrrainz.harmony\t2.3.6\ttrue',
      '',
    ].join('\n'))
    expect(readModlist(path)).toEqual(['brrainz.harmony'])
  })

  test('an empty workshopId cell reads as local, the same as no column at all', async () => {
    const path = await dump('emptyid.txt', 'name\tpackageId\tversion\tactive\tworkshopId\nCore\tludeon.rimworld\t1.7\ttrue\t\n')
    expect(readModlist(path)).toEqual(['ludeon.rimworld'])
    const trailing = await dump('trailtab.txt', 'name\tpackageId\tversion\tactive\nCore\tludeon.rimworld\t1.7\ttrue\t\n')
    expect(readModlist(trailing)).toEqual(['ludeon.rimworld'])
  })

  test('a tab file with no usable rows is told about tabs, not pipes', async () => {
    const path = await dump('headeronly.txt', 'name\tpackageId\tversion\tactive\n')
    expect(() => readModlist(path)).toThrow(/holds no mod list rows/)
    try {
      readModlist(path)
    } catch (error) {
      expect((error as GamecrateError).detail).toContain('separated by tabs')
    }
  })

  test('refuses a workshopId that is neither digits nor "local"', async () => {
    const path = await dump('badid.txt', [
      'name\tpackageId\tversion\tactive\tworkshopId',
      'Harmony\tbrrainz.harmony\t2.3.6\ttrue\tunknown',
      '',
    ].join('\n'))
    expect(() => readModlist(path)).toThrow(/workshopId "unknown"/)
  })

  test('refuses a row with too few fields', async () => {
    const path = await dump('short.txt', '0 | Harmony\n')
    expect(() => readModlist(path)).toThrow(/field\(s\)/)
  })

  test('refuses a file with no rows', async () => {
    const path = await dump('empty.txt', 'nothing here\n')
    expect(() => readModlist(path)).toThrow(/holds no mod list rows/)
  })

  test('refuses a file that is not there', () => {
    expect(() => readModlist(join(tmp, 'absent.txt'))).toThrow(/cannot read mod list/)
  })
})

describe('--modlist', () => {
  test('replaces what the profile loads, ahead of --only', async () => {
    const path = await dump('run.txt', DUMP)
    const args = parseArgs(['run', 'debug', '--modlist', path, '--only', 'extra.mod'])
    expect(args.only).toEqual([
      'workshop:2009463077',
      'workshop:3535481557',
      'workshop:3571749771',
      'extra.mod',
    ])
  })

  test('puts every row in front of the workshop fetch', async () => {
    const path = await dump('fetch.txt', DUMP)
    const args = parseArgs(['run', 'debug', '--modlist', path])
    const reached = reachedEntries(GAME, GAME.profiles['debug']!, args)
    expect(reached).toContain('workshop:2009463077')
    expect(reached).toContain('workshop:3535481557')
    expect(reached).toContain('workshop:3571749771')
    expect(reached).not.toContain('some.mod')
  })

  test('leaves --use alone', async () => {
    const path = await dump('use.txt', DUMP)
    const args = parseArgs(['run', 'debug', '--modlist', path, '--use', 'brrainz.harmony=/src/harmony'])
    expect(args.use).toEqual(['brrainz.harmony=/src/harmony'])
  })

  test('exits with a usage code when the file is unreadable', () => {
    try {
      parseArgs(['run', 'debug', '--modlist', join(tmp, 'gone.txt')])
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as { code?: number }).code).toBe(Exit.Usage)
    }
  })
})

describe('--game-version', () => {
  test('tags the game repository', () => {
    expect(imageFor(GAME, 'debug', undefined, '1.5')).toBe('ghcr.io/rimworks/rimworld:1.5')
  })

  test('loses to --image', () => {
    expect(imageFor(GAME, 'debug', 'local/other:dev', '1.5')).toBe('local/other:dev')
  })
})
