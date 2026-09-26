import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractRefs, extractScript, readVersion, refsLink } from '../src/image/refs'
import { Exit } from '../src/types'
import type { GameConfig } from '../src/types'

function config(managed?: string[]): GameConfig {
  return {
    gameFiles: { source: 'image', container: '/game' },
    image: { ref: 'ghcr.io/me/atlas:1.6', acquire: 'pull' },
    managed,
  } as unknown as GameConfig
}

describe('the extraction script', () => {
  test('copies assemblies only', () => {
    const text = extractScript(['Foo_Data/Managed'], '/game')
    expect(text).toContain('set -- "$d"/*.dll')
    expect(text).toContain('cp "$@" /out/')
    expect(text).not.toMatch(/"\$d"\/\*(?!\.dll)/)
  })

  test('probes the declared directories in order, under the container path', () => {
    const text = extractScript(['Foo_Data/Managed', '.'], '/game')
    expect(text).toContain("for d in '/game/Foo_Data/Managed' '/game'; do")
  })

  test('a directory with no assemblies falls through to the next', () => {
    expect(extractScript(['a', 'b'], '/game')).toContain('[ -f "$1" ] || continue')
  })

  test('exits 3 when nothing matched, so a miss is Resolution and not a docker failure', () => {
    expect(extractScript(['a'], '/game').trimEnd().endsWith('exit 3')).toBe(true)
  })

  test('quotes a container path holding a space', () => {
    expect(extractScript(['My Data/Managed'], '/game')).toContain("'/game/My Data/Managed'")
  })

  test('the extract script also copies Version.txt from the game root', () => {
    const script = extractScript(['RimWorldLinux_Data/Managed'], '/game')
    expect(script).toContain("cp '/game/Version.txt' /out/")
  })
})

describe('refsLink', () => {
  test('points a version at its own directory', () => {
    expect(refsLink('rimworld', '1.5')).toEndWith('refs/version/rimworld/1.5')
    expect(refsLink('rimworld')).toEndWith('refs/current/rimworld')
  })
})

describe('extractRefs', () => {
  test('refuses a plugin that declares no managed directories', async () => {
    await expect(extractRefs('atlas', config())).rejects.toMatchObject({
      code: Exit.Config,
      message: expect.stringContaining('"atlas" plugin does not declare'),
    })
  })

  test('an empty list is the same refusal, not an empty probe', async () => {
    await expect(extractRefs('atlas', config([]))).rejects.toMatchObject({ code: Exit.Config })
  })
})

describe('the version link', () => {
  // Version.txt carries a build too, and a folder named after the build would pin nothing
  test('takes major.minor out of a rimworld version line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-ver-'))
    await writeFile(join(dir, 'Version.txt'), '1.6.4633 rev1254\n')
    expect(await readVersion(dir)).toBe('1.6')
  })

  test('an image with no Version.txt gets no version link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-ver-'))
    expect(await readVersion(dir)).toBeUndefined()
  })

  test('a line that is not a version is not one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-ver-'))
    await writeFile(join(dir, 'Version.txt'), 'unknown\n')
    expect(await readVersion(dir)).toBeUndefined()
  })

  test('both links are written, so a pin never reads current', () => {
    expect(refsLink('atlas')).toMatch(/refs\/current\/atlas$/)
    expect(refsLink('atlas', '1.6')).toMatch(/refs\/version\/atlas\/1\.6$/)
  })
})
