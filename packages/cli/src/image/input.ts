import { join } from 'node:path'

import { mergeUserConfig } from '../config/load'
import { loadPlugins } from '../plugin'
import { Exit, GamecrateError } from '../types'
import type { GameConfig, RootConfig, SteamBranch, SteamVariant } from '../types'

export interface SteamBuildInput {
  game: string
  steamAppId: number
  versionFile: string
  gamePath: string
  executable: string
  branches: SteamBranch[]
  variants: SteamVariant[]
  /** Target repo, never a tag. p3-t1 supplies the tags. */
  image: string
}

export interface SteamBuildOverrides {
  /** --image, a repo with no tag. */
  image?: string
  /** --plugin, repeatable. Skips the @gamecrate/<game> convention. */
  plugins?: string[]
  /** --push. Only a push makes --image mandatory. */
  push?: boolean
}

/** "1.5-test" -> "STEAM_BRANCH_PASSWORD_1_5_TEST" */
export function branchPasswordKey(branch: string): string {
  return `STEAM_BRANCH_PASSWORD_${branch.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`
}

/**
 * undefined for a branch that needs no password. Throws Exit.Environment when one does and
 * neither variable is set, naming the exact variable it looked for.
 */
export function branchPassword(branch: SteamBranch): string | undefined {
  if (branch.password !== true) return undefined
  const key = branchPasswordKey(branch.name)
  const value = process.env[key] ?? process.env.STEAM_BRANCH_PASSWORD
  if (value === undefined || value === '') {
    throw new GamecrateError(
      `branch "${branch.name}" needs a password and none is set`,
      Exit.Environment,
      `set ${key}, or STEAM_BRANCH_PASSWORD, when you build one branch`,
    )
  }
  return value
}

/** A repo with no tag. A tag only exists after the last "/": before it a colon is a port. */
function repoOf(ref: string): string {
  const at = ref.indexOf('@')
  const head = at > 0 ? ref.slice(0, at) : ref
  const colon = head.lastIndexOf(':')
  return colon > head.lastIndexOf('/') ? head.slice(0, colon) : head
}

/**
 * The loader's merge, over one game. `steamBuild.branches` concatenates there and replaces in
 * deepMerge, so calling deepMerge here would give `steam build` a different branch set than `run`.
 */
function mergeForGame(game: string, defaults: Partial<GameConfig>, config: RootConfig | null): Partial<GameConfig> {
  const base = { dataRoot: '', games: { [game]: defaults as GameConfig } } as RootConfig
  const user = { games: { [game]: config?.games?.[game] ?? {} } }
  return mergeUserConfig(base, user).games[game] as Partial<GameConfig>
}

/**
 * Plugin defaults, then games.<game> when a config exists, then the flags. The same
 * one-direction merge the loader already does, over fewer fields.
 */
export async function resolveSteamBuildInput(
  game: string,
  config: RootConfig | null,
  overrides: SteamBuildOverrides,
  cwd: string,
): Promise<SteamBuildInput> {
  const specs = overrides.plugins ?? config?.plugins ?? [`@gamecrate/${game}`]
  // dirname of this path is cwd, which is where a bare package spec resolves from
  const plugins = await loadPlugins(specs, join(cwd, '.gamecrate.yaml'))
  const plugin = plugins.get(game)
  if (plugin === undefined) {
    throw new GamecrateError(
      `no plugin provides the game "${game}"`,
      Exit.Resolution,
      `tried: ${specs.join(', ')}. loaded: ${[...plugins.keys()].join(', ') || '(none)'}`,
    )
  }

  const merged = mergeForGame(game, plugin.defaults, config)

  const want = <T>(value: T | undefined, key: string): T => {
    if (value === undefined) {
      throw new GamecrateError(
        `${game} has no ${key}`,
        Exit.Config,
        `the plugin ${specs.join(', ')} must declare ${key} in its defaults`,
      )
    }
    return value
  }

  const configured = merged.image?.ref === undefined ? undefined : repoOf(merged.image.ref)
  const image =
    overrides.image ?? configured ?? (overrides.push === true ? undefined : `gamecrate/${game}-game`)
  if (image === undefined) {
    throw new GamecrateError(
      '--push needs a target repo',
      Exit.Usage,
      `pass --image <repo>, or set games.${game}.image.ref in a config`,
    )
  }

  return {
    game,
    steamAppId: want(merged.steamAppId, 'steamAppId'),
    versionFile: want(merged.version, 'version.file').file,
    gamePath: want(merged.gameFiles, 'gameFiles').container,
    executable: want(merged.executable, 'executable'),
    branches: want(merged.steamBuild, 'steamBuild').branches,
    variants: want(merged.steamBuild, 'steamBuild').variants,
    // OCI references are lowercase. A registry owner or repo can be mixed case on the web.
    image: image.toLowerCase(),
  }
}
