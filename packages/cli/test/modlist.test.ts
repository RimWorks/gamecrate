import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readModlist } from '../src/mods/modlist'
import { parseArgs } from '../src/cli/args'
import { imageFor } from '../src/launch/image'
import { reachedEntries } from '../src/mods/source'
import { Exit, type GameConfig } from '../src/types'

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

  test('refuses a row with no workshop id', async () => {
    const path = await dump('broken.txt', '0 | Harmony | brrainz.harmony\n')
    expect(() => readModlist(path)).toThrow(/names no packageId and workshop id/)
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
