import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const built = { count: 0 }

// bun's os.homedir() snapshots at startup and ignores a later HOME, unlike node's.
// the suite sets HOME to a temp tree, so homedir() has to follow it or the fallback
// branch reads the real ~/.steam/config/config.vdf.
const realOs = { ...(await import('node:os')) }
await mock.module('node:os', () => ({
  ...realOs,
  default: { ...realOs, homedir: () => process.env.HOME ?? realOs.homedir() },
  homedir: () => process.env.HOME ?? realOs.homedir(),
}))

// the two collaborators past the session check. everything before them is the code under test
await mock.module('../src/image/build', () => ({
  steamBuild: () => {
    built.count += 1
    return Promise.resolve([])
  },
}))

const realInput = { ...(await import('../src/image/input')) }
await mock.module('../src/image/input', () => ({
  ...realInput,
  resolveSteamBuildInput: () => Promise.resolve({}),
}))

const { resolveSession, sessionPaths, steamBuildCommand } = await import('../src/cli/steam')
import type { SteamContext } from '../src/cli/steam'
const { resolveImage } = await import('../src/image/input')
const { accountFile, steamHome } = await import('../src/mods/steamcmd')
import { Exit, GamecrateError } from '../src/types'
import type { ParsedArgs, RootConfig } from '../src/types'

const ORIGINAL_HOME = process.env.HOME
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
})

afterEach(() => {
  built.count = 0
  delete process.env.STEAM_CONFIG_VDF
  delete process.env.STEAM_USERNAME
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

/** dataRoot and a fake home, with `~/.steam/config/config.vdf` written when `fallback` is given. */
function tree(fallback?: string): { config: RootConfig; home: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'gamecrate-steam-'))
  const home = join(root, 'home')
  if (fallback !== undefined) {
    mkdirSync(join(home, '.steam', 'config'), { recursive: true })
    writeFileSync(join(home, '.steam', 'config', 'config.vdf'), fallback)
  }
  // os.homedir() reads HOME first on posix, so the fallback branch never touches the real home
  process.env.HOME = home
  return { config: { dataRoot: join(root, 'data'), games: {} } as unknown as RootConfig, home, env: {} }
}

function primeSteamHome(config: RootConfig, body: string): string {
  const path = join(steamHome(config.dataRoot), '.local', 'share', 'Steam', 'config', 'config.vdf')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

describe('resolveSession', () => {
  test('STEAM_CONFIG_VDF outranks both files on disk', () => {
    const { config } = tree('from-fallback')
    primeSteamHome(config, 'from-datadir')
    const path = resolveSession(config, { STEAM_CONFIG_VDF: Buffer.from('from-env').toString('base64') })
    expect(path).toBe(join(steamHome(config.dataRoot), '.steam', 'config', 'config.vdf'))
    for (const seeded of sessionPaths(steamHome(config.dataRoot))) {
      expect(readFileSync(seeded, 'utf8')).toBe('from-env')
    }
  })

  test('an empty STEAM_CONFIG_VDF is not a session', () => {
    const { config } = tree('from-fallback')
    const path = resolveSession(config, { STEAM_CONFIG_VDF: '' })
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

/** The production entry point, with the build and the input resolution faked out. */
function build(config: RootConfig): Promise<number> {
  const ctx: SteamContext = { config, plugins: new Map(), cwd: '/nowhere' }
  return steamBuildCommand({ subcommand: 'steam', game: 'rimworld' } as ParsedArgs, ctx)
}

describe('steamBuildCommand', () => {
  test('materializes STEAM_CONFIG_VDF onto disk before it builds anything', async () => {
    const { config } = tree()
    process.env.STEAM_CONFIG_VDF = Buffer.from('from-env').toString('base64')
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
    // steamcmd runs with HOME=steamHome and the docker runner mounts only that, so a session the
    // check found in the real home is unusable unless it lands here
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
  test('--load with no config defaults the repo to gamecrate/<game>-game', () => {
    expect(resolveImage({ load: true, push: false }, 'rimworld', undefined)).toBe('gamecrate/rimworld-game')
  })

  test('neither flag is the same default, because --load is the default', () => {
    expect(resolveImage({ load: false, push: false }, 'rimworld', undefined)).toBe('gamecrate/rimworld-game')
  })

  test('--push with no config and no --image is a usage error', () => {
    const error = fails(() => resolveImage({ load: false, push: true }, 'rimworld', undefined))
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('--push needs a target repository')
    expect(error.detail).toContain('games.rimworld.image.ref')
  })

  test('a given ref comes back with its tag stripped', () => {
    expect(resolveImage({ load: true, push: false }, 'rimworld', 'ghcr.io/aaron/rimworld:1.5')).toBe(
      'ghcr.io/aaron/rimworld',
    )
  })

  test('a port in the registry is not a tag', () => {
    expect(resolveImage({ load: false, push: true }, 'rimworld', 'localhost:5000/rimworld')).toBe(
      'localhost:5000/rimworld',
    )
  })

  test('a ref satisfies --push', () => {
    expect(resolveImage({ load: false, push: true }, 'rimworld', 'ghcr.io/aaron/rimworld')).toBe(
      'ghcr.io/aaron/rimworld',
    )
  })
})
