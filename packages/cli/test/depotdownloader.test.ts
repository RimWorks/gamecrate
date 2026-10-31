import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  depotDownloaderEnv, downloadAppWithDepotDownloader, findDepotDownloaderToken, resolveDepotDownloader,
  seedDepotDownloaderToken,
} from '../src/mods/depotdownloader'
import { appDownloadRoot, steamHome } from '../src/mods/steamcmd'
import { Exit } from '../src/types'
import type { GamecrateError, RootConfig } from '../src/types'

const FAKE = fileURLToPath(new URL('./fixtures/fake-depotdownloader.sh', import.meta.url))
const fakeEnv = [
  'FAKE_NO_TOKEN', 'FAKE_TOKEN_REJECTED', 'FAKE_LOGIN_FAIL', 'FAKE_BRANCH_FAIL', 'FAKE_NOT_OWNED', 'FAKE_EXIT',
]

let tmp = ''
const realPath = process.env.PATH

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-dd-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.STEAM_USERNAME = 'tester'
})

afterEach(() => {
  process.env.PATH = realPath
  delete process.env.STEAM_USERNAME
  for (const key of fakeEnv) delete process.env[key]
})

function config(over: Partial<RootConfig> = {}): RootConfig {
  return { dataRoot: join(tmp, 'data'), games: {}, ...over }
}

async function fake(): Promise<{ root: string; cfg: RootConfig }> {
  const root = await mkdtemp(join(tmp, 'app-'))
  return { root, cfg: { dataRoot: root, games: {}, depotdownloader: { path: FAKE } } }
}

async function recordedArgv(root: string): Promise<string> {
  return (await readFile(join(steamHome(root), 'argv.txt'), 'utf8')).trim()
}

async function failure(fn: () => Promise<unknown>): Promise<GamecrateError> {
  try {
    await fn()
  } catch (error) {
    return error as GamecrateError
  }
  throw new Error('expected a throw')
}

describe('resolveDepotDownloader', () => {
  test('a configured executable wins', () => {
    expect(resolveDepotDownloader(config({ depotdownloader: { path: FAKE } }))).toBe(FAKE)
  })

  test('a configured path that is not executable is an environment error, never a fallback', () => {
    const miss = join(tmp, 'not-there')
    try {
      resolveDepotDownloader(config({ depotdownloader: { path: miss } }))
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as GamecrateError).code).toBe(Exit.Environment)
      expect((error as Error).message).toContain(miss)
    }
  })

  test('nothing configured and nothing on PATH hands the download back to steamcmd', () => {
    process.env.PATH = join(tmp, 'empty-bin')
    expect(resolveDepotDownloader(config())).toBeUndefined()
  })

  test('an executable on PATH is found', async () => {
    const dir = await mkdtemp(join(tmp, 'bin-'))
    const path = join(dir, 'depotdownloader')
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    process.env.PATH = dir
    expect(resolveDepotDownloader(config())).toBe(path)
  })
})

