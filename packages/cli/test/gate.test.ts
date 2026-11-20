import { describe, expect, test } from 'bun:test'

import { decideGate } from '../src/image/gate'

const current = { published: '19283746', imagePresent: true, labelled: '19283746', force: false }

describe('decideGate', () => {
  test('a matching buildid skips', () => {
    expect(decideGate(current)).toEqual({ build: false, reason: 'up-to-date' })
  })

  test('a moved buildid builds', () => {
    expect(decideGate({ ...current, published: '19283747' })).toEqual({
      build: true,
      reason: 'buildid-changed',
    })
  })

  test('no image at all builds', () => {
    expect(decideGate({ ...current, imagePresent: false, labelled: null })).toEqual({
      build: true,
      reason: 'no-image',
    })
  })

  test('an absent image beats a label left over from an earlier read', () => {
    expect(decideGate({ ...current, imagePresent: false })).toEqual({
      build: true,
      reason: 'no-image',
    })
  })

  test('an image with no steam.buildid label builds', () => {
    expect(decideGate({ ...current, labelled: null })).toEqual({ build: true, reason: 'no-label' })
  })

  test('steam refusing to say builds rather than skips', () => {
    expect(decideGate({ ...current, published: null })).toEqual({
      build: true,
      reason: 'unknown-published',
    })
  })

  test('steam listing no depots keeps an image that exists, labelled or not', () => {
    expect(decideGate({ ...current, published: null, noDepots: true })).toEqual({
      build: false,
      reason: 'steam-named-no-depots',
    })
    expect(decideGate({ ...current, published: null, labelled: null, noDepots: true })).toEqual({
      build: false,
      reason: 'steam-named-no-depots',
    })
  })

  test('steam listing no depots still builds when there is no image to keep', () => {
    expect(decideGate({ published: null, imagePresent: false, labelled: null, force: false, noDepots: true })).toEqual({
      build: true,
      reason: 'no-image',
    })
  })

  test('force beats a steam that listed no depots', () => {
    expect(decideGate({ ...current, published: null, force: true, noDepots: true })).toEqual({
      build: true,
      reason: 'forced',
    })
  })

  test('force beats a match', () => {
    expect(decideGate({ ...current, force: true })).toEqual({ build: true, reason: 'forced' })
  })

  test('force is reported even when another case also applied', () => {
    expect(decideGate({ published: null, imagePresent: false, labelled: null, force: true })).toEqual({
      build: true,
      reason: 'forced',
    })
  })

  test('up-to-date is the only decision that does not build', () => {
    const inputs = [
      { published: '1', imagePresent: true, labelled: '1', force: false },
      { published: '1', imagePresent: true, labelled: '2', force: false },
      { published: '1', imagePresent: true, labelled: null, force: false },
      { published: '1', imagePresent: false, labelled: null, force: false },
      { published: '1', imagePresent: false, labelled: '1', force: false },
      { published: null, imagePresent: true, labelled: '1', force: false },
      { published: null, imagePresent: true, labelled: null, force: false },
      { published: null, imagePresent: false, labelled: null, force: false },
    ]
    const skipped = inputs.map(decideGate).filter((d) => !d.build)
    expect(skipped).toEqual([{ build: false, reason: 'up-to-date' }])
  })
})
