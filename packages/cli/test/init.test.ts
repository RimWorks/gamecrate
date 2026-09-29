import { describe, expect, test } from 'bun:test'
import { readPlugins, renderGlobalConfig, renderProjectConfig } from '../src/cli/init'
import type { InitAnswers } from '../src/cli/init'
import { validateConfig } from '../src/config/validate'
import { parse } from 'yaml'

const ANSWERS: InitAnswers = {
  game: 'rimworld',
  plugin: '@gamecrate/rimworld',
  host: '/home/me/games/rimworld',
  profile: 'dev',
}

function search(names: [string, string][]): string {
  return JSON.stringify({ objects: names.map(([name, version]) => ({ package: { name, version } })) })
}

describe('readPlugins', () => {
  test('keeps every @gamecrate plugin and drops the cli itself', () => {
    const found = readPlugins(
      search([
        ['@gamecrate/rimworld', '2.1.0'],
        ['@gamecrate/cli', '2.5.0'],
        ['@gamecrate/factorio', '0.3.0'],
      ]),
    )
    expect(found.map((p) => p.game)).toEqual(['factorio', 'rimworld'])
    expect(found.find((p) => p.game === 'rimworld')?.version).toBe('2.1.0')
  })

  test('a package outside the scope is never offered', () => {
    const found = readPlugins(
      search([
        ['rimworld-save-editor', '1.3.3'],
        ['@gamecrate/rimworld', '2.1.0'],
        ['rw-lazy-installer', '1.6.0'],
      ]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('@gamecrate/rimworld')
  })

  test('a body that is not json is no plugins, not a throw', () => {
    expect(readPlugins('<html>502</html>')).toEqual([])
    expect(readPlugins('')).toEqual([])
  })

  test('an entry missing a name or version is skipped', () => {
    const body = JSON.stringify({ objects: [{ package: { name: '@gamecrate/x' } }, { package: {} }, {}] })
    expect(readPlugins(body)).toEqual([])
  })
})

describe('the config init writes', () => {
  // regression: a config missing the host fails to load, and no plugin default supplies it
  test('supplies the one key a plugin cannot', () => {
    const cfg = parse(renderGlobalConfig(ANSWERS)) as {
      games: { rimworld: { gameFiles: { host: string } } }
    }
    expect(cfg.games.rimworld.gameFiles.host).toBe('/home/me/games/rimworld')
  })

  test('every key it writes is one the validator knows', () => {
    const { problems } = validateConfig(parse(renderGlobalConfig(ANSWERS)))
    expect(problems.filter((p) => !p.message.startsWith('missing required key'))).toEqual([])
  })

  test('names the plugin so the loader can resolve it', () => {
    expect(renderGlobalConfig(ANSWERS)).toContain("plugins: ['@gamecrate/rimworld']")
  })

  test('it names no image, so the built-in runtime fills it in', () => {
    const parsed = parse(renderGlobalConfig(ANSWERS)) as {
      games: { rimworld: Record<string, unknown> }
    }
    expect(Object.keys(parsed.games.rimworld)).not.toContain('image')
  })

  test('the project config names the game and the profile', () => {
    const parsed = parse(renderProjectConfig(ANSWERS)) as Record<string, unknown>
    expect(parsed['game']).toBe('rimworld')
    expect(parsed['defaultProfile']).toBe('dev')
    expect(parsed['profiles']).toHaveProperty('dev')
  })

  test('a profile name with a period survives, since the parser allows one', () => {
    const text = renderGlobalConfig({ ...ANSWERS, profile: 'v1.6' })
    const parsed = parse(text) as { games: { rimworld: { profiles: Record<string, unknown> } } }
    expect(Object.keys(parsed.games.rimworld.profiles)).toEqual(['v1.6'])
  })
})
