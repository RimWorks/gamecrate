import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractRefs, extractScript, readVersion, refsLink } from '../src/image/refs'
import { Exit } from '../src/types'
import type { GameConfig } from '../src/types'

function config(managed?: string[]): GameConfig {
  return {
    gameFiles: { source: 'image', container: '/game' },
    image: { ref: 'ghcr.io/me/atlas:1.6' },
    managed,
  } as unknown as GameConfig
}

function run(script: string, tree: Record<string, string[]>): string[] {
  const base = mkdtempSync(join(tmpdir(), 'gamecrate-refs-'))
  const out = join(base, 'out')
  mkdirSync(out)
  for (const [dir, files] of Object.entries(tree)) {
    const target = join(base, 'game', dir)
    mkdirSync(target, { recursive: true })
    for (const name of files) writeFileSync(join(target, name), '')
  }
  const local = script.replaceAll("'/game", `'${join(base, 'game')}`).replaceAll('/out/', `${out}/`)
  const done = spawnSync('sh', ['-c', local], { encoding: 'utf8' })
  expect(done.status).toBe(0)
  return readdirSync(out).sort()
}

describe('the extraction script', () => {
  test('the native runtime copy is guarded by System.Private.CoreLib.dll', () => {
    const text = extractScript(['Foo_Data/Managed'], '/game')
    expect(text).toContain('set -- "$d"/*.dll')
    expect(text).toContain('cp "$@" /out/')
    expect(text).toContain('if [ -f "$d/System.Private.CoreLib.dll" ]; then')
    expect(text).toMatch(/if \[ -f "\$d\/System\.Private\.CoreLib\.dll" \]; then\n\s*cp "\$d"\/\*\.so \/out\//)
  })

  test('a Unity-style Managed directory copies dlls and nothing else', () => {
    const managed = ['Foo.dll', 'Bar.dll', 'libsomething.so', 'Foo.runtimeconfig.json']
    expect(run(extractScript(['Foo_Data/Managed'], '/game'), { 'Foo_Data/Managed': managed })).toEqual([
      'Bar.dll',
      'Foo.dll',
    ])
  })

  test('a self-contained game root brings its native runtime along', () => {
    const root = [
      'System.Private.CoreLib.dll',
      'RimWorld.dll',
      'libcoreclr.so',
      'libclrjit.so',
      'RimWorld.runtimeconfig.json',
      'RimWorld.deps.json',
    ]
    expect(run(extractScript(['Foo_Data/Managed', '.'], '/game'), { '.': root })).toEqual([
      'RimWorld.deps.json',
      'RimWorld.dll',
      'RimWorld.runtimeconfig.json',
      'System.Private.CoreLib.dll',
      'libclrjit.so',
      'libcoreclr.so',
    ])
  })

  test('probes the declared directories in order, under the container path', () => {
    const text = extractScript(['Foo_Data/Managed', '.'], '/game')
    expect(text).toContain("for d in '/game/Foo_Data/Managed' '/game'; do")
  })

  test('a directory with no assemblies falls through to the next', () => {
    expect(extractScript(['a', 'b'], '/game')).toContain('[ -f "$1" ] || continue')
  })

  test('exits 3 when nothing matched, so a miss is Resolution and not a docker failure', () => {
    expect(extractScript(['a'], '/game').trimEnd().endsWith('exit 3')).toBe(true)
  })

  test('quotes a container path holding a space', () => {
    expect(extractScript(['My Data/Managed'], '/game')).toContain("'/game/My Data/Managed'")
  })

  test('the extract script also copies Version.txt from the game root', () => {
    const script = extractScript(['RimWorldLinux_Data/Managed'], '/game')
    expect(script).toContain("cp '/game/Version.txt' /out/")
  })
})

describe('refsLink', () => {
  test('points a version at its own directory', () => {
    expect(refsLink('rimworld', '1.5')).toEndWith('refs/version/rimworld/1.5')
    expect(refsLink('rimworld')).toEndWith('refs/current/rimworld')
  })
})

describe('extractRefs', () => {
  test('refuses a plugin that declares no managed directories', async () => {
    await expect(extractRefs('atlas', config())).rejects.toMatchObject({
      code: Exit.Config,
      message: expect.stringContaining('"atlas" plugin does not declare'),
    })
  })

  test('an empty list is the same refusal, not an empty probe', async () => {
    await expect(extractRefs('atlas', config([]))).rejects.toMatchObject({ code: Exit.Config })
  })
})

describe('the version link', () => {
  test('takes major.minor out of a rimworld version line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-ver-'))
    await writeFile(join(dir, 'Version.txt'), '1.6.4633 rev1254\n')
    expect(await readVersion(dir)).toBe('1.6')
  })

  test('an image with no Version.txt gets no version link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-ver-'))
    expect(await readVersion(dir)).toBeUndefined()
  })

  test('a line that is not a version is not one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-ver-'))
    await writeFile(join(dir, 'Version.txt'), 'unknown\n')
    expect(await readVersion(dir)).toBeUndefined()
  })

  test('both links are written, so a pin never reads current', () => {
    expect(refsLink('atlas')).toMatch(/refs\/current\/atlas$/)
    expect(refsLink('atlas', '1.6')).toMatch(/refs\/version\/atlas\/1\.6$/)
  })
})
