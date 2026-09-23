import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CRANE_IMAGE,
  craneAppend,
  craneLabels,
  craneMutateLabels,
  cranePush,
  craneTag,
} from '../src/image/crane'
import { Exit } from '../src/types'
import type { GamecrateError } from '../src/types'

const FAKE = fileURLToPath(new URL('./fixtures/fake-crane.sh', import.meta.url))

let tmp = ''
const realPath = process.env.PATH

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-crane-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

afterEach(() => {
  process.env.PATH = realPath
  delete process.env.FAKE_ARGV_FILE
  delete process.env.FAKE_CONFIG_JSON
  delete process.env.FAKE_FAIL_FIRST
  delete process.env.FAKE_EXIT
})

/** The fake on PATH under the name docker, plus the file it records into. */
async function fakeDocker(): Promise<{ argvFile: string }> {
  const dir = await mkdtemp(join(tmp, 'bin-'))
  await copyFile(FAKE, join(dir, 'docker'))
  await chmod(join(dir, 'docker'), 0o755)
  const argvFile = join(dir, 'argv.txt')
  await writeFile(argvFile, '')
  process.env.FAKE_ARGV_FILE = argvFile
  process.env.PATH = dir
  return { argvFile }
}

/** Each recorded run, split into argv. */
async function runs(argvFile: string): Promise<string[][]> {
  const text = await readFile(argvFile, 'utf8')
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split(/\s+/))
}

describe('craneAppend', () => {
  test('the whole-game case carries both excludes and the dot transform', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'linux-1.6.4871.tar')
    await craneAppend({
      gameDir,
      include: [],
      gamePath: '/game',
      base: 'ghcr.io/rimworks/gamecrate/runtime-base@sha256:abc',
      platform: 'linux/amd64',
      out,
    })
    const script = await readFile(argvFile, 'utf8')
    expect(script).toContain('--exclude=./steamapps')
    expect(script).toContain('--exclude=./lost+found')
    expect(script).toContain('--transform=s,^\\.,game,')
    expect(script).toContain('-b')
    expect(script).toContain('--platform')
    expect(script).toContain('linux/amd64')
    expect(script).toContain('-o')
    expect(script).toContain(out)
  })

  test('an include list uses the other transform and no excludes', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    await mkdir(join(gameDir, 'Managed'), { recursive: true })
    await writeFile(join(gameDir, 'Version.txt'), '1.6.4871 rev598\n')
    await writeFile(join(gameDir, 'Player Log.txt'), '')
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'ref.tar')
    await craneAppend({
      gameDir,
      include: ['Managed', 'Version.txt', 'Player Log.txt'],
      gamePath: '/game',
      base: null,
      platform: 'linux/amd64',
      out,
    })
    const script = await readFile(argvFile, 'utf8')
    expect(script).toContain('--transform=s,^,game/,')
    expect(script).toContain("'Player Log.txt'")
    expect(script).not.toContain('--exclude')
    expect(script).not.toContain("'-b'")
  })

  test('a missing include path is a resolution error naming the path', async () => {
    await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'ref.tar')
    let thrown: GamecrateError | undefined
    try {
      await craneAppend({
        gameDir,
        include: ['Managed'],
        gamePath: '/game',
        base: null,
        platform: 'linux/amd64',
        out,
      })
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Resolution)
    expect(thrown?.message).toContain('Managed')
  })

  test('binds the game dir read-only and the output dir writable', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const outDir = await mkdtemp(join(tmp, 'layers-'))
    await craneAppend({
      gameDir,
      include: [],
      gamePath: '/game',
      base: null,
      platform: 'linux/amd64',
      out: join(outDir, 'x.tar'),
    })
    const [argv] = await runs(argvFile)
    expect(argv).toContain(`${gameDir}:${gameDir}:ro`)
    expect(argv).toContain(`${outDir}:${outDir}`)
    expect(argv).toContain(CRANE_IMAGE)
    expect(argv![argv!.indexOf(CRANE_IMAGE) - 1]).toBe('sh')
  })
})

describe('cranePush', () => {
  test('sends push with the tar and the ref', async () => {
    const { argvFile } = await fakeDocker()
    await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    const [argv] = await runs(argvFile)
    const at = argv!.indexOf('push')
    expect(argv!.slice(at)).toEqual(['push', '/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871'])
    expect(argv).toContain('/layers:/layers:ro')
  })

  test('retries a failing push and then succeeds', async () => {
    const { argvFile } = await fakeDocker()
    process.env.FAKE_FAIL_FIRST = '2'
    await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    expect((await runs(argvFile)).length).toBe(3)
  })

  test('a push that never succeeds throws with the registry output', async () => {
    const { argvFile } = await fakeDocker()
    process.env.FAKE_FAIL_FIRST = '99'
    let thrown: GamecrateError | undefined
    try {
      await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.detail).toContain('502')
    expect((await runs(argvFile)).length).toBe(3)
  })
})

describe('craneTag and craneMutateLabels', () => {
  test('tag sends the ref then the tag', async () => {
    const { argvFile } = await fakeDocker()
    await craneTag('ghcr.io/me/atlas:1.6.4871', 'latest')
    const [argv] = await runs(argvFile)
    expect(argv!.slice(argv!.indexOf('tag'))).toEqual([
      'tag',
      'ghcr.io/me/atlas:1.6.4871',
      'latest',
    ])
  })

  test('mutate sends one --label per entry and retags in place', async () => {
    const { argvFile } = await fakeDocker()
    await craneMutateLabels('ghcr.io/me/atlas:1.6.4871', {
      'steam.buildid': '19283746',
      'gamecrate.variant': 'linux',
      'gamecrate.launcher': 'direct',
    })
    const [argv] = await runs(argvFile)
    expect(argv!.slice(argv!.indexOf('mutate'))).toEqual([
      'mutate',
      'ghcr.io/me/atlas:1.6.4871',
      '--label',
      'steam.buildid=19283746',
      '--label',
      'gamecrate.variant=linux',
      '--label',
      'gamecrate.launcher=direct',
      '-t',
      'ghcr.io/me/atlas:1.6.4871',
    ])
  })
})

describe('craneLabels', () => {
  test('reads the labels off the config', async () => {
    await fakeDocker()
    process.env.FAKE_CONFIG_JSON = '{"config":{"Labels":{"steam.buildid":"19283746"}}}'
    expect(await craneLabels('ghcr.io/me/atlas:1.6.4871')).toEqual({ 'steam.buildid': '19283746' })
  })

  test('an image with no labels is an empty record, not null', async () => {
    await fakeDocker()
    process.env.FAKE_CONFIG_JSON = '{"config":{"Labels":null}}'
    expect(await craneLabels('ghcr.io/me/atlas:1.6.4871')).toEqual({})
  })

  test('an unreadable image is null', async () => {
    await fakeDocker()
    process.env.FAKE_EXIT = '1'
    expect(await craneLabels('ghcr.io/me/nosuch:1')).toBeNull()
  })

  test('output that is not json is null', async () => {
    await fakeDocker()
    process.env.FAKE_CONFIG_JSON = 'not json at all'
    expect(await craneLabels('ghcr.io/me/atlas:1.6.4871')).toBeNull()
  })
})
