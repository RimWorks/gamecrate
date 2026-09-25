import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// bun's os.homedir() snapshots at process start and ignores a later HOME, unlike node's.
const realOs = { ...(await import('node:os')) }
const os = { ...realOs, homedir: () => process.env.HOME ?? realOs.homedir() }
await mock.module('node:os', () => ({ ...os, default: os }))

const {
  STEAMCMD_IMAGE,
  downloadItems,
  downloadRoot,
  removeDownloads,
  resolveSteamcmd,
  steamHome,
  workshopUrlId,
} = await import('../src/mods/steamcmd')
const { Exit } = await import('../src/types')
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
  const game = { steamAppId: 294100 } as GameConfig

  test('is the pinned layout under the steam home', () => {
    expect(downloadRoot('/data', game)).toBe('/data/steam/steamapps/workshop/content/294100')
    expect(steamHome('/data')).toBe('/data/steam')
  })

  test('does not consult the filesystem', async () => {
    const root = await mkdtemp(join(tmp, 'layout-'))
    expect(downloadRoot(root, game)).toBe(join(steamHome(root), 'steamapps/workshop/content/294100'))
  })
})

describe('removeDownloads', () => {
  const game = { steamAppId: 294100 } as GameConfig

  /** A tree with two items, the acf beside them, and a steamcmd install above both. */
  async function tree(): Promise<{ data: string; root: string; acf: string; install: string }> {
    const data = await mkdtemp(join(tmp, 'dl-rm-'))
    const root = downloadRoot(data, game)
    for (const id of ['111', '222']) await mkdir(join(root, id, 'About'), { recursive: true })
    const acf = join(steamHome(data), 'steamapps', 'workshop', 'appworkshop_294100.acf')
    await writeFile(acf, '"AppWorkshop"\n{\n}\n')
    const install = join(steamHome(data), 'steamcmd', 'linux32')
    await mkdir(install, { recursive: true })
    await writeFile(join(install, 'steamcmd'), 'binary')
    return { data, root, acf, install }
  }

  test('drops the items and the acf, and keeps the steamcmd install', async () => {
    const t = await tree()
    const said = await removeDownloads(t.root, 294100)

    expect(said).toBe(`removed ${t.root} (2 item(s))`)
    expect(existsSync(t.root)).toBe(false)
    expect(existsSync(t.acf)).toBe(false)
    // 200MB of bootstrap: deleting it means the next launch re-downloads steamcmd for nothing
    expect(existsSync(join(t.install, 'steamcmd'))).toBe(true)
  })

  test('says so rather than throwing when there is nothing there', async () => {
    const data = await mkdtemp(join(tmp, 'dl-none-'))
    const root = downloadRoot(data, game)
    expect(await removeDownloads(root, 294100)).toBe(`no workshop downloads at ${root}`)
  })

  test('leaves another game\'s acf alone', async () => {
    const t = await tree()
    const other = join(steamHome(t.data), 'steamapps', 'workshop', 'appworkshop_123456.acf')
    await writeFile(other, 'x')
    await removeDownloads(t.root, 294100)
    expect(existsSync(other)).toBe(true)
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
    expect(existsSync(home)).toBe(false)
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
    // the form 251 of 323 real About.xml dependencies use
    ['steam://url/CommunityFilePage/818773962', '818773962'],
    ['steam://url/communityfilepage/12', '12'],
    ['  steam://url/CommunityFilePage/77  ', '77'],
    ['steam://url/CommunityFilePage/', undefined],
    ['steam://url/CommunityFilePage/12a', undefined],
    ['steam://url/CommunityFilePage/1/2', undefined],
    ['steam://url/StoreAppPage/3022790', undefined],
    ['https://store.steampowered.com/app/3022790', undefined],
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

describe('downloadItems', () => {
  const FAKE = fileURLToPath(new URL('./fixtures/fake-steamcmd.sh', import.meta.url))
  const game = { steamAppId: 294100 } as GameConfig
  /** Where the fake writes, which is the host layout. */
  const hostRoot = (root: string): string => downloadRoot(root, game)
  const fakeEnv = ['FAKE_FAIL_IDS', 'FAKE_SKIP_IDS', 'FAKE_FLAKY_IDS', 'FAKE_BYTES', 'FAKE_EXIT']

  afterEach(() => {
    for (const key of fakeEnv) delete process.env[key]
  })

  /** A data root of its own, wired to the fake, so the tests never touch the network. */
  async function fake(path = FAKE): Promise<{ root: string; cfg: RootConfig }> {
    const root = await mkdtemp(join(tmp, 'dl-'))
    return { root, cfg: { dataRoot: root, games: {}, steamcmd: { path } } }
  }

  test('pins the install dir, and does it before login', async () => {
    const { root, cfg } = await fake()
    await downloadItems(cfg, game, root, ['111'])
    const argv = (await readFile(join(steamHome(root), 'argv.txt'), 'utf8')).trim().split(/\s+/)
    expect(argv).toContain('+force_install_dir')
    expect(argv[argv.indexOf('+force_install_dir') + 1]).toBe(steamHome(root))
    expect(argv.indexOf('+force_install_dir')).toBeLessThan(argv.indexOf('+login'))
  })

  test('parses items out of jammed, coloured output', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_BYTES = '2463770'
    const report = await downloadItems(cfg, game, root, ['818773962', '777'])

    expect(report.warnings).toEqual([])
    expect(report.items.get('818773962')).toEqual({
      ok: true,
      dir: join(hostRoot(root), '818773962'),
      bytes: 2463770,
    })
    expect(report.items.get('777')).toEqual({
      ok: true,
      dir: join(hostRoot(root), '777'),
      bytes: 2463770,
    })
    expect(existsSync(join(hostRoot(root), '777', 'About', 'About.xml'))).toBe(true)
  })

  test('an id the output never mentions is a failure', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_SKIP_IDS = '777'
    const report = await downloadItems(cfg, game, root, ['818773962', '777'])

    expect(report.items.get('818773962')?.ok).toBe(true)
    expect(report.items.get('777')).toEqual({ ok: false, reason: 'steamcmd reported nothing for it' })
    expect(report.warnings).toEqual(['could not download workshop item 777: steamcmd reported nothing for it'])
  })

  test('an ERROR! line is a warning, and the rest still land', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_FAIL_IDS = '777'
    const report = await downloadItems(cfg, game, root, ['818773962', '777'])

    expect(report.items.get('818773962')?.ok).toBe(true)
    expect(report.items.get('777')).toEqual({ ok: false, reason: 'Failure' })
    expect(report.warnings).toEqual(['could not download workshop item 777: Failure'])
  })

  test('a non-zero exit with every item downloaded is a success', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_EXIT = '7'
    const report = await downloadItems(cfg, game, root, ['818773962'])

    expect(report.warnings).toEqual([])
    expect(report.items.get('818773962')?.ok).toBe(true)
  })

  test('locks the steam home while steamcmd runs', async () => {
    const { root, cfg } = await fake()
    await downloadItems(cfg, game, root, ['777'])
    // the fake records what it saw, because the lock is gone by the time this test can look
    expect(existsSync(join(steamHome(root), 'lock-seen'))).toBe(true)
    expect(existsSync(`${steamHome(root)}.lock`)).toBe(false)
  })

  test('releases the lock when the spawn throws', async () => {
    const broken = join(await mkdtemp(join(tmp, 'broken-')), 'steamcmd')
    await writeFile(broken, '#!/nonexistent/sh\n')
    await chmod(broken, 0o755)
    const { root, cfg } = await fake(broken)

    await expect(downloadItems(cfg, game, root, ['777'])).rejects.toThrow(/could not run steamcmd/)
    expect(existsSync(`${steamHome(root)}.lock`)).toBe(false)
  })

  test('retries an id that failed transiently', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_FLAKY_IDS = '777'
    const report = await downloadItems(cfg, game, root, ['818773962', '777'])

    expect(report.warnings).toEqual([])
    expect(report.items.get('777')?.ok).toBe(true)
  })

  test('no ids never spawns anything', async () => {
    const { root, cfg } = await fake(join(tmp, 'missing-steamcmd'))
    const report = await downloadItems(cfg, game, root, [])
    expect(report.items.size).toBe(0)
  })
})
