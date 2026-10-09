import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../src/index'
import pkg from '../package.json'

describe('defaults', () => {
  test('the container shares the host netns so RimObs stays reachable', () => {
    expect(plugin.defaults.settings?.network).toBe('host')
  })

  test('workshopRoot is declared but empty, so a profile has to point it at Steam', () => {
    expect(plugin.defaults).toHaveProperty('workshopRoot')
    expect(plugin.defaults.workshopRoot).toBeNull()
  })

  test('the steamless mod ships in this package, so a fresh install can resolve it', () => {
    const id = plugin.defaults.steamlessMod as string
    const supplied = plugin.defaults.library?.[id]?.path as string
    const about = readFileSync(join(supplied, 'About', 'About.xml'), 'utf8')
    expect(about).toContain(`<packageId>${id}</packageId>`)
    expect(pkg.files).toContain('mods')
  })

  test('every hard dependency of the steamless mod is pinned too', () => {
    const id = plugin.defaults.steamlessMod as string
    const supplied = plugin.defaults.library?.[id]?.path as string
    const about = readFileSync(join(supplied, 'About', 'About.xml'), 'utf8')
    const block = about.match(/<modDependencies>([\s\S]*?)<\/modDependencies>/)?.[1] ?? ''
    const needed = [...block.matchAll(/<packageId>(.+?)<\/packageId>/g)].map((m) => m[1]?.toLowerCase())
    expect(needed.length).toBeGreaterThan(0)
    const pinned = Object.keys(plugin.defaults.library ?? {}).map((key) => key.toLowerCase())
    expect(needed.filter((dep) => !pinned.includes(dep as string))).toEqual([])
  })

  test('no default carries a path from outside this package', () => {
    const root = `${join(fileURLToPath(new URL('.', import.meta.url)), '..')}/`
    const absolute = JSON.stringify(plugin.defaults).match(/\/[^"]+/g) ?? []
    expect(absolute.filter((path) => path.startsWith('/home') && !path.startsWith(root))).toEqual([])
    expect(plugin.defaults.scanRoots).toEqual([])
  })
})

/** gamecrate loads the exports entry, not src, so a stale bundle ships different defaults. */
describe('the entry point gamecrate actually imports', () => {
  test('carries the same defaults as src', async () => {
    const entry = pkg.exports['.'].default
    expect(entry).toBe(pkg.main)
    const built = await import(join(fileURLToPath(new URL('.', import.meta.url)), '..', entry))
    expect(built.default.defaults).toEqual(plugin.defaults)
  })
})
