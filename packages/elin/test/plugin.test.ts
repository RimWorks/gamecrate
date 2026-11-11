import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../src/index'
import pkg from '../package.json'

describe('defaults', () => {
  test('the image is built from elin on steam', () => {
    expect(plugin.game).toBe('elin')
    expect(plugin.defaults.steamAppId).toBe(2135150)
    expect(plugin.defaults.steamBuild?.branches).toEqual([{ name: 'public' }])
  })

  test('the only variant is a windows reference image of the files a mod compiles against', () => {
    expect(plugin.defaults.steamBuild?.variants).toEqual([
      {
        name: 'windows-ref',
        base: 'none',
        depot: 'windows',
        include: ['Elin_Data/Managed', 'BepInEx/core', 'version.json', 'Package/_ModdingKit/package.xml'],
      },
    ])
  })

  test('the files land under /game, where the consuming ci jobs read them', () => {
    expect(plugin.defaults.gameFiles).toEqual({ source: 'image', container: '/game' })
  })
})

describe('mod formats', () => {
  test('every mod hook says elin is not supported yet instead of guessing a format', () => {
    const hooks = [plugin.parseManifest, plugin.renderModsConfig, plugin.mergePrefs, plugin.parseVersion] as Array<
      (...args: unknown[]) => unknown
    >
    for (const hook of hooks) expect(() => hook()).toThrow("elin's mod formats are not supported yet")
  })
})

describe('the entry point gamecrate actually imports', () => {
  test('carries the same defaults as src', async () => {
    const entry = pkg.exports['.'].default
    expect(entry).toBe(pkg.main)
    const built = await import(join(fileURLToPath(new URL('.', import.meta.url)), '..', entry))
    expect(built.default.defaults).toEqual(plugin.defaults)
  })
})
