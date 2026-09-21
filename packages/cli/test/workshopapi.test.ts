import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkDrift } from '../src/mods/workshopapi'

const INSTALLED = 1752434318

let tmp = ''

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-workshopapi-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Tabs are what steam writes, and the text goes through the real parser in `mods/acf.ts`. */
function acfText(items: Record<string, number>): string {
  const entries = Object.entries(items)
    .map(
      ([id, timeupdated]) =>
        `\t\t"${id}"\n\t\t{\n\t\t\t"timeupdated"\t\t"${timeupdated}"\n\t\t\t"manifest"\t\t"1025052661578487222"\n\t\t}`,
    )
    .join('\n')
  return `"AppWorkshop"\n{\n\t"appid"\t\t"294100"\n\t"WorkshopItemsInstalled"\n\t{\n${entries}\n\t}\n}\n`
}

/**
 * A workshop tree: the .acf steamcmd writes, plus a content directory per id in `onDisk`.
 * Returns the content root, one of the two `downloadRoots` hands `checkDrift`.
 */
async function tree(items: Record<string, number>, onDisk: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmp, 'workshop-'))
  await writeFile(join(dir, 'appworkshop_294100.acf'), acfText(items))
  const root = join(dir, 'content', '294100')
  await mkdir(root, { recursive: true })
  for (const id of onDisk) await mkdir(join(root, id))
  return root
}

type Detail = { publishedfileid: string; result: number; time_updated: number }

function ok(details: Detail[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ response: { publishedfiledetails: details } }))) as unknown as typeof fetch
}

function detail(id: string, timeUpdated: number, result = 1): Detail {
  return { publishedfileid: id, result, time_updated: timeUpdated }
}

describe('checkDrift', () => {
  test('an unchanged item needs nothing', async () => {
    const root = await tree({ '818773962': INSTALLED }, ['818773962'])
    const report = await checkDrift(['818773962'], [root], ok([detail('818773962', INSTALLED)]))
    expect(report).toEqual({ needed: [], warnings: [] })
  })

  test('a drifted item is queued', async () => {
    const root = await tree({ '818773962': INSTALLED }, ['818773962'])
    const report = await checkDrift(['818773962'], [root], ok([detail('818773962', INSTALLED + 60)]))
    expect(report).toEqual({ needed: ['818773962'], warnings: [] })
  })

  test('an id the .acf never heard of is queued', async () => {
    const root = await tree({ '818773962': INSTALLED }, ['818773962', '2009463077'])
    const report = await checkDrift(
      ['818773962', '2009463077'],
      [root],
      ok([detail('818773962', INSTALLED), detail('2009463077', INSTALLED)]),
    )
    expect(report).toEqual({ needed: ['2009463077'], warnings: [] })
  })

  test('an id in the .acf with no directory is queued', async () => {
    const root = await tree({ '818773962': INSTALLED, '2009463077': INSTALLED }, ['818773962'])
    const report = await checkDrift(
      ['818773962', '2009463077'],
      [root],
      ok([detail('818773962', INSTALLED), detail('2009463077', INSTALLED)]),
    )
    expect(report).toEqual({ needed: ['2009463077'], warnings: [] })
  })

  test('a result other than 1 warns and is not queued', async () => {
    const root = await tree({ '818773962': INSTALLED }, ['818773962'])
    const report = await checkDrift(['818773962', '404'], [root], ok([detail('818773962', INSTALLED), detail('404', 0, 9)]))
    expect(report.needed).toEqual([])
    expect(report.warnings).toEqual(['workshop item 404 is not available (result 9); skipping it'])
  })

  test('101 ids go out as two requests', async () => {
    const ids = Array.from({ length: 101 }, (_, n) => String(900000 + n))
    const root = await tree(Object.fromEntries(ids.map((id) => [id, INSTALLED])), ids)
    const bodies: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return new Response(JSON.stringify({ response: { publishedfiledetails: [] } }))
    }) as unknown as typeof fetch

    const report = await checkDrift(ids, [root], fetchImpl)

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('itemcount=100')
    expect(bodies[0]).toContain('publishedfileids%5B99%5D=900099')
    expect(bodies[1]).toContain('itemcount=1')
    expect(bodies[1]).toContain('publishedfileids%5B0%5D=900100')
    expect(report).toEqual({ needed: [], warnings: [] })
  })

  test('a request that never answers falls back to the missing items at 5s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const root = await tree({ '818773962': INSTALLED }, ['818773962'])
    let started = (): void => {}
    const sent = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetchImpl = ((_url: string, init: RequestInit) => {
      started()
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }) as unknown as typeof fetch

    const report = checkDrift(['818773962', '2009463077'], [root], fetchImpl)
    await sent
    vi.advanceTimersByTime(5000)

    expect(await report).toEqual({
      needed: ['2009463077'],
      warnings: ['could not ask steam which items changed (no answer in 5000ms); only missing items will download'],
    })
    vi.useRealTimers()
  })

  test('a non-200 falls back to the missing items', async () => {
    const root = await tree({ '818773962': INSTALLED }, ['818773962'])
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const report = await checkDrift(['818773962', '2009463077'], [root], fetchImpl)
    expect(report.needed).toEqual(['2009463077'])
    expect(report.warnings).toEqual([
      'could not ask steam which items changed (steam answered 503); only missing items will download',
    ])
  })

  test('an item installed in the second root only is installed', async () => {
    const host = await tree({ '111': INSTALLED }, ['111'])
    const docker = await tree({ '818773962': INSTALLED }, ['818773962'])
    const report = await checkDrift(['818773962'], [host, docker], ok([detail('818773962', INSTALLED)]))
    expect(report).toEqual({ needed: [], warnings: [] })
  })

  test('an item in both roots is compared against the copy the first root holds', async () => {
    const older = await tree({ '818773962': INSTALLED }, ['818773962'])
    const newer = await tree({ '818773962': INSTALLED + 60 }, ['818773962'])
    const steam = ok([detail('818773962', INSTALLED + 60)])
    expect(await checkDrift(['818773962'], [older, newer], steam)).toEqual({
      needed: ['818773962'],
      warnings: [],
    })
    expect(await checkDrift(['818773962'], [newer, older], steam)).toEqual({ needed: [], warnings: [] })
  })

  test('a root with no .acf is skipped rather than failing the check', async () => {
    const real = await tree({ '818773962': INSTALLED }, ['818773962'])
    const absent = join(tmp, 'never-downloaded', 'content', '294100')
    const report = await checkDrift(['818773962'], [absent, real], ok([detail('818773962', INSTALLED)]))
    expect(report).toEqual({ needed: [], warnings: [] })
  })

  test('an item on disk in the second root only is not queued', async () => {
    const host = await tree({ '818773962': INSTALLED }, [])
    const docker = await tree({}, ['818773962'])
    const report = await checkDrift(['818773962'], [host, docker], ok([detail('818773962', INSTALLED)]))
    expect(report).toEqual({ needed: [], warnings: [] })
  })

  test('a body this does not understand falls back to the missing items', async () => {
    const root = await tree({ '818773962': INSTALLED }, ['818773962'])
    const fetchImpl = (async () => new Response('<html>steam is sad</html>')) as unknown as typeof fetch
    const report = await checkDrift(['818773962', '2009463077'], [root], fetchImpl)
    expect(report.needed).toEqual(['2009463077'])
    expect(report.warnings).toHaveLength(1)
  })
})
