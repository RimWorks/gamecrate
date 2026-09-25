import { describe, expect, test } from 'vitest'

import { extractRefs, extractScript } from '../src/image/refs'
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
