import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  accountFile, appDownloadRoot, buildIdFor, downloadApp, publishedBuildId, steamHome,
} from '../src/mods/steamcmd'
import { Exit } from '../src/types'
import type { GamecrateError, RootConfig } from '../src/types'

const FAKE = fileURLToPath(new URL('./fixtures/fake-steamcmd-app.sh', import.meta.url))
let tmp = ''

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-steamapp-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.STEAM_USERNAME = 'tester'
})

afterEach(() => {
  delete process.env.STEAM_USERNAME
  delete process.env.FAKE_APP_STATE
  delete process.env.FAKE_UP_TO_DATE
  delete process.env.FAKE_LOGIN_FAIL
  delete process.env.FAKE_EXIT
  delete process.env.FAKE_REDIST
})

/** A data root of its own, wired to the fake, so the tests never touch steam. */
async function fake(): Promise<{ root: string; cfg: RootConfig }> {
  const root = await mkdtemp(join(tmp, 'app-'))
  return { root, cfg: { dataRoot: root, games: {}, steamcmd: { path: FAKE } } }
}

/** What the fake recorded, split into words. */
async function recordedArgv(root: string): Promise<string[]> {
  return (await readFile(join(steamHome(root), 'argv.txt'), 'utf8')).trim().split(/\s+/)
}

/** Any runscript a call left behind. A password still on disk is the bug this all guards. */
async function leftoverRunscripts(root: string): Promise<string[]> {
  return (await readdir(steamHome(root))).filter((name) => name.startsWith('runscript-'))
}

/** Everything the tool wrote to the terminal while fn ran. status() writes there too. */
async function terminal(fn: () => Promise<unknown>): Promise<string> {
  const written: string[] = []
  const real = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  try {
    await fn()
  } finally {
    process.stderr.write = real
  }
  return written.join('')
}

describe('appDownloadRoot', () => {
  test('differs per branch and per depot', () => {
    const a = appDownloadRoot('/data', 294100, 'public', 'linux')
    const b = appDownloadRoot('/data', 294100, '1.5', 'linux')
    const c = appDownloadRoot('/data', 294100, 'public', 'windows')
    expect(a).toBe('/data/steam/apps/294100-public-linux')
    expect(b).toBe('/data/steam/apps/294100-1.5-linux')
    expect(c).toBe('/data/steam/apps/294100-public-windows')
    expect(new Set([a, b, c]).size).toBe(3)
  })

  test('an omitted depot is its own key, not the linux one', () => {
    expect(appDownloadRoot('/data', 294100, 'public')).toBe('/data/steam/apps/294100-public-native')
  })

  test('a branch with a dot and a dash keeps both', () => {
    expect(appDownloadRoot('/data', 294100, '1.5-test', 'linux'))
      .toBe('/data/steam/apps/294100-1.5-test-linux')
  })
})

