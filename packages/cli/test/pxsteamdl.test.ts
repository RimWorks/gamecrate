import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { downloadWithPxsteamdl, resolvePxsteamdl } from '../src/mods/pxsteamdl'
import { downloadRoot, steamHome } from '../src/mods/steamcmd'
import { setLanes } from '../src/concurrency'
import { Exit } from '../src/types'
import type { GameConfig, GamecrateError, RootConfig } from '../src/types'

const FAKE = fileURLToPath(new URL('./fixtures/fake-pxsteamdl.sh', import.meta.url))
const game = { steamAppId: 294100 } as GameConfig
const fakeEnv = ['FAKE_FAIL_IDS', 'FAKE_SKIP_IDS', 'FAKE_DELAY_MS', 'FAKE_EXIT', 'FAKE_ARGV_FILE']

let tmp = ''
const realPath = process.env.PATH

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-px-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

afterEach(() => {
  process.env.PATH = realPath
  for (const key of fakeEnv) delete process.env[key]
  setLanes(undefined)
})

async function fake(): Promise<string> {
  return await mkdtemp(join(tmp, 'dl-'))
}

function config(over: Partial<RootConfig> = {}): RootConfig {
  return { dataRoot: join(tmp, 'data'), games: {}, ...over }
}

describe('resolvePxsteamdl', () => {
  test('a configured executable wins', () => {
    expect(resolvePxsteamdl(config({ pxsteamdl: { path: FAKE } }))).toBe(FAKE)
  })

  test('a configured path that is not executable is an environment error, never a fallback', () => {
    const miss = join(tmp, 'not-there')
    try {
      resolvePxsteamdl(config({ pxsteamdl: { path: miss } }))
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as GamecrateError).code).toBe(Exit.Environment)
      expect((error as Error).message).toContain(miss)
    }
  })

  test('nothing configured and nothing on PATH hands the download back to steamcmd', () => {
    process.env.PATH = join(tmp, 'empty-bin')
    expect(resolvePxsteamdl(config())).toBeUndefined()
  })

  test('an executable on PATH is found', async () => {
    const dir = await mkdtemp(join(tmp, 'bin-'))
    const path = join(dir, 'pxsteamdl')
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    process.env.PATH = dir
    expect(resolvePxsteamdl(config())).toBe(path)
  })
})

describe('downloadWithPxsteamdl', () => {
  test('writes into the same layout steamcmd uses', async () => {
    const root = await fake()
    const report = await downloadWithPxsteamdl(FAKE, game, root, ['818773962'])

    expect(report.items.get('818773962')?.ok).toBe(true)
    expect(existsSync(join(downloadRoot(root, game), '818773962', 'About', 'About.xml'))).toBe(true)
  })

  test('passes the lane count, and every id after a --', async () => {
    const root = await fake()
    setLanes(8)
    process.env.FAKE_ARGV_FILE = join(root, 'px-argv.txt')
    await downloadWithPxsteamdl(FAKE, game, root, ['111', '222'])
    const argv = (await readFile(join(root, 'px-argv.txt'), 'utf8')).trim().split(/\s+/)

    expect(argv[argv.indexOf('-j') + 1]).toBe('8')
    expect(argv[argv.indexOf('-o') + 1]).toBe(downloadRoot(root, game))
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['111', '222'])
  })

  test('a failed line is a warning, and the rest still land', async () => {
    const root = await fake()
    process.env.FAKE_FAIL_IDS = '777'
    const report = await downloadWithPxsteamdl(FAKE, game, root, ['818773962', '777'])

    expect(report.items.get('818773962')?.ok).toBe(true)
    expect(report.items.get('777')?.ok).toBe(false)
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toContain('777')
    expect(report.warnings[0]).toContain('EResult 9')
  })

  test('an id the output never mentions is a failure', async () => {
    const root = await fake()
    process.env.FAKE_SKIP_IDS = '777'
    const report = await downloadWithPxsteamdl(FAKE, game, root, ['818773962', '777'])

    expect(report.items.get('777')).toEqual({ ok: false, reason: 'pxsteamdl reported nothing for it' })
  })

  test('every id settles on the board, and a failure carries its reason', async () => {
    const root = await fake()
    process.env.FAKE_FAIL_IDS = '777'
    const planned: string[] = []
    const cells: { id: string; state: string; detail?: string }[] = []
    await downloadWithPxsteamdl(FAKE, game, root, ['818773962', '777'], {
      onPlan: (tasks) => planned.push(...tasks.map((t) => t.id)),
      onCell: (id, patch) => cells.push({ id, ...patch }),
    })

    expect(planned).toEqual([])
    expect(cells).toContainEqual({ id: '818773962', state: 'done' })
    expect(cells).toContainEqual({
      id: '777',
      state: 'failed',
      detail: 'Steam rejected the item: not found (EResult 9)',
    })
  })

  test('a row goes running once its directory appears, before the run ends', async () => {
    const root = await fake()
    process.env.FAKE_DELAY_MS = '900'
    const order: string[] = []
    await downloadWithPxsteamdl(FAKE, game, root, ['818773962'], {
      onPlan: () => {},
      onCell: (id, patch) => order.push(`${id}:${patch.state}`),
    })

    expect(order).toEqual(['818773962:running', '818773962:done'])
  })

  test('an empty list spawns nothing', async () => {
    const root = await fake()
    process.env.FAKE_ARGV_FILE = join(root, 'px-argv.txt')
    const report = await downloadWithPxsteamdl(FAKE, game, root, [])

    expect(report.items.size).toBe(0)
    expect(existsSync(join(root, 'px-argv.txt'))).toBe(false)
  })

  test('releases the lock when the spawn throws', async () => {
    const root = await fake()
    const broken = join(await mkdtemp(join(tmp, 'broken-')), 'pxsteamdl')
    await writeFile(broken, '#!/nonexistent/sh\n')
    await chmod(broken, 0o755)

    await expect(downloadWithPxsteamdl(broken, game, root, ['777'])).rejects.toThrow(/could not run pxsteamdl/)
    expect(existsSync(`${steamHome(root)}.lock`)).toBe(false)
  })
})
