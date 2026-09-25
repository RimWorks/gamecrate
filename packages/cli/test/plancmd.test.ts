import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLUGIN_API_VERSION } from '../src/plugin'
import { FIXTURE_DEFAULTS } from './fixture-plugin'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const temps: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

/** The fixture codec, small enough to inline: one `key value` per line, packageId is all we read. */
const PLUGIN = `export default {
  apiVersion: ${PLUGIN_API_VERSION},
  game: 'atlas',
  defaults: ${JSON.stringify(FIXTURE_DEFAULTS)},
  parseManifest: (text) => {
    const found = /^packageId (.+)$/m.exec(text)
    if (!found) return null
    return {
      packageId: found[1].trim(),
      modDependencies: [], loadAfter: [], loadBefore: [],
      forceLoadAfter: [], forceLoadBefore: [], incompatibleWith: [],
    }
  },
  renderModsConfig: () => '',
  mergePrefs: () => '',
  windowedPrefs: {},
  parseVersion: () => null,
}
`

function writeMod(dir: string, packageId: string): void {
  mkdirSync(join(dir, 'About'), { recursive: true })
  writeFileSync(join(dir, 'About', 'About.txt'), `packageId ${packageId}\nname ${packageId}\n`)
}

/** A config whose profile names one workshop id that is on no mounted root. */
function workspace(): { env: NodeJS.ProcessEnv } {
  const dir = temp('gc-plancmd-')
  const pluginDir = join(dir, 'plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'gamecrate-atlas', type: 'module', main: './plugin.js' }))
  writeFileSync(join(pluginDir, 'plugin.js'), PLUGIN)

  const mods = join(dir, 'mods')
  writeMod(join(mods, 'Core'), 'Atlasco.Atlas')

  mkdirSync(join(dir, 'cfg', 'gamecrate'), { recursive: true })
  writeFileSync(
    join(dir, 'cfg', 'gamecrate', 'profiles.json'),
    JSON.stringify({
      dataRoot: join(dir, 'data'),
      plugins: [pluginDir],
      games: {
        atlas: {
          image: { ref: 'atlas:latest', acquire: 'pull' },
          scanRoots: [{ path: mods, maxDepth: 2 }],
          workshopRoot: join(dir, 'workshop'),
          profiles: { dsd: { mods: ['workshop:2009463077'] } },
        },
      },
    }),
  )
  return { env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'cfg') } }
}

/**
 * The relabel only helps if the plan still prints. `mods` shares the split with --print-plan and
 * --dry-run, and needs no docker, so it is the one that can run here.
 */
test('mods prints a provisional plan for an unfetched workshop id instead of failing', () => {
  const { env } = workspace()
  const run = spawnSync('bun', [join(ROOT, 'src', 'index.ts'), 'mods', 'atlas', 'dsd'], { cwd: tmpdir(), env })
  const out = run.stdout.toString() + run.stderr.toString()
  expect(out).toContain('a real launch would fetch it')
  expect(out).toContain('this plan is provisional')
  expect(run.status).toBe(0)
}, 30_000)
