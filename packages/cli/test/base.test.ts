import { describe, expect, test } from 'bun:test'
import { RUNTIME_BASE, resolveBase } from '../src/image/base'
import { applyDefaultImage } from '../src/config/builtin'
import type { BaseKind } from '../src/image/base'
import { Exit, GamecrateError } from '../src/types'

describe('resolveBase', () => {
  test('a reference variant has no base', () => {
    expect(resolveBase('none')).toBeNull()
  })

  test('an override does not make a reference variant runnable', () => {
    expect(resolveBase('none', 'ghcr.io/example/other@sha256:abc')).toBeNull()
  })

  test('a known kind resolves to its pinned tag', () => {
    expect(resolveBase('linux')).toBe(RUNTIME_BASE.linux)
    expect(resolveBase('windows')).toBe(RUNTIME_BASE.windows)
  })

  test('an override replaces the pin', () => {
    const ref = 'ghcr.io/example/base@sha256:abc'
    expect(resolveBase('windows', ref)).toBe(ref)
  })

  test('an unknown kind is a config error that lists the real ones', () => {
    let error: unknown
    try {
      resolveBase('wayland' as BaseKind)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GamecrateError)
    expect((error as GamecrateError).code).toBe(Exit.Config)
    expect((error as GamecrateError).message).toContain('wayland')
    expect((error as GamecrateError).detail).toContain('linux')
    expect((error as GamecrateError).detail).toContain('windows')
    expect((error as GamecrateError).detail).toContain('none')
  })
})

describe('RUNTIME_BASE', () => {
  test('every pin is a major tag on the gamecrate ghcr path', () => {
    for (const ref of Object.values(RUNTIME_BASE)) {
      expect(ref).toMatch(/^ghcr\.io\/rimworks\/gamecrate\/[a-z-]+:[0-9]+$/)
    }
  })
})

describe('applyDefaultImage', () => {
  function game(extra: Record<string, unknown>): Record<string, unknown> {
    return { games: { atlas: { gameFiles: { container: '/game' }, ...extra } } }
  }

  test('a mounted install gets the published linux runtime', () => {
    const out = applyDefaultImage(game({ gameFiles: { source: 'mount', host: '/games/atlas' } })) as {
      games: { atlas: { image: { ref: string; context?: string } } }
    }
    expect(out.games.atlas.image.ref).toBe(RUNTIME_BASE.linux)
    expect(out.games.atlas.image.context).toBeUndefined()
  })

  test('an image that carries the game gets no default, since no ref can stand in', () => {
    const out = applyDefaultImage(game({ gameFiles: { source: 'image' } })) as {
      games: { atlas: { image?: unknown } }
    }
    expect(out.games.atlas.image).toBeUndefined()
  })

  test('a ref already written is left alone', () => {
    const out = applyDefaultImage(
      game({ gameFiles: { source: 'mount', host: '/x' }, image: { ref: 'mine:1' } }),
    ) as { games: { atlas: { image: { ref: string } } } }
    expect(out.games.atlas.image.ref).toBe('mine:1')
  })

  test('--image fills the ref and turns a hostless mount into an image game', () => {
    const out = applyDefaultImage(game({ gameFiles: { source: 'mount' } }), {
      game: 'atlas',
      image: 'ghcr.io/example/atlas:1',
    }) as { games: { atlas: { image: { ref: string }; gameFiles: { source: string } } } }
    expect(out.games.atlas.gameFiles.source).toBe('image')
    expect(out.games.atlas.image.ref).toBe('ghcr.io/example/atlas:1')
  })

  test('--image drops a configured host mount, matching withImageOverride at launch', () => {
    const out = applyDefaultImage(game({ gameFiles: { source: 'mount', host: '/games/atlas' } }), {
      game: 'atlas',
      image: 'ghcr.io/example/atlas:1',
    }) as { games: { atlas: { image: { ref: string }; gameFiles: { source: string } } } }
    expect(out.games.atlas.gameFiles.source).toBe('image')
    expect(out.games.atlas.image.ref).toBe('ghcr.io/example/atlas:1')
  })

  test('--image beats a ref the config names, so both layers pick the same image', () => {
    const out = applyDefaultImage(
      game({ gameFiles: { source: 'image' }, image: { ref: 'mine:1' } }),
      { game: 'atlas', image: 'ghcr.io/example/atlas:1' },
    ) as { games: { atlas: { image: { ref: string } } } }
    expect(out.games.atlas.image.ref).toBe('ghcr.io/example/atlas:1')
  })

  test('--image touches only the game it names', () => {
    const out = applyDefaultImage(game({ gameFiles: { source: 'mount' } }), {
      game: 'other',
      image: 'ghcr.io/example/other:1',
    }) as { games: { atlas: { image: { ref: string }; gameFiles: { source: string } } } }
    expect(out.games.atlas.gameFiles.source).toBe('mount')
    expect(out.games.atlas.image.ref).toBe(RUNTIME_BASE.linux)
  })
})
