import { describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lastCheckedAt, recordCheck, shouldCheck } from '../src/launch/updates'
import type { ImageFacts } from '../src/launch/image'

const ours: ImageFacts = {
  present: true,
  runtime: 'sha256:base',
  launcher: 'direct',
  executable: './AtlasLinux',
  branch: 'public',
  variant: 'linux',
  buildid: '100',
}

const HOUR = 3_600_000
const NOW = 1_700_000_000_000

describe('shouldCheck', () => {
  test('an image gamecrate built, never checked, gets checked', () => {
    expect(shouldCheck({ facts: ours, spec: undefined, lastCheckedAt: null, now: NOW })).toEqual({ check: true })
  })

  test('check: false turns it off outright', () => {
    const out = shouldCheck({ facts: ours, spec: { check: false }, lastCheckedAt: null, now: NOW })
    expect(out).toEqual({ check: false, reason: 'disabled' })
  })

  // the check costs four seconds and a steam session, so an image we did not build never pays
  test('an image with no buildid label is not ours to check', () => {
    const foreign = { ...ours, buildid: null }
    expect(shouldCheck({ facts: foreign, spec: undefined, lastCheckedAt: null, now: NOW }).reason).toBe('not-ours')
    const noBranch = { ...ours, branch: null }
    expect(shouldCheck({ facts: noBranch, spec: undefined, lastCheckedAt: null, now: NOW }).reason).toBe('not-ours')
    const absent = { ...ours, present: false }
    expect(shouldCheck({ facts: absent, spec: undefined, lastCheckedAt: null, now: NOW }).reason).toBe('not-ours')
  })

  test('the default window is six hours', () => {
    const five = { facts: ours, spec: undefined, lastCheckedAt: NOW - 5 * HOUR, now: NOW }
    expect(shouldCheck(five)).toEqual({ check: false, reason: 'throttled' })
    expect(shouldCheck({ ...five, lastCheckedAt: NOW - 7 * HOUR })).toEqual({ check: true })
  })

  test('everyHours moves the window', () => {
    const at = { facts: ours, lastCheckedAt: NOW - 2 * HOUR, now: NOW }
    expect(shouldCheck({ ...at, spec: { everyHours: 1 } })).toEqual({ check: true })
    expect(shouldCheck({ ...at, spec: { everyHours: 24 } }).reason).toBe('throttled')
  })

  test('zero hours checks every launch', () => {
    const out = shouldCheck({ facts: ours, spec: { everyHours: 0 }, lastCheckedAt: NOW, now: NOW })
    expect(out).toEqual({ check: true })
  })
})

describe('the stamp file', () => {
  test('a stamp is keyed by image id, so a rebuild is judged fresh', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'dg-updates-'))
    const before = process.env['XDG_CACHE_HOME']
    process.env['XDG_CACHE_HOME'] = cache
    try {
      expect(lastCheckedAt('sha256:aaa')).toBeNull()
      recordCheck('sha256:aaa', NOW)
      expect(lastCheckedAt('sha256:aaa')).toBe(NOW)
      expect(lastCheckedAt('sha256:bbb')).toBeNull()
    } finally {
      if (before === undefined) delete process.env['XDG_CACHE_HOME']
      else process.env['XDG_CACHE_HOME'] = before
      await rm(cache, { recursive: true, force: true })
    }
  })

  test('an unwritable cache costs a repeated check, not a failed launch', () => {
    const before = process.env['XDG_CACHE_HOME']
    process.env['XDG_CACHE_HOME'] = '/dev/null/nope'
    try {
      expect(() => recordCheck('sha256:aaa', NOW)).not.toThrow()
      expect(lastCheckedAt('sha256:aaa')).toBeNull()
    } finally {
      if (before === undefined) delete process.env['XDG_CACHE_HOME']
      else process.env['XDG_CACHE_HOME'] = before
    }
  })
})
