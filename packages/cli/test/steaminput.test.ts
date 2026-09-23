import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { branchPassword, branchPasswordKey, resolveSteamBuildInput } from '../src/image/input'
import { Exit } from '../src/types'
import type { GamecrateError, RootConfig } from '../src/types'

let tmp = ''

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-steaminput-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('STEAM_BRANCH_PASSWORD')) delete process.env[key]
  }
})

/** A loadable v2 plugin package, with the two keys steam build needs. */
async function writeSteamPlugin(dir: string, game: string, appId = 294100): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: basename(dir), type: 'module', exports: { '.': './dist/plugin.js' } }),
  )
  await writeFile(
    join(dir, 'dist', 'plugin.js'),
    `export default {
    apiVersion: 2,
    game: ${JSON.stringify(game)},
    defaults: {
      steamAppId: ${appId},
      executable: './AtlasLinux',
      gameFiles: { source: 'image', container: '/game' },
      version: { file: 'Version.txt' },
      steamBuild: {
        branches: [{ name: 'public' }],
        variants: [{ name: 'linux', base: 'xvfb', include: [] }],
      },
    },
    parseManifest: () => null,
    renderModsConfig: () => '',
    mergePrefs: () => '',
    windowedPrefs: {},
    parseVersion: () => null,
  }\n`,
  )
}

describe('branchPasswordKey', () => {
  test.each([
    ['public', 'STEAM_BRANCH_PASSWORD_PUBLIC'],
    ['unstable', 'STEAM_BRANCH_PASSWORD_UNSTABLE'],
    ['1.5-test', 'STEAM_BRANCH_PASSWORD_1_5_TEST'],
  ])('%s -> %s', (branch, key) => {
    expect(branchPasswordKey(branch)).toBe(key)
  })
})

describe('branchPassword', () => {
  test('a branch that needs no password reads no variable', () => {
    process.env.STEAM_BRANCH_PASSWORD = 'set-but-unused'
    expect(branchPassword({ name: 'public' })).toBeUndefined()
  })

  test('the keyed variable wins over the bare one', () => {
    process.env.STEAM_BRANCH_PASSWORD_1_5_TEST = 'keyed'
    process.env.STEAM_BRANCH_PASSWORD = 'bare'
    expect(branchPassword({ name: '1.5-test', password: true })).toBe('keyed')
  })

  test('the bare variable answers when the keyed one is unset', () => {
    process.env.STEAM_BRANCH_PASSWORD = 'bare'
    expect(branchPassword({ name: 'unstable', password: true })).toBe('bare')
  })

  test('neither variable set names the exact one it looked for', () => {
    let thrown: GamecrateError | undefined
    try {
      branchPassword({ name: '1.5-test', password: true })
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.detail).toContain('STEAM_BRANCH_PASSWORD_1_5_TEST')
    expect(thrown?.detail).toContain('STEAM_BRANCH_PASSWORD,')
  })
})

describe('resolveSteamBuildInput', () => {
  test('plugin defaults resolve with no config file present', async () => {
    const cwd = await mkdtemp(join(tmp, 'noconfig-'))
    await writeSteamPlugin(join(cwd, 'node_modules', '@gamecrate', 'atlas'), 'atlas')

    const input = await resolveSteamBuildInput('atlas', null, {}, cwd)
    expect(input.steamAppId).toBe(294100)
    expect(input.versionFile).toBe('Version.txt')
    expect(input.gamePath).toBe('/game')
    expect(input.variants.map((v) => v.name)).toEqual(['linux'])
    // --load has no registry to name, so the repo defaults
    expect(input.image).toBe('gamecrate/atlas-game')
    expect(existsSync(join(cwd, '.gamecrate.yaml'))).toBe(false)
  })

  test('--plugin overrides the @gamecrate/<game> convention', async () => {
    const cwd = await mkdtemp(join(tmp, 'plugin-'))
    // the convention path exists and declares a different appid, to prove it is skipped
    await writeSteamPlugin(join(cwd, 'node_modules', '@gamecrate', 'atlas'), 'atlas', 1)
    const explicit = join(cwd, 'checkout')
    await writeSteamPlugin(explicit, 'atlas', 294100)

    const input = await resolveSteamBuildInput('atlas', null, { plugins: ['./checkout'] }, cwd)
    expect(input.steamAppId).toBe(294100)
  })

  test('an unresolvable game names what it tried', async () => {
    const cwd = await mkdtemp(join(tmp, 'missing-'))
    await expect(resolveSteamBuildInput('nosuch', null, {}, cwd)).rejects.toThrow(/@gamecrate\/nosuch/)
  })

  test('--image beats the configured ref, and the tag is dropped', async () => {
    const cwd = await mkdtemp(join(tmp, 'image-'))
    await writeSteamPlugin(join(cwd, 'node_modules', '@gamecrate', 'atlas'), 'atlas')
    const config = {
      dataRoot: join(cwd, 'data'),
      games: { atlas: { image: { ref: 'ghcr.io/Me/Atlas:1.2' } } },
    } as unknown as RootConfig

    expect((await resolveSteamBuildInput('atlas', config, {}, cwd)).image).toBe('ghcr.io/me/atlas')
    const flagged = await resolveSteamBuildInput('atlas', config, { image: 'ghcr.io/me/other' }, cwd)
    expect(flagged.image).toBe('ghcr.io/me/other')
  })

  test('--push with no repo anywhere is a usage error', async () => {
    const cwd = await mkdtemp(join(tmp, 'push-'))
    await writeSteamPlugin(join(cwd, 'node_modules', '@gamecrate', 'atlas'), 'atlas')
    let thrown: GamecrateError | undefined
    try {
      await resolveSteamBuildInput('atlas', null, { push: true }, cwd)
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Usage)
  })

  test('a user branch concatenates here exactly as it does for run', async () => {
    const cwd = await mkdtemp(join(tmp, 'concat-'))
    await writeSteamPlugin(join(cwd, 'node_modules', '@gamecrate', 'atlas'), 'atlas')
    const config = {
      dataRoot: join(cwd, 'data'),
      games: { atlas: { steamBuild: { branches: [{ name: 'unstable', password: true }] } } },
    } as unknown as RootConfig
    const input = await resolveSteamBuildInput('atlas', config, {}, cwd)
    // the plugin declares public. a replace would drop it and move which branch is the default
    expect(input.branches.map((b) => b.name)).toEqual(['public', 'unstable'])
  })
})
