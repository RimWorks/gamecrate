import { describe, expect, test } from 'bun:test'
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

  test('no default carries a path off this machine', () => {
    expect(JSON.stringify(plugin.defaults)).not.toContain('/home/')
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