describe('downloadAppWithDepotDownloader', () => {
  test('downloads into the directory steamcmd would have used, with the account and branch', async () => {
    const { root, cfg } = await fake()
    const out = await downloadAppWithDepotDownloader(FAKE, cfg, { steamAppId: 294100, branch: '1.5', dataRoot: root })
    expect(out.dir).toBe(appDownloadRoot(root, 294100, '1.5'))
    expect(existsSync(join(out.dir, 'Version.txt'))).toBe(true)
    const argv = await recordedArgv(root)
    expect(argv).toContain('-username tester')
    expect(argv).toContain('-remember-password')
    expect(argv).toContain('-app 294100')
    expect(argv).toContain('-branch 1.5')
    expect(argv).toContain(`-dir ${out.dir}`)
    expect(argv).not.toContain('-os')
    expect(argv).not.toContain('-branchpassword')
  })

  test('a windows depot asks for the 64-bit windows depots', async () => {
    const { root, cfg } = await fake()
    const out = await downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'public', depot: 'windows', dataRoot: root,
    })
    expect(out.dir).toBe(appDownloadRoot(root, 294100, 'public', 'windows'))
    expect(await recordedArgv(root)).toContain('-os windows -osarch 64')
  })

  test('a branch password rides the argv, because depotdownloader has no other form', async () => {
    const { root, cfg } = await fake()
    await downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'private-beta', password: 'hunter2', dataRoot: root,
    })
    expect(await recordedArgv(root)).toContain('-branch private-beta -branchpassword hunter2')
  })

  test('the token store lives under the steam home, not the user home', async () => {
    const { root, cfg } = await fake()
    await downloadAppWithDepotDownloader(FAKE, cfg, { steamAppId: 294100, branch: 'public', dataRoot: root })
    const xdg = (await readFile(join(steamHome(root), 'xdg.txt'), 'utf8')).trim()
    expect(xdg).toBe(join(steamHome(root), '.local', 'share'))
    expect(depotDownloaderEnv(root)).toEqual({ HOME: steamHome(root), XDG_DATA_HOME: xdg })
  })

  test('a directory steamcmd filled is wiped whole before the first download', async () => {
    const { root, cfg } = await fake()
    const dir = appDownloadRoot(root, 294100, 'public')
    await mkdir(join(dir, 'steamapps', 'workshop', 'content'), { recursive: true })
    await writeFile(join(dir, 'steamapps', 'appmanifest_294100.acf'), '"AppState" {}\n')
    await mkdir(join(dir, 'RimWorldLinux_Data', 'Managed'), { recursive: true })
    await writeFile(join(dir, 'RimWorldLinux_Data', 'Managed', 'UnityEngine.dll'), 'stale')
    await downloadAppWithDepotDownloader(FAKE, cfg, { steamAppId: 294100, branch: 'public', dataRoot: root })
    expect(existsSync(join(dir, 'steamapps'))).toBe(false)
    expect(existsSync(join(dir, 'RimWorldLinux_Data'))).toBe(false)
    expect(existsSync(join(dir, 'Version.txt'))).toBe(true)
  })

  test('a directory depotdownloader already owns keeps its files for the delta', async () => {
    const { root, cfg } = await fake()
    const dir = appDownloadRoot(root, 294100, 'public')
    await mkdir(join(dir, '.DepotDownloader'), { recursive: true })
    await writeFile(join(dir, '.DepotDownloader', 'depot.config'), '')
    await mkdir(join(dir, 'Data', 'Core'), { recursive: true })
    await writeFile(join(dir, 'Data', 'Core', 'keep.txt'), 'current')
    await downloadAppWithDepotDownloader(FAKE, cfg, { steamAppId: 294100, branch: 'public', dataRoot: root })
    expect(existsSync(join(dir, 'Data', 'Core', 'keep.txt'))).toBe(true)
  })

  test('no stored login says to run steam login', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_NO_TOKEN = '1'
    const error = await failure(() => downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'public', dataRoot: root,
    }))
    expect(error.code).toBe(Exit.Environment)
    expect(error.message).toContain('tester')
    expect(error.detail).toContain('gamecrate steam login')
  })

  test('a rejected token says to run steam login', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_TOKEN_REJECTED = '1'
    const error = await failure(() => downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'public', dataRoot: root,
    }))
    expect(error.code).toBe(Exit.Environment)
    expect(error.detail).toContain('gamecrate steam login')
  })

  test('a steam that is down is worth a retry, not a login', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_LOGIN_FAIL = 'ServiceUnavailable'
    const error = await failure(() => downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'public', dataRoot: root,
    }))
    expect(error.code).toBe(Exit.Unavailable)
  })

  test('any other login failure says to run steam login', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_LOGIN_FAIL = 'AccountLogonDenied'
    const error = await failure(() => downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'public', dataRoot: root,
    }))
    expect(error.code).toBe(Exit.Environment)
    expect(error.detail).toContain('gamecrate steam login')
    expect(error.detail).toContain('AccountLogonDenied')
  })

  test('a bad branch or password names the branch', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_BRANCH_FAIL = '1'
    const error = await failure(() => downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'unstable', dataRoot: root,
    }))
    expect(error.code).toBe(Exit.Environment)
    expect(error.message).toContain('unstable')
    expect(error.detail).toContain('password')
  })

  test('an app the account does not own is named', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_NOT_OWNED = '1'
    const error = await failure(() => downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'public', dataRoot: root,
    }))
    expect(error.code).toBe(Exit.Environment)
    expect(error.message).toContain('294100')
    expect(error.message).toContain('tester')
  })

  test('an unexplained exit carries the code and the last lines', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_EXIT = '3'
    const error = await failure(() => downloadAppWithDepotDownloader(FAKE, cfg, {
      steamAppId: 294100, branch: 'public', dataRoot: root,
    }))
    expect(error.code).toBe(Exit.Environment)
    expect(error.message).toContain('exited 3')
    expect(error.detail).toContain('Total downloaded')
  })
})

describe('findDepotDownloaderToken', () => {
  test('finds account.config wherever isolated storage buried it', async () => {
    const root = await mkdtemp(join(tmp, 'token-'))
    const store = join(steamHome(root), '.local', 'share', 'IsolatedStorage', 'a.v24', 'b.z3n', 'Url.hash', 'AssemFiles')
    await mkdir(store, { recursive: true })
    await writeFile(join(store, 'account.config'), 'token\n')
    expect(findDepotDownloaderToken(root)).toBe(join(store, 'account.config'))
  })

  test('nothing stored is undefined', async () => {
    const root = await mkdtemp(join(tmp, 'token-'))
    expect(findDepotDownloaderToken(root)).toBeUndefined()
  })
})

describe('seedDepotDownloaderToken', () => {
  test('writes the secret where depotdownloader will look, at mode 0600', async () => {
    const { root, cfg } = await fake()
    const body = 'protobuf bytes'
    const path = seedDepotDownloaderToken(cfg, { DEPOTDOWNLOADER_ACCOUNT_B64: Buffer.from(body).toString('base64') })
    expect(path).toBe(findDepotDownloaderToken(root))
    expect(await readFile(path as string, 'utf8')).toBe(body)
    expect((await stat(path as string)).mode & 0o777).toBe(0o600)
    expect(await recordedArgv(root)).toBe('-V')
  })

  test('an unset variable seeds nothing', async () => {
    const { root, cfg } = await fake()
    expect(seedDepotDownloaderToken(cfg, {})).toBeUndefined()
    expect(findDepotDownloaderToken(root)).toBeUndefined()
  })

  test('a set variable with no depotdownloader installed is an environment error', async () => {
    const root = await mkdtemp(join(tmp, 'app-'))
    process.env.PATH = join(tmp, 'empty-bin')
    const cfg: RootConfig = { dataRoot: root, games: {} }
    let error: GamecrateError | undefined
    try {
      seedDepotDownloaderToken(cfg, { DEPOTDOWNLOADER_ACCOUNT_B64: 'eA==' })
    } catch (caught) {
      error = caught as GamecrateError
    }
    expect(error?.code).toBe(Exit.Environment)
    expect(error?.message).toContain('DEPOTDOWNLOADER_ACCOUNT_B64')
  })
})
