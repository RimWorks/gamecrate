import { afterAll, describe, expect, test } from 'vitest'
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { detectIndent, writeConfig } from '../src/config/write'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gamecrate-write-'))
  dirs.push(dir)
  return dir
}

/** Returns the file path so a test can read it back. */
async function seed(name: string, text: string): Promise<string> {
  const file = join(await scratch(), name)
  await writeFile(file, text)
  return file
}

describe('writeConfig json', () => {
  test('leaves comments and untouched bytes alone', async () => {
    // irregular on purpose: a re-serializer cannot reproduce `   :   `, the blank line, or a
    // 3-space indent, so byte equality here is a real byte-minimality check.
    const before = [
      '{',
      '   // which game this is',
      '   "game"   :   "rimworld",',
      '',
      '   "profiles" : {',
      '      "dev" : 1',
      '   },',
      '   "trailing"   :   42',
      '}',
      '',
    ].join('\n')
    const file = await seed('gamecrate.jsonc', before)

    await writeConfig(file, [{ path: ['profiles', 'prod'], value: 2 }])
    const after = await readFile(file, 'utf8')

    expect(after).toBe(before.replace('      "dev" : 1\n', '      "dev": 1,\n      "prod": 2\n'))
    expect(after).toContain('// which game this is')
  })

  test('matches tab indentation', async () => {
    const file = await seed('gamecrate.json', '{\n\t"game": "rimworld"\n}\n')

    await writeConfig(file, [{ path: ['profile'], value: 'dev' }])
    const after = await readFile(file, 'utf8')

    expect(after).toContain('\n\t"profile": "dev"')
    expect(after).not.toContain('\n  "profile"')
  })

  test('undefined deletes the key', async () => {
    const file = await seed('gamecrate.json', '{\n  "game": "rimworld",\n  "profile": "dev"\n}\n')

    await writeConfig(file, [{ path: ['profile'], value: undefined }])

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ game: 'rimworld' })
  })
})

describe('writeConfig yaml', () => {
  test('keeps meaning and comments, not layout', async () => {
    const file = await seed(
      'gamecrate.yml',
      'game: rimworld # the game we run\nprofiles:\n    dev:\n        mods:\n            - core\n',
    )

    await writeConfig(file, [{ path: ['profiles', 'prod', 'mods'], value: ['core'] }])
    const after = await readFile(file, 'utf8')

    expect(after).toContain('# the game we run')
    expect(parseYaml(after)).toEqual({
      game: 'rimworld',
      profiles: { dev: { mods: ['core'] }, prod: { mods: ['core'] } },
    })
  })

  test('undefined deletes the key', async () => {
    const file = await seed('gamecrate.yaml', 'game: rimworld\nprofile: dev\n')

    await writeConfig(file, [{ path: ['profile'], value: undefined }])

    expect(parseYaml(await readFile(file, 'utf8'))).toEqual({ game: 'rimworld' })
  })
})

describe('writeConfig file handling', () => {
  test('follows a symlink instead of replacing it', async () => {
    const dir = await scratch()
    const real = join(dir, 'real.json')
    const link = join(dir, 'gamecrate.json')
    await writeFile(real, '{\n  "game": "rimworld"\n}\n')
    await symlink(real, link)

    await writeConfig(link, [{ path: ['profile'], value: 'dev' }])

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(real, 'utf8'))).toEqual({ game: 'rimworld', profile: 'dev' })
  })

  test('keeps the original mode', async () => {
    const file = await seed('gamecrate.json', '{\n  "game": "rimworld"\n}\n')
    await chmod(file, 0o600)

    await writeConfig(file, [{ path: ['profile'], value: 'dev' }])

    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test('restores mode bits the umask would have masked off', async () => {
    const file = await seed('gamecrate.json', '{\n  "game": "rimworld"\n}\n')
    await chmod(file, 0o666)
    // safe only because vitest's default `forks` pool gives this file its own process.
    const umask = process.umask(0o022)
    try {
      await writeConfig(file, [{ path: ['profile'], value: 'dev' }])
    } finally {
      process.umask(umask)
    }

    expect((await stat(file)).mode & 0o777).toBe(0o666)
  })

  test('picks the format from the config name, not the link target', async () => {
    const dir = await scratch()
    const real = join(dir, 'payload')
    const link = join(dir, '.gamecrate.yml')
    await writeFile(real, 'game: rimworld\n')
    await symlink(real, link)

    await writeConfig(link, [{ path: ['profile'], value: 'dev' }])
    const after = await readFile(real, 'utf8')

    expect(after).toMatch(/^game: rimworld$/m)
    expect(after).toMatch(/^profile: dev$/m)
    expect(after).not.toContain('{')
  })

  test('refuses a suffix the loader would refuse', async () => {
    const file = await seed('gamecrate.txt', 'game: rimworld\n')

    await expect(writeConfig(file, [{ path: ['profile'], value: 'dev' }])).rejects.toThrow(
      /not a format gamecrate writes/,
    )
  })

  test('an empty edit list writes nothing', async () => {
    const before = '{\n  "game": "rimworld"\n}\n'
    const file = await seed('gamecrate.json', before)

    await writeConfig(file, [])

    expect(await readFile(file, 'utf8')).toBe(before)
  })
})

describe('writeConfig guards', () => {
  test('an empty edit list neither reflows a yaml file nor touches a missing one', async () => {
    // both halves of the early return: it runs before the yaml round trip and before realpath,
    // and each of those is destructive on its own.
    const before = 'game:    rimworld\n#   kept\nprofiles:   {dev:   1}\n'
    const file = await seed('gamecrate.yml', before)
    await writeConfig(file, [])
    expect(await readFile(file, 'utf8')).toBe(before)

    const missing = join(await scratch(), 'gamecrate.yml')
    await expect(writeConfig(missing, [])).resolves.toBeUndefined()
    // the other side: with an edit, the same missing file is an error, so the guard is what
    // made the zero-edit call safe rather than the file being writable
    await expect(writeConfig(missing, [{ path: ['game'], value: 'rimworld' }])).rejects.toThrow()
  })

  test('deleting an absent key is a no-op, and a present one still goes', async () => {
    const before = 'game: rimworld\nprofiles:\n  dev:\n    mods:\n      - a.b\n'
    const file = await seed('gamecrate.yaml', before)

    await writeConfig(file, [
      { path: ['nope'], value: undefined },
      { path: ['nope', 'deeper'], value: undefined },
      { path: ['profiles', 'gone'], value: undefined },
      { path: ['profiles', 'dev', 'mods', 3], value: undefined },
    ])
    expect(parseYaml(await readFile(file, 'utf8'))).toEqual(parseYaml(before))

    await writeConfig(file, [{ path: ['profiles', 'dev', 'mods'], value: undefined }])
    expect(parseYaml(await readFile(file, 'utf8'))).toEqual({ game: 'rimworld', profiles: { dev: {} } })
  })
})

describe('detectIndent', () => {
  test.each([
    ['two spaces', '{\n  "a": 1\n}\n', { tabSize: 2, insertSpaces: true }],
    ['four spaces', '{\n    "a": 1\n}\n', { tabSize: 4, insertSpaces: true }],
    ['tabs', '{\n\t"a": 1\n}\n', { tabSize: 1, insertSpaces: false }],
    ['no indent', '{}\n', { tabSize: 2, insertSpaces: true }],
    ['block comment', '{\n/* foo\n   bar */\n  "a": 1\n}\n', { tabSize: 2, insertSpaces: true }],
  ])('%s', (_name, text, want) => {
    expect(detectIndent(text)).toEqual(want)
  })
})