describe('downloadApp', () => {
  test('passes -beta with the branch name', async () => {
    const { root, cfg } = await fake()
    await downloadApp(cfg, { steamAppId: 294100, branch: '1.5', dataRoot: root })
    const argv = await recordedArgv(root)
    expect(argv[argv.indexOf('-beta') + 1]).toBe('1.5')
  })

  test('a branch with no password keeps a plain argv and writes no runscript', async () => {
    const { root, cfg } = await fake()
    await downloadApp(cfg, { steamAppId: 294100, branch: 'public', dataRoot: root })
    const argv = await readFile(join(steamHome(root), 'argv.txt'), 'utf8')
    expect(argv).toContain('+app_update 294100')
    expect(argv).not.toContain('+runscript')
    expect(argv).not.toContain('-betapassword')
    expect(await leftoverRunscripts(root)).toEqual([])
  })

  test('a password rides a runscript, never the argv', async () => {
    const { root, cfg } = await fake()
    await downloadApp(cfg, {
      steamAppId: 294100, branch: 'unstable', depot: 'windows', password: 'hunter2', dataRoot: root,
    })
    // `ps` reads this one, which is the whole reason the password is not in it
    const argv = await readFile(join(steamHome(root), 'argv.txt'), 'utf8')
    expect(argv).toContain('+runscript')
    expect(argv).not.toContain('-betapassword')
    expect(argv).not.toContain('hunter2')

    const script = await readFile(join(steamHome(root), 'runscript.txt'), 'utf8')
    expect(script).toContain('-beta unstable')
    expect(script).toContain('-betapassword hunter2')
    // a @ setting applies to whatever runs after it, here too
    expect(script.indexOf('@sSteamCmdForcePlatformType')).toBeLessThan(script.indexOf('login'))
  })

  test('the runscript is 0600, and gone once the download succeeds', async () => {
    const { root, cfg } = await fake()
    const out = await downloadApp(cfg, {
      steamAppId: 294100, branch: 'unstable', password: 'hunter2', dataRoot: root,
    })
    expect(existsSync(join(out.dir, 'Version.txt'))).toBe(true)
    expect((await readFile(join(steamHome(root), 'runscript.mode'), 'utf8')).trim()).toBe('600')
    expect(await leftoverRunscripts(root)).toEqual([])
  })

  test('the runscript is gone when steamcmd fails', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_APP_STATE = '0x606'
    await expect(downloadApp(cfg, {
      steamAppId: 294100, branch: 'unstable', password: 'hunter2', dataRoot: root,
    })).rejects.toThrow()
    expect(await leftoverRunscripts(root)).toEqual([])
  })

  test('pins the install dir and the platform before login', async () => {
    const { root, cfg } = await fake()
    await downloadApp(cfg, { steamAppId: 294100, branch: 'public', depot: 'windows', dataRoot: root })
    const argv = await recordedArgv(root)
    const login = argv.indexOf('+login')
    expect(argv.indexOf('+force_install_dir')).toBeLessThan(login)
    expect(argv[argv.indexOf('+force_install_dir') + 1])
      .toBe(appDownloadRoot(root, 294100, 'public', 'windows'))
    // a @ setting applies to whatever runs after it, so it is worthless after +login
    expect(argv.indexOf('+@sSteamCmdForcePlatformType')).toBeLessThan(login)
    expect(argv[argv.indexOf('+@sSteamCmdForcePlatformType') + 1]).toBe('windows')
  })

  test('says nothing about a platform when no depot is given', async () => {
    const { root, cfg } = await fake()
    await downloadApp(cfg, { steamAppId: 294100, branch: 'public', dataRoot: root })
    expect(await readFile(join(steamHome(root), 'argv.txt'), 'utf8'))
      .not.toContain('sSteamCmdForcePlatformType')
  })

  test('downloads into the per-branch directory', async () => {
    const { root, cfg } = await fake()
    const out = await downloadApp(cfg, { steamAppId: 294100, branch: '1.5', dataRoot: root })
    expect(out.dir).toBe(appDownloadRoot(root, 294100, '1.5', undefined))
    expect(existsSync(join(out.dir, 'Version.txt'))).toBe(true)
  })

  test('a bad state names the branch and says a password could be the cause', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_APP_STATE = '0x606'
    let thrown: GamecrateError | undefined
    try {
      await downloadApp(cfg, { steamAppId: 294100, branch: 'unstable', password: 'wrong', dataRoot: root })
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.message).toContain('unstable')
    expect(thrown?.detail).toContain('0x606')
    expect(thrown?.detail).toContain('password')
  })

  test('releases the lock when steamcmd fails', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_APP_STATE = '0x606'
    await expect(downloadApp(cfg, { steamAppId: 294100, branch: 'public', dataRoot: root }))
      .rejects.toThrow()
    expect(existsSync(`${steamHome(root)}.lock`)).toBe(false)
  })

  test.each([
    'Login Failure',
    'FAILED (Invalid Password)',
    'Account Logon Denied',
    'Two-factor code mismatch',
  ])('a login failure saying %s blames the login, not the branch', async (line) => {
    const { root, cfg } = await fake()
    process.env.FAKE_LOGIN_FAIL = line
    let thrown: GamecrateError | undefined
    try {
      await downloadApp(cfg, { steamAppId: 294100, branch: 'unstable', password: 'x', dataRoot: root })
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.message).toContain('login')
    expect(thrown?.message).not.toContain('unstable')
    expect(thrown?.detail).toContain('gamecrate steam login')
  })

  test('shows what steamcmd printed, and still parses it', async () => {
    const { root, cfg } = await fake()
    let out = ''
    const shown = await terminal(async () => {
      out = (await downloadApp(cfg, { steamAppId: 294100, branch: '1.5', dataRoot: root })).dir
    })
    // a 5GB download that prints only once it is finished is the defect this pins
    expect(shown).toContain("Success! App '294100' fully installed")
    expect(existsSync(join(out, 'Version.txt'))).toBe(true)
  })

  test('a tree that is already current is a success, not a missing branch', async () => {
    const { root, cfg } = await fake()
    const first = await downloadApp(cfg, { steamAppId: 294100, branch: '1.5', dataRoot: root })
    process.env.FAKE_UP_TO_DATE = '1'
    const again = await downloadApp(cfg, { steamAppId: 294100, branch: '1.5', dataRoot: root })
    expect(again.dir).toBe(first.dir)
    expect(existsSync(join(again.dir, 'Version.txt'))).toBe(true)
  })

  test('a redistributable succeeding does not cover the game failing', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_REDIST = '1'
    process.env.FAKE_APP_STATE = '0x606'
    await expect(downloadApp(cfg, { steamAppId: 294100, branch: 'unstable', dataRoot: root }))
      .rejects.toThrow('steamcmd did not install app 294100')
  })

  test('shows what steamcmd printed when it fails', async () => {
    const { root, cfg } = await fake()
    process.env.FAKE_APP_STATE = '0x606'
    const shown = await terminal(async () => {
      await expect(downloadApp(cfg, { steamAppId: 294100, branch: 'unstable', dataRoot: root }))
        .rejects.toThrow()
    })
    expect(shown).toContain("Error! App '294100' state is 0x606")
  })

  test('no STEAM_USERNAME names the login command', async () => {
    const { root, cfg } = await fake()
    delete process.env.STEAM_USERNAME
    let thrown: GamecrateError | undefined
    try {
      await downloadApp(cfg, { steamAppId: 294100, branch: 'public', dataRoot: root })
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.detail).toContain('STEAM_USERNAME')
    expect(thrown?.detail).toContain('gamecrate steam login')
  })
})

