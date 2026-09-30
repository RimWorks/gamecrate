import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkZip, unzipInto } from '../src/mods/release'
import { Exit } from '../src/types'
import type { GamecrateError } from '../src/types'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gc-zip-'))
  temps.push(dir)
  return dir
}

/** Writes a real zip with python's zipfile, the one writer here that takes an arbitrary entry name. */
function realZip(dir: string, body: string): string {
  const zip = join(dir, 'asset.zip')
  const script = `import zipfile\nz = zipfile.ZipFile(${JSON.stringify(zip)}, 'w')\n${body}\nz.close()\n`
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  if ((r.status ?? 1) !== 0) throw new Error(`python3 failed: ${r.stderr}`)
  return zip
}

function caught(run: () => void): GamecrateError {
  try {
    run()
  } catch (error) {
    return error as GamecrateError
  }
  throw new Error('expected a throw')
}

describe('checkZip against a real archive and a real unzip', () => {
  test('a traversal entry refuses the archive and names the entry', () => {
    const dir = temp()
    const zip = realZip(dir, "z.writestr('About/About.xml', '<x/>')\nz.writestr('../../escaped.txt', 'pwned')")
    const out = join(dir, 'unpacked')

    const error = caught(() => unzipInto(zip, out))

    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toContain('../../escaped.txt')
    expect(error.detail).toContain('outside the mod directory')
    expect(existsSync(out)).toBe(false)
  })

  test('an absolute entry refuses the archive', () => {
    const dir = temp()
    const zip = realZip(dir, "z.writestr('/etc/gamecrate-owned', 'pwned')")

    const error = caught(() => checkZip(zip))

    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toContain('/etc/gamecrate-owned')
  })

  test('a windows drive-letter entry refuses the archive', () => {
    const dir = temp()
    const zip = realZip(dir, String.raw`z.writestr('C:\\Windows\\System32\\evil.dll', 'pwned')`)

    const error = caught(() => checkZip(zip))

    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toContain('C:')
  })

  test('a symlink entry refuses the archive, because a later entry can write through it', () => {
    const dir = temp()
    const zip = realZip(
      dir,
      [
        "info = zipfile.ZipInfo('escape')",
        'info.external_attr = 0xA1FF << 16',
        "z.writestr(info, '/tmp')",
        "z.writestr('escape/owned.txt', 'pwned')",
      ].join('\n'),
    )

    const error = caught(() => checkZip(zip))

    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toContain('a symlink entry')
    expect(error.message).toContain('escape')
  })

  test('a clean archive still extracts', () => {
    const dir = temp()
    const zip = realZip(dir, "z.writestr('Mod/About/About.xml', '<ModMetaData/>')\nz.writestr('Mod/a..b.txt', 'fine')")
    const out = join(dir, 'unpacked')

    unzipInto(zip, out)

    expect(readFileSync(join(out, 'Mod', 'About', 'About.xml'), 'utf8')).toBe('<ModMetaData/>')
    expect(existsSync(join(out, 'Mod', 'a..b.txt'))).toBe(true)
  })
})
