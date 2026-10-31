import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const built: { count: number; push?: boolean; load?: boolean } = { count: 0 }

const realOs = { ...(await import('node:os')) }
await mock.module('node:os', () => ({
  ...realOs,
  default: { ...realOs, homedir: () => process.env.HOME ?? realOs.homedir() },
  homedir: () => process.env.HOME ?? realOs.homedir(),
}))

await mock.module('../src/image/build', () => ({
  steamBuild: (_input: unknown, opts: { push: boolean; load: boolean }) => {
    built.count += 1
    built.push = opts.push
    built.load = opts.load
    return Promise.resolve([])
  },
}))

const realInput = { ...(await import('../src/image/input')) }
await mock.module('../src/image/input', () => ({
  ...realInput,
  resolveSteamBuildInput: () => Promise.resolve({}),
}))

const { resolveSession, sessionPaths, steamBuildCommand, steamLogin } = await import('../src/cli/steam')
import type { SteamContext } from '../src/cli/steam'
const { resolveImage } = await import('../src/image/input')
const { accountFile, steamHome } = await import('../src/mods/steamcmd')
const { findDepotDownloaderToken } = await import('../src/mods/depotdownloader')
const { useSink } = await import('../src/channels')
import { Exit, GamecrateError } from '../src/types'
import type { ParsedArgs, RootConfig } from '../src/types'

const FAKE_DD = fileURLToPath(new URL('./fixtures/fake-depotdownloader.sh', import.meta.url))
const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_PATH = process.env.PATH
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
})

afterEach(() => {
  built.count = 0
  delete built.push
  delete built.load
  delete process.env.STEAM_CONFIG_VDF
  delete process.env.STEAM_CONFIG_VDF_B64
  delete process.env.STEAM_USERNAME
  delete process.env.FAKE_NO_TOKEN
  delete process.env.DEPOTDOWNLOADER_ACCOUNT_B64
  process.env.PATH = ORIGINAL_PATH
})

function fails(run: () => unknown): GamecrateError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(GamecrateError)
    return error as GamecrateError
  }
  throw new Error('expected a GamecrateError')
}

function tree(fallback?: string): { config: RootConfig; home: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'gamecrate-steam-'))
  const home = join(root, 'home')
  if (fallback !== undefined) {
    mkdirSync(join(home, '.steam', 'config'), { recursive: true })
    writeFileSync(join(home, '.steam', 'config', 'config.vdf'), fallback)
  }
  process.env.HOME = home
  return {
    config: { dataRoot: join(root, 'data'), games: { rimworld: {} } } as unknown as RootConfig,
    home,
    env: {},
  }
}

