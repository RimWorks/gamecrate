import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLUGIN_API_VERSION } from '../src/plugin'
import { FIXTURE_DEFAULTS, writePluginPackage } from './fixture-plugin'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ENTRY = join(ROOT, 'dist', 'gamecrate.js')

// plain node cannot run src directly, the imports are extensionless, so bundle first.
beforeAll(() => {
  const build = spawnSync(
    'bun',
    ['build', './src/index.ts', '--target=node', '--packages=external', '--outfile', ENTRY],
    { cwd: ROOT },
  )
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr?.toString() ?? ''}`)
}, 60_000)

/**
 * A whole config tree plus a docker stub, so a `run` can reach exit 0 without a daemon.
 * The stub only ever has to succeed: preflight reads exit codes, not output.
 */
async function fixture(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'gamecrate-runlog-'))
  const pkg = join(dir, 'cfg', 'gamecrate', 'node_modules', 'gamecrate-atlas')
  await writePluginPackage(pkg, { '.': { bun: './dist/plugin.js' } })

  const defaults = {
    ...FIXTURE_DEFAULTS,
    gameFiles: { source: 'mount', host: join(dir, 'game'), container: '/game' },
    image: { ref: 'atlas-build:latest', acquire: 'build', context: join(dir, 'docker') },
  }
  await writeFile(
    join(pkg, 'dist', 'plugin.js'),
    `export default {
      apiVersion: ${PLUGIN_API_VERSION},
      game: 'atlas',
      defaults: ${JSON.stringify(defaults)},
      parseManifest: (text) => {
        const m = /packageId (\\S+)/.exec(text)
        return m ? { packageId: m[1], modDependencies: [], loadAfter: [], loadBefore: [], forceLoadAfter: [], forceLoadBefore: [], incompatibleWith: [] } : null
      },
      renderModsConfig: (input) => 'active ' + input.activeMods.join(' ') + '\\n',
      mergePrefs: (existing, owned) => Object.entries(owned).map(([k, v]) => k + ' ' + v).join('\\n') + '\\n',
      windowedPrefs: {},
      parseVersion: () => null,
    }\n`,
  )

  await mkdir(join(dir, 'mods', 'Core', 'About'), { recursive: true })
  await writeFile(join(dir, 'mods', 'Core', 'About', 'About.txt'), 'packageId atlasco.atlas\n')
  await mkdir(join(dir, 'game'), { recursive: true })
  await writeFile(join(dir, 'game', 'AtlasLinux'), '')
  await mkdir(join(dir, 'bin'), { recursive: true })
  // image inspect has to answer: an id, and a gamecrate.runtime label, or a headless plan is refused.
  await writeFile(join(dir, 'bin', 'docker'), '#!/bin/sh\ncase "$1 $2" in "image inspect") echo stub;; esac\nexit 0\n')
  await chmod(join(dir, 'bin', 'docker'), 0o755)

  await writeFile(
    join(dir, 'cfg', 'gamecrate', 'profiles.json'),
    JSON.stringify({
      plugins: ['gamecrate-atlas'],
      dataRoot: join(dir, 'data'),
      games: {
        atlas: {
          scanRoots: [{ path: join(dir, 'mods'), maxDepth: 2 }],
          profiles: { solo: { mods: [], settings: { gpu: false, audio: false, input: false } } },
        },
      },
    }),
  )

  return {
    dir,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
      XDG_CONFIG_HOME: join(dir, 'cfg'),
      XDG_CACHE_HOME: join(dir, 'cache'),
    },
  }
}

function run(argv: string[], env: Record<string, string>) {
  const proc = spawnSync(process.execPath, [ENTRY, ...argv], { cwd: tmpdir(), env })
  return { code: proc.status, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

describe('--log', () => {
  test('a usage failure lands in the log, not on the terminal', async () => {
    const { dir, env } = await fixture()
    const log = join(dir, 'usage.log')
    const result = run(['run', '--log', log], env)
    expect(result.code).toBe(2)
    expect(result.stdout + result.stderr).toBe('')
    expect(await readFile(log, 'utf8')).toContain('run needs a game')
  }, 30_000)

  test('a config failure lands in the log, not on the terminal', async () => {
    const { dir, env } = await fixture()
    const log = join(dir, 'config.log')
    const result = run(['run', 'nope', '--log', log], env)
    expect(result.code).toBe(3)
    expect(result.stdout + result.stderr).toBe('')
    expect(await readFile(log, 'utf8')).toContain('unknown game "nope"')
  }, 30_000)

  test('a successful run writes its report to the log and exits 0', async () => {
    const { dir, env } = await fixture()
    const log = join(dir, 'ok.log')
    const result = run(['run', 'atlas', 'solo', '--mode', 'headless', '--print-plan', '--json', '--log', log], env)
    expect(result.stdout + result.stderr).toBe('')
    expect(result.code).toBe(0)
    const plan = JSON.parse(await readFile(log, 'utf8')) as { game: string; mods: unknown[] }
    expect(plan.game).toBe('atlas')
    expect(plan.mods).toHaveLength(1)
  }, 30_000)
})
