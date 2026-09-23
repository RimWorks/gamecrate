import { describe, expect, test } from 'vitest'
import { RUNTIME_BASE, resolveBase } from '../src/image/base'
import type { BaseKind } from '../src/image/base'
import { Exit, GamecrateError } from '../src/types'

describe('resolveBase', () => {
  test('a reference variant has no base', () => {
    expect(resolveBase('none')).toBeNull()
  })

  test('an override does not make a reference variant runnable', () => {
    expect(resolveBase('none', 'ghcr.io/example/other@sha256:abc')).toBeNull()
  })

  test('a known kind resolves to its pinned digest', () => {
    expect(resolveBase('xvfb')).toBe(RUNTIME_BASE.xvfb)
    expect(resolveBase('proton')).toBe(RUNTIME_BASE.proton)
  })

  test('an override replaces the pin', () => {
    const ref = 'ghcr.io/example/base@sha256:abc'
    expect(resolveBase('proton', ref)).toBe(ref)
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
    expect((error as GamecrateError).detail).toContain('xvfb')
    expect((error as GamecrateError).detail).toContain('proton')
    expect((error as GamecrateError).detail).toContain('none')
  })
})

describe('RUNTIME_BASE', () => {
  test('every pin is a digest ref on the gamecrate ghcr path', () => {
    for (const ref of Object.values(RUNTIME_BASE)) {
      expect(ref).toMatch(/^ghcr\.io\/rimworks\/gamecrate\/[a-z-]+@sha256:[0-9a-f]{64}$/)
    }
  })
})
