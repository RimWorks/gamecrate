import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writePluginPackage } from './fixture-plugin'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * Bun's compiled binaries never read a plugin's own package.json, so main and exports are
 * invisible there and only `bun test` passing proves nothing. This is the case that regressed.
 */
test('a compiled binary loads plugins by package name and by directory path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gamecrate-compiled-'))
  const bin = join(dir, 'gamecrate')
  const build = spawnSync('bun', ['build', './src/index.ts', '--compile', '--outfile', bin], { cwd: ROOT })
  expect(build.status).toBe(0)

  await writePluginPackage(join(dir, 'cfg', 'gamecrate', 'node_modules', 'gamecrate-atlas'), {
    '.': { bun: './dist/plugin.js', browser: './nope.js' },
  })
  await writePluginPackage(join(dir, 'checkout'), { '.': './dist/plugin.js' }, 'borea')
  await writeFile(
    join(dir, 'cfg', 'gamecrate', 'profiles.json'),
    `{
      "plugins": ["gamecrate-atlas", ${JSON.stringify(join(dir, 'checkout'))}],
      "games": { "atlas": { "dlc": ["atlasco.atlas.one"], "profiles": { "solo": { "mods": [] } } } }
    }`,
  )

  // Run from outside the repo, the way an installed binary is used.
  const run = spawnSync(bin, ['list', '--json'], {
    cwd: tmpdir(),
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'cfg') },
  })
  const out = run.stdout.toString() + run.stderr.toString()
  expect(run.status).toBe(0)
  const games = JSON.parse(run.stdout.toString()) as { game: string; dlc: string[]; profiles: unknown[] }[]
  expect(games.map((g) => g.game).sort()).toEqual(['atlas', 'borea'])
  // The user block reached the merged config: the plugin ships no dlc and no profiles.
  const atlas = games.find((g) => g.game === 'atlas')!
  expect(atlas.dlc).toEqual(['atlasco.atlas.one'])
  expect(atlas.profiles).toHaveLength(1)
  expect(out).toContain('borea')
}, 60_000)