describe('publishedBuildId', () => {
  test('reads the buildid under the branch that was asked for', async () => {
    const { cfg } = await fake()
    // the fake prints public first, so a parser that takes the first hit answers 111
    expect(await publishedBuildId(cfg, 294100, '1.5')).toBe('222')
    expect(await publishedBuildId(cfg, 294100, 'unstable')).toBe('333')
    expect(await publishedBuildId(cfg, 294100, 'public')).toBe('111')
  })

  test('a branch steam never mentions is null', async () => {
    const { cfg } = await fake()
    expect(await publishedBuildId(cfg, 294100, 'nosuch')).toBeNull()
  })

  test('no account anywhere throws what the download throws, never a null', async () => {
    const { cfg } = await fake()
    delete process.env.STEAM_USERNAME
    // a null here reads as "steam reported no buildid", which builds and hides the real cause
    await expect(publishedBuildId(cfg, 294100, 'public'))
      .rejects.toThrow(/needs a steam account/)
  })

  test('the account file steam login wrote stands in for STEAM_USERNAME', async () => {
    const { root, cfg } = await fake()
    delete process.env.STEAM_USERNAME
    await mkdir(steamHome(root), { recursive: true })
    await writeFile(accountFile(root), 'from-login\n')
    expect(await publishedBuildId(cfg, 294100, 'public')).toBe('111')
    expect(await recordedArgv(root)).toContain('from-login')
  })

  test('releases the lock when the spawn fails', async () => {
    const { root, cfg } = await fake()
    const broken = join(root, 'broken-steamcmd.sh')
    await writeFile(broken, '#!/nonexistent/interp\n', { mode: 0o755 })
    await expect(publishedBuildId({ ...cfg, steamcmd: { path: broken } }, 294100, 'public'))
      .rejects.toThrow(/could not run steamcmd/)
    expect(existsSync(`${steamHome(root)}.lock`)).toBe(false)
  })
})

describe('buildIdFor', () => {
  test('ignores a buildid printed before the branches block', () => {
    const output = [
      '"294100"', '{', '  "common"', '  {', '    "buildid"  "999"', '  }',
      '  "depots"', '  {', '    "branches"', '    {',
      '      "public"', '      {', '        "buildid"  "111"', '      }',
      '    }', '  }', '}',
    ].join('\n')
    expect(buildIdFor(output, 'public')).toBe('111')
  })

  test('finds a branch whose name has a dot and a dash', () => {
    const output = [
      '    "branches"', '    {',
      '      "public"', '      {', '        "buildid"  "111"', '      }',
      '      "1.5-test"', '      {', '        "buildid"  "222"', '      }',
      '    }',
    ].join('\n')
    expect(buildIdFor(output, '1.5-test')).toBe('222')
  })

  test('empty output is null', () => {
    expect(buildIdFor('', 'public')).toBeNull()
  })
})
