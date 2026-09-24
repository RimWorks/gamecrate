import { describe, expect, test } from 'vitest'
import { sanitizeVersion, tagsFor } from '../src/image/tags'

describe('sanitizeVersion', () => {
  test('keeps the first field of a rimworld version line', () => {
    expect(sanitizeVersion('1.6.4871 rev598', 'x')).toBe('1.6.4871')
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
    ])
  })

  test('a non-default variant on the default branch gets no bare form', () => {
    expect(tagsFor({ ...base, variant: 'windows', defaultBranch: true, defaultVariant: false })).toEqual([
      '1.6.4871-windows',
      'latest-windows',
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
    expect(tags).toEqual(['1.5.4409-1.5-linux-ref', 'latest-1.5-linux-ref'])
  })

  test('versioned forms come before latest forms', () => {
    const tags = tagsFor({ ...base, defaultBranch: true, defaultVariant: true })
    const firstLatest = tags.findIndex((t) => t.startsWith('latest'))
    const lastVersioned = tags.map((t) => !t.startsWith('latest')).lastIndexOf(true)
    expect(lastVersioned).toBeLessThan(firstLatest)
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
