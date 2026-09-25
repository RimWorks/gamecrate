import { describe, expect, test } from 'bun:test'
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

  test('a known kind resolves to its pinned tag', () => {
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
  // a major tag, so an apt fix reaches a released cli. never latest: that lets a breaking
  // base change reach one too, and never a digest, which needs a release per rebuild
  test('every pin is a major tag on the gamecrate ghcr path', () => {
    for (const ref of Object.values(RUNTIME_BASE)) {
      expect(ref).toMatch(/^ghcr\.io\/rimworks\/gamecrate\/[a-z-]+:[0-9]+$/)
    }
  })
})
