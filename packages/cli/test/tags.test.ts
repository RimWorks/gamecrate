import { describe, expect, test } from 'bun:test'
import { sanitizeVersion, tagsFor, versionPrefixes } from '../src/image/tags'

describe('sanitizeVersion', () => {
  test('keeps the first field of a rimworld version line', () => {
    expect(sanitizeVersion('1.6.4871 rev598', 'x')).toBe('1.6.4871')
  })

  // invalid characters become dashes, so junk then one valid character is a long dash run with
  // no trailing dash. /-+$/ then fails from every position in turn and goes quadratic.
  test('a long run of invalid characters does not stall the trim', () => {
    const start = Date.now()
    const junk = `${'%'.repeat(80_000)}x`
    expect(sanitizeVersion(junk, 'fallback')).toBe(`${'-'.repeat(80_000)}x`)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  test('replaces a character an OCI tag refuses', () => {
    expect(sanitizeVersion('1.6+beta', 'x')).toBe('1.6-beta')
  })

  test('drops trailing dashes left by the replacement', () => {
    expect(sanitizeVersion('1.6++', 'x')).toBe('1.6')
  })

  test('falls back when nothing usable is left', () => {
    expect(sanitizeVersion('   ', '19283746')).toBe('19283746')
    expect(sanitizeVersion('+++', 'unknown')).toBe('unknown')
  })
})

describe('tagsFor', () => {
  const base = { version: '1.6.4871', branch: 'public', variant: 'linux' }

  test('the default branch and the default variant get the bare forms', () => {
    expect(tagsFor({ ...base, defaultBranch: true, defaultVariant: true })).toEqual([
      '1.6.4871',
      '1.6.4871-linux',
      'latest',
      'latest-linux',
      '1',
      '1-linux',
      '1.6',
      '1.6-linux',
    ])
  })

  test('a non-default variant on the default branch gets no bare form', () => {
    expect(tagsFor({ ...base, variant: 'windows', defaultBranch: true, defaultVariant: false })).toEqual([
      '1.6.4871-windows',
      'latest-windows',
      '1-windows',
      '1.6-windows',
    ])
  })

  test('a non-default branch puts its name in every tag it writes', () => {
    const tags = tagsFor({
      version: '1.5.4409',
      branch: '1.5-test',
      variant: 'linux',
      defaultBranch: false,
      defaultVariant: true,
    })
    expect(tags).toEqual([
      '1.5.4409-1.5-test',
      '1.5.4409-1.5-test-linux',
      'latest-1.5-test',
      'latest-1.5-test-linux',
      '1-1.5-test',
      '1-1.5-test-linux',
      '1.5-1.5-test',
      '1.5-1.5-test-linux',
    ])
    for (const tag of tags) expect(tag).toContain('1.5-test')
  })

  test('a beta build never writes the bare latest or the bare version', () => {
    const tags = tagsFor({
      version: '1.5.4409',
      branch: '1.5',
      variant: 'linux',
      defaultBranch: false,
      defaultVariant: true,
    })
    expect(tags).not.toContain('latest')
    expect(tags).not.toContain('1.5.4409')
  })

  test('a branch name with a dot survives into the tag', () => {
    const tags = tagsFor({
      version: '1.5.4409',
      branch: '1.5',
      variant: 'linux-ref',
      defaultBranch: false,
      defaultVariant: false,
    })
    expect(tags).toEqual([
      '1.5.4409-1.5-linux-ref',
      'latest-1.5-linux-ref',
      '1-1.5-linux-ref',
      '1.5-1.5-linux-ref',
    ])
  })

  // the immutable tag is written first, because a moving tag must never point at an image
  // before the exact one exists. latest and the version prefixes both move.
  test('the exact version comes before every tag that moves', () => {
    const tags = tagsFor({ ...base, defaultBranch: true, defaultVariant: true })
    const exact = (t: string): boolean => t.startsWith('1.6.4871')
    const lastExact = tags.map(exact).lastIndexOf(true)
    const firstMoving = tags.findIndex((t) => !exact(t))
    expect(lastExact).toBeLessThan(firstMoving)
  })
})

describe('branch aliases', () => {
  const base = { version: '2.0.5000', branch: 'beta', variant: 'linux', defaultBranch: false }

  test('an alias adds moving tags beside latest, and never a versioned one', () => {
    const tags = tagsFor({ ...base, defaultVariant: true, aliases: ['2.0'] })
    expect(tags).toContain('2.0')
    expect(tags).toContain('2.0-linux')
    expect(tags).toContain('latest-beta')
    expect(tags).not.toContain('2.0.5000-2.0')
  })

  test('a non-default variant gets the suffixed alias only', () => {
    const tags = tagsFor({ ...base, variant: 'windows', defaultVariant: false, aliases: ['2.0'] })
    expect(tags).toContain('2.0-windows')
    expect(tags).not.toContain('2.0')
  })

  test('no aliases leaves the tag set alone', () => {
    const plain = tagsFor({ ...base, defaultVariant: true })
    expect(tagsFor({ ...base, defaultVariant: true, aliases: [] })).toEqual(plain)
  })
})

describe('automatic version tags', () => {
  test('a dotted version gives every prefix but itself', () => {
    expect(versionPrefixes('1.6.4871')).toEqual(['1', '1.6'])
    expect(versionPrefixes('1.6')).toEqual(['1'])
  })

  test('a version with nothing to shorten gives none', () => {
    expect(versionPrefixes('4871')).toEqual([])
    expect(versionPrefixes('')).toEqual([])
    expect(versionPrefixes('1..6')).toEqual([])
  })

  test('the default branch gets the bare prefixes', () => {
    const tags = tagsFor({
      version: '1.6.4871', branch: 'public', variant: 'linux',
      defaultBranch: true, defaultVariant: true,
    })
    expect(tags).toEqual(expect.arrayContaining(['1', '1-linux', '1.6', '1.6-linux']))
  })

  // two branches on one repo must not both claim "1.6"
  test('another branch scopes its prefixes by name', () => {
    const tags = tagsFor({
      version: '2.0.5000', branch: 'beta', variant: 'linux',
      defaultBranch: false, defaultVariant: true,
    })
    expect(tags).toEqual(expect.arrayContaining(['2-beta', '2.0-beta', '2.0-beta-linux']))
    expect(tags).not.toContain('2.0')
    expect(tags).not.toContain('2')
  })

  test('a non-default variant gets only the suffixed prefix', () => {
    const tags = tagsFor({
      version: '1.6.4871', branch: 'public', variant: 'windows',
      defaultBranch: true, defaultVariant: false,
    })
    expect(tags).toContain('1.6-windows')
    expect(tags).not.toContain('1.6')
  })
})
