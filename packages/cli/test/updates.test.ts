import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as realInput from '../src/image/input'
import * as realDepotDownloader from '../src/mods/depotdownloader'
import type { ImageFacts } from '../src/launch/image'

const launch = { passwords: [] as (string | undefined)[] }
await mock.module('../src/launch/prepare', () => ({ imageDigest: async () => 'sha256:img' }))
await mock.module('../src/image/input', () => ({
  ...realInput,
  resolveSteamBuildInput: async () => ({ steamAppId: 294100, branches: [{ name: 'unstable', password: true }] }),
}))
await mock.module('../src/mods/depotdownloader', () => ({
  ...realDepotDownloader,
  currentBuildId: async (_config: unknown, _appId: number, _branch: string, password?: string) => {
    launch.passwords.push(password)
    return null
  },
}))
const { lastCheckedAt, offerRebuild, recordCheck, shouldCheck } = await import('../src/launch/updates')

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

describe('offerRebuild', () => {
  test('a private branch with no password at launch is checked without one, and asks nothing', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'dg-updates-'))
    const before = process.env['XDG_CACHE_HOME']
    process.env['XDG_CACHE_HOME'] = cache
    delete process.env['STEAM_BRANCH_PASSWORD_UNSTABLE']
    delete process.env['STEAM_BRANCH_PASSWORD']
    let asked = 0
    try {
      await offerRebuild({
        game: 'rimworld',
        config: { dataRoot: cache, games: { rimworld: { image: { ref: 'ghcr.io/x/game' } } } } as never,
        args: {} as never,
        facts: { ...ours, branch: 'unstable' },
        cwd: cache,
        ask: async () => {
          asked += 1
          return false
        },
      })
      expect(launch.passwords).toEqual([undefined])
      expect(asked).toBe(0)
      expect(lastCheckedAt('sha256:img')).not.toBeNull()
    } finally {
      if (before === undefined) delete process.env['XDG_CACHE_HOME']
      else process.env['XDG_CACHE_HOME'] = before
      await rm(cache, { recursive: true, force: true })
    }
  })
})