function primeSteamHome(config: RootConfig, body: string): string {
  const path = join(steamHome(config.dataRoot), '.local', 'share', 'Steam', 'config', 'config.vdf')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

describe('resolveSession', () => {
  test('STEAM_CONFIG_VDF_B64 outranks both files on disk', () => {
    const { config } = tree('from-fallback')
    primeSteamHome(config, 'from-datadir')
    const path = resolveSession(config, { STEAM_CONFIG_VDF_B64: Buffer.from('from-env').toString('base64') })
    expect(path).toBe(join(steamHome(config.dataRoot), '.steam', 'config', 'config.vdf'))
    for (const seeded of sessionPaths(steamHome(config.dataRoot))) {
      expect(readFileSync(seeded, 'utf8')).toBe('from-env')
    }
  })

  test('STEAM_CONFIG_VDF_B64 outranks the file STEAM_CONFIG_VDF names', () => {
    const { config, home } = tree()
    const named = join(home, 'session.b64')
    mkdirSync(home, { recursive: true })
    writeFileSync(named, Buffer.from('from-file').toString('base64'))
    const path = resolveSession(config, {
      STEAM_CONFIG_VDF_B64: Buffer.from('from-env').toString('base64'),
      STEAM_CONFIG_VDF: named,
    })
    expect(readFileSync(path, 'utf8')).toBe('from-env')
  })

  test('STEAM_CONFIG_VDF reads base64 out of the file it names', () => {
    const { config, home } = tree('from-fallback')
    primeSteamHome(config, 'from-datadir')
    const named = join(home, 'session.b64')
    writeFileSync(named, `${Buffer.from('from-file').toString('base64')}\n`)
    const path = resolveSession(config, { STEAM_CONFIG_VDF: named })
    expect(path).toBe(join(steamHome(config.dataRoot), '.steam', 'config', 'config.vdf'))
    for (const seeded of sessionPaths(steamHome(config.dataRoot))) {
      expect(readFileSync(seeded, 'utf8')).toBe('from-file')
    }
  })

  test('STEAM_CONFIG_VDF takes a raw config.vdf as well', () => {
    const { config, home } = tree('from-fallback')
    const named = join(home, 'config.vdf')
    const raw = '"InstallConfigStore"\n{\n\t"Software" {}\n}\n'
    writeFileSync(named, raw)
    expect(readFileSync(resolveSession(config, { STEAM_CONFIG_VDF: named }), 'utf8')).toBe(raw)
  })

  test('a STEAM_CONFIG_VDF pointing nowhere fails instead of falling back', () => {
    const { config, home } = tree('from-fallback')
    const missing = join(home, 'absent.vdf')
    const error = fails(() => resolveSession(config, { STEAM_CONFIG_VDF: missing }))
    expect(error.code).toBe(Exit.Environment)
    expect(error.detail).toContain(missing)
  })

  test('a base64 session left in STEAM_CONFIG_VDF never reaches the error text', () => {
    const { config } = tree('from-fallback')
    const session = Buffer.from('"InstallConfigStore"\n{\n'.padEnd(600, ' ')).toString('base64')
    const error = fails(() => resolveSession(config, { STEAM_CONFIG_VDF: session }))
    expect(error.code).toBe(Exit.Environment)
    expect(`${error.message} ${error.detail}`).not.toContain(session.slice(0, 32))
    expect(error.detail).toContain('STEAM_CONFIG_VDF_B64')
  })

  test('an empty value in either variable is not a session', () => {
    const { config } = tree('from-fallback')
    const path = resolveSession(config, { STEAM_CONFIG_VDF_B64: '', STEAM_CONFIG_VDF: '' })
    expect(readFileSync(path, 'utf8')).toBe('from-fallback')
  })

  test('the steamHome file beats the user home', () => {
    const { config } = tree('from-fallback')
    const primed = primeSteamHome(config, 'from-datadir')
    expect(resolveSession(config, {})).toBe(primed)
  })

  test('the user home answers when nothing else does', () => {
    const { config, home } = tree('from-fallback')
    expect(resolveSession(config, {})).toBe(join(home, '.steam', 'config', 'config.vdf'))
  })

  test('no session anywhere names the login command', () => {
    const { config } = tree()
    const error = fails(() => resolveSession(config, {}))
    expect(error.code).toBe(Exit.Environment)
    expect(`${error.message} ${error.detail}`).toContain('gamecrate steam login')
    expect(`${error.message} ${error.detail}`).toContain('STEAM_CONFIG_VDF')
  })
})

function build(config: RootConfig, extra: Partial<ParsedArgs> = {}): Promise<number> {
  const ctx: SteamContext = { config, plugins: new Map(), cwd: '/nowhere' }
  return steamBuildCommand({ subcommand: 'steam', game: 'rimworld', ...extra } as ParsedArgs, ctx)
}

describe('steam build loading', () => {
  function ready(): RootConfig {
    const { config } = tree('from-fallback')
    mkdirSync(steamHome(config.dataRoot), { recursive: true })
    writeFileSync(accountFile(config.dataRoot), 'from-login\n')
    return config
  }

  test('a bare build loads and never pushes', async () => {
    expect(await build(ready(), { load: true })).toBe(Exit.Ok)
    expect(built.load).toBe(true)
    expect(built.push).toBe(false)
  })

  test('--push loads as well, so the runner keeps the image it just built', async () => {
    expect(await build(ready(), { load: true, push: true })).toBe(Exit.Ok)
    expect(built.load).toBe(true)
    expect(built.push).toBe(true)
  })

  test('--push --no-load pushes and keeps nothing local', async () => {
    expect(await build(ready(), { load: false, push: true })).toBe(Exit.Ok)
    expect(built.load).toBe(false)
    expect(built.push).toBe(true)
  })

  test('--no-load with no --push builds and keeps the image nowhere', async () => {
    expect(await build(ready(), { load: false })).toBe(Exit.Ok)
    expect(built.load).toBe(false)
    expect(built.push).toBe(false)
  })
})

describe('steamBuildCommand', () => {
  test('a config that names no game still builds, because the plugin is the authority', async () => {
    const { config } = tree()
    const empty = { ...config, games: {} } as unknown as RootConfig
    process.env.STEAM_CONFIG_VDF_B64 = Buffer.from('from-env').toString('base64')
    process.env.STEAM_USERNAME = 'tester'
    const ctx: SteamContext = { config: empty, plugins: new Map(), cwd: '/nowhere' }
    const reason = await steamBuildCommand({ subcommand: 'steam', subverb: 'build', game: 'rimworld' } as ParsedArgs, ctx)
      .then(() => 'resolved')
      .catch((e: unknown) => (e as Error).message)
    expect(reason).toBe('resolved')
  })

  test('materializes DEPOTDOWNLOADER_ACCOUNT_B64 where depotdownloader reads it before it builds', async () => {
    const { config } = tree()
    const cfg = { ...config, depotdownloader: { path: FAKE_DD } } as unknown as RootConfig
    process.env.STEAM_CONFIG_VDF_B64 = Buffer.from('from-env').toString('base64')
    process.env.STEAM_USERNAME = 'tester'
    process.env.DEPOTDOWNLOADER_ACCOUNT_B64 = Buffer.from('ci token').toString('base64')

    expect(await build(cfg)).toBe(Exit.Ok)
    expect(built.count).toBe(1)
    const token = findDepotDownloaderToken(cfg.dataRoot)
    expect(token?.startsWith(steamHome(cfg.dataRoot))).toBe(true)
    expect(readFileSync(token as string, 'utf8')).toBe('ci token')
  })

  test('materializes STEAM_CONFIG_VDF_B64 onto disk before it builds anything', async () => {
    const { config } = tree()
    process.env.STEAM_CONFIG_VDF_B64 = Buffer.from('from-env').toString('base64')
    process.env.STEAM_USERNAME = 'tester'

    expect(await build(config)).toBe(Exit.Ok)
    expect(built.count).toBe(1)
    for (const seeded of sessionPaths(steamHome(config.dataRoot))) {
      expect(readFileSync(seeded, 'utf8')).toBe('from-env')
    }
  })

  test('copies a session out of the user own home into the paths steamcmd reads', async () => {
    const { config } = tree('from-home')
    process.env.STEAM_USERNAME = 'tester'

    expect(await build(config)).toBe(Exit.Ok)
    expect(built.count).toBe(1)
    for (const seeded of sessionPaths(steamHome(config.dataRoot))) {
      expect(readFileSync(seeded, 'utf8')).toBe('from-home')
    }
  })

  test('no session anywhere refuses the build instead of letting steamcmd fail', async () => {
    const { config } = tree()
    process.env.STEAM_USERNAME = 'tester'
    const error = await build(config).then(
      () => { throw new Error('expected a rejection') },
      (e: GamecrateError) => e,
    )
    expect(error.code).toBe(Exit.Environment)
    expect(error.detail).toContain('gamecrate steam login')
    expect(built.count).toBe(0)
  })

  test('a session with no account name refuses before the build too', async () => {
    const { config } = tree('from-fallback')
    const error = await build(config).then(
      () => { throw new Error('expected a rejection') },
      (e: GamecrateError) => e,
    )
    expect(error.code).toBe(Exit.Environment)
    expect(error.detail).toContain('STEAM_USERNAME')
    expect(error.detail).toContain('gamecrate steam login')
    expect(built.count).toBe(0)
  })

  test('the account file steam login wrote stands in for STEAM_USERNAME', async () => {
    const { config } = tree('from-fallback')
    mkdirSync(steamHome(config.dataRoot), { recursive: true })
    writeFileSync(accountFile(config.dataRoot), 'from-login\n')
    expect(await build(config)).toBe(Exit.Ok)
    expect(built.count).toBe(1)
  })
})

describe('resolveImage', () => {
  test('a build with no config defaults the repo to gamecrate/<game>-game', () => {
    expect(resolveImage({ push: false }, 'rimworld', undefined)).toBe('gamecrate/rimworld-game')
  })

  test('--push with no config and no --image is a usage error', () => {
    const error = fails(() => resolveImage({ push: true }, 'rimworld', undefined))
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('--push needs a target repository')
    expect(error.detail).toContain('games.rimworld.image.ref')
  })

  test('a given ref comes back with its tag stripped', () => {
    expect(resolveImage({ push: false }, 'rimworld', 'ghcr.io/aaron/rimworld:1.5')).toBe(
      'ghcr.io/aaron/rimworld',
    )
  })

  test('a port in the registry is not a tag', () => {
    expect(resolveImage({ push: true }, 'rimworld', 'localhost:5000/rimworld')).toBe(
      'localhost:5000/rimworld',
    )
  })

  test('a ref satisfies --push', () => {
    expect(resolveImage({ push: true }, 'rimworld', 'ghcr.io/aaron/rimworld')).toBe(
      'ghcr.io/aaron/rimworld',
    )
  })
})

describe('steamLogin', () => {

  function fakeSteamcmd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-bin-'))
    const path = join(dir, 'steamcmd')
    writeFileSync(
      path,
      '#!/bin/sh\nPATH=/usr/bin:/bin\nmkdir -p "$HOME/.steam/config"\nprintf session > "$HOME/.steam/config/config.vdf"\nexit 0\n',
      { mode: 0o755 },
    )
    process.env.PATH = dir
    return path
  }

  function login(config: RootConfig, game?: string): Promise<number> {
    const ctx: SteamContext = { config, plugins: new Map(), cwd: '/nowhere' }
    const args = { subcommand: 'steam', subverb: 'login', username: 'tester', game } as ParsedArgs
    return steamLogin(args, ctx)
  }

  test('signs depotdownloader in beside steamcmd and keeps its token under the steam home', async () => {
    const { config } = tree()
    const cfg = {
      ...config,
      games: { rimworld: { steamAppId: 294100 } },
      steamcmd: { path: fakeSteamcmd() },
      depotdownloader: { path: FAKE_DD },
    } as unknown as RootConfig
    expect(await login(cfg)).toBe(Exit.Ok)
    expect(readFileSync(accountFile(cfg.dataRoot), 'utf8').trim()).toBe('tester')
    const token = findDepotDownloaderToken(cfg.dataRoot)
    expect(token?.startsWith(steamHome(cfg.dataRoot))).toBe(true)
    const argv = readFileSync(join(steamHome(cfg.dataRoot), 'argv.txt'), 'utf8')
    expect(argv).toContain('-username tester -remember-password -app 294100')
    expect(argv).toContain('-manifest-only')
    const scratch = readdirSync(steamHome(cfg.dataRoot)).filter((name) => name.startsWith('depotdownloader-login-'))
    expect(scratch).toEqual([])
  })

  test('--print-token prints the depotdownloader token as base64 for a secret', async () => {
    const { config } = tree()
    const cfg = {
      ...config,
      games: { rimworld: { steamAppId: 294100 } },
      steamcmd: { path: fakeSteamcmd() },
      depotdownloader: { path: FAKE_DD },
    } as unknown as RootConfig
    const data: string[] = []
    const probe = useSink({ write: (channel, chunk) => void (channel === 'data' && data.push(String(chunk))), close() {} })
    try {
      const ctx: SteamContext = { config: cfg, plugins: new Map(), cwd: '/nowhere' }
      const args = { subcommand: 'steam', subverb: 'login', username: 'tester', printToken: true } as ParsedArgs
      expect(await steamLogin(args, ctx)).toBe(Exit.Ok)
    } finally {
      probe.close()
    }
    expect(data.join('').trim()).toBe(Buffer.from('fake token\n').toString('base64'))
  })

  test('with no depotdownloader the login is steamcmd alone', async () => {
    const { config } = tree()
    const cfg = { ...config, steamcmd: { path: fakeSteamcmd() } } as unknown as RootConfig
    expect(await login(cfg)).toBe(Exit.Ok)
    expect(readFileSync(accountFile(cfg.dataRoot), 'utf8').trim()).toBe('tester')
    expect(findDepotDownloaderToken(cfg.dataRoot)).toBeUndefined()
  })

  test('a depotdownloader run that saves no token fails the login and says so', async () => {
    const { config } = tree()
    const cfg = {
      ...config,
      games: { rimworld: { steamAppId: 294100 } },
      steamcmd: { path: fakeSteamcmd() },
      depotdownloader: { path: FAKE_DD },
    } as unknown as RootConfig
    process.env.FAKE_NO_TOKEN = '1'
    await expect(login(cfg)).rejects.toThrow(/depotdownloader login did not leave a token/)
  })

  test('depotdownloader needs a game to log in through, and asks for --game before any prompt', async () => {
    const { config } = tree()
    const cfg = {
      ...config,
      games: { rimworld: {} },
      steamcmd: { path: fakeSteamcmd() },
      depotdownloader: { path: FAKE_DD },
    } as unknown as RootConfig
    const error = await login(cfg).then(() => null, (e: unknown) => e as GamecrateError)
    expect(error?.code).toBe(Exit.Usage)
    expect(error?.detail).toContain('--game')
    expect(sessionPaths(steamHome(cfg.dataRoot)).some((path) => existsSync(path))).toBe(false)
  })
})
