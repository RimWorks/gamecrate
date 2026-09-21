import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  STEAMCMD_IMAGE,
  downloadRoot,
  resolveSteamcmd,
  steamHome,
  workshopUrlId,
} from '../src/mods/steamcmd'
import { Exit } from '../src/types'
import type { GameConfig, GamecrateError, RootConfig } from '../src/types'

let tmp = ''
const realPath = process.env.PATH

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-steamcmd-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

afterEach(() => {
  process.env.PATH = realPath
})

/** An executable stub called `name` in its own directory, which is returned. */
async function binDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmp, 'bin-'))
  const path = join(dir, name)
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
  return dir
}

function config(over: Partial<RootConfig> = {}): RootConfig {
  return { dataRoot: join(tmp, 'data'), games: {}, ...over }
}

describe('downloadRoot', () => {
  test('is the steamcmd layout under the data root', async () => {
    await mkdir(join(tmp, 'data'), { recursive: true })
    const game = { steamAppId: 294100 } as GameConfig
    expect(downloadRoot('/data', game)).toBe('/data/steam/.steam/SteamApps/workshop/content/294100')
    expect(steamHome('/data')).toBe('/data/steam')
  })
})

describe('resolveSteamcmd', () => {
  test('prefers the configured path', async () => {
    const dir = await binDir('steamcmd')
    process.env.PATH = await binDir('steamcmd')
    const runner = resolveSteamcmd(config({ steamcmd: { path: join(dir, 'steamcmd') } }))
    expect(runner).toEqual({
      kind: 'host',
      argv: [join(dir, 'steamcmd')],
      env: { HOME: join(tmp, 'data', 'steam') },
    })
  })

  test('expands ~ in the configured path', async () => {
    const dir = await binDir('steamcmd')
    process.env.PATH = await binDir('steamcmd')
    const realHome = process.env.HOME
    process.env.HOME = dir
    try {
      const runner = resolveSteamcmd(config({ steamcmd: { path: '~/steamcmd' } }))
      expect(runner.argv).toEqual([join(dir, 'steamcmd')])
    } finally {
      process.env.HOME = realHome
    }
  })

  test('falls back to steamcmd on PATH when no path is configured', async () => {
    const dir = await binDir('steamcmd')
    process.env.PATH = dir
    const runner = resolveSteamcmd(config())
    expect(runner).toEqual({
      kind: 'host',
      argv: [join(dir, 'steamcmd')],
      env: { HOME: join(tmp, 'data', 'steam') },
    })
  })

  test('refuses a configured path that is missing', async () => {
    process.env.PATH = await binDir('steamcmd')
    const missing = join(tmp, 'nope', 'steamcmd')
    let thrown: GamecrateError | undefined
    try {
      resolveSteamcmd(config({ steamcmd: { path: missing } }))
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.message).toContain(missing)
  })

  test('refuses a configured path that is a directory', async () => {
    const dir = await binDir('steamcmd')
    process.env.PATH = dir
    let thrown: GamecrateError | undefined
    try {
      resolveSteamcmd(config({ steamcmd: { path: dir } }))
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.message).toContain(dir)
  })

  test('falls back to docker, mapping the host user onto the bind', async () => {
    const dir = await binDir('docker')
    process.env.PATH = dir
    const runner = resolveSteamcmd(config())
    const home = join(tmp, 'data', 'steam')
    expect(runner.kind).toBe('docker')
    expect(runner.argv).toEqual([
      'docker', 'run', '--rm',
      '--user', `${process.getuid?.()}:${process.getgid?.()}`,
      '-v', `${home}:${home}`,
      '-e', `HOME=${home}`,
      STEAMCMD_IMAGE,
    ])
    expect(existsSync(home)).toBe(true)
  })

  test('names all three places when none resolve', async () => {
    process.env.PATH = join(tmp, 'empty')
    let thrown: GamecrateError | undefined
    try {
      resolveSteamcmd(config())
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.detail).toContain('steamcmd.path')
    expect(thrown?.detail).toContain('PATH')
    expect(thrown?.detail).toContain(STEAMCMD_IMAGE)
  })
})

describe('workshopUrlId', () => {
  const cases: [string | undefined, string | undefined][] = [
    ['https://steamcommunity.com/sharedfiles/filedetails/?id=818773962', '818773962'],
    ['https://www.steamcommunity.com/workshop/filedetails/?id=12', '12'],
    ['https://steamcommunity.com/sharedfiles/filedetails/?searchtext=a&id=77', '77'],
    ['https://steamcommunity.com/sharedfiles/filedetails/?id=77&searchtext=a', '77'],
    ['https://steamcommunity.com/sharedfiles/filedetails/?id=abc', undefined],
    ['https://steamcommunity.com/sharedfiles/filedetails/?id=12a', undefined],
    ['https://steamcommunity.com/sharedfiles/filedetails/', undefined],
    ['https://example.com/sharedfiles/filedetails/?id=818773962', undefined],
    ['https://notsteamcommunity.com/?id=1', undefined],
    ['not a url at all', undefined],
    ['', undefined],
    [undefined, undefined],
  ]

  test.each(cases)('%s -> %s', (url, expected) => {
    expect(workshopUrlId(url)).toBe(expected)
  })
})
