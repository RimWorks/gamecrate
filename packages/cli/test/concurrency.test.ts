import { describe, expect, test } from 'bun:test'
import { mapLimit } from '../src/concurrency'

describe('mapLimit', () => {
  test('returns results in input order, not completion order', async () => {
    const items = [40, 30, 20, 10, 0]
    const out = await mapLimit(items, async (ms) => {
      await Bun.sleep(ms)
      return ms
    })
    expect(out).toEqual(items)
  })

  test('never runs more than the lane count at once', async () => {
    let live = 0
    let peak = 0
    await mapLimit(
      Array.from({ length: 20 }, (_, n) => n),
      async () => {
        live++
        peak = Math.max(peak, live)
        await Bun.sleep(5)
        live--
      },
      3,
    )
    expect(peak).toBe(3)
  })

  test('visits every item exactly once', async () => {
    const seen: number[] = []
    await mapLimit(Array.from({ length: 50 }, (_, n) => n), async (n) => void seen.push(n), 7)
    expect(seen).toHaveLength(50)
    expect(new Set(seen).size).toBe(50)
  })

  test('an empty list runs nothing', async () => {
    let ran = false
    expect(await mapLimit([], async () => void (ran = true))).toEqual([])
    expect(ran).toBe(false)
  })

  test('a rejection propagates', async () => {
    const boom = mapLimit([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    await expect(boom).rejects.toThrow('boom')
  })
})
