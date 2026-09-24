import { join } from 'node:path'

import { mergeUserConfig } from '../config/load'
import { steamBuildSchema } from '../config/validate'
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
 * The keyed variable names its branch, so it answers whatever the config says. The bare one hits
 * every branch in a build, so it stays behind `password: true`.
 */
export function branchPassword(branch: SteamBranch): string | undefined {
  const key = branchPasswordKey(branch.name)
  const keyed = process.env[key]
  if (keyed !== undefined && keyed !== '') return keyed
  if (branch.password !== true) return undefined
  const bare = process.env.STEAM_BRANCH_PASSWORD
  if (bare === undefined || bare === '') {
    throw new GamecrateError(
      `branch "${branch.name}" needs a password and none is set`,
      Exit.Environment,
      `set ${key}, or STEAM_BRANCH_PASSWORD, when you build one branch`,
    )
  }
  return bare
}

/** A repo with no tag. A tag only exists after the last "/": before it a colon is a port. */
function repoOf(ref: string): string {
  const at = ref.indexOf('@')
  const head = at > 0 ? ref.slice(0, at) : ref
  const colon = head.lastIndexOf(':')
  return colon > head.lastIndexOf('/') ? head.slice(0, colon) : head
}

/**
 * `configured` is --image if given, else the config's ref. --load gets a default because a local
 * build has no registry to name; --push refuses, because a guessed path pushes to the wrong account.
 */
export function resolveImage(
  flags: { load: boolean; push: boolean },
  game: string,
  configured: string | undefined,
): string {
  if (configured !== undefined) return repoOf(configured)
  if (flags.push) {
    throw new GamecrateError(
      '--push needs a target repository',
      Exit.Usage,
      `pass --image <repo>, or set games.${game}.image.ref in a config file`,
    )
  }
  return `gamecrate/${game}-game`
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
  configFile?: string,
): Promise<SteamBuildInput> {
  const fromConfig = overrides.plugins === undefined && config?.plugins !== undefined
  const specs = overrides.plugins ?? config?.plugins ?? [`@gamecrate/${game}`]
  // a config's specs resolve against that config, or doctor and steam build read one line two ways.
  // --plugin and the convention get cwd: dirname of this path is where a bare package resolves from.
  const from = fromConfig && configFile !== undefined ? configFile : join(cwd, '.gamecrate.yaml')
  const plugins = await loadPlugins(specs, from)
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

  // a config-less build never reaches validateConfig, so the same refusals run here instead
  const steamBuild = want(merged.steamBuild, 'steamBuild')
  const checked = steamBuildSchema.safeParse(steamBuild)
  if (!checked.success) {
    const first = checked.error.issues[0]!
    throw new GamecrateError(
      `${game} steamBuild is wrong: ${first.message}`,
      Exit.Config,
      `at steamBuild.${first.path.join('.')}, declared by ${specs.join(', ')}`,
    )
  }

  const push = overrides.push === true
  const image = resolveImage({ load: !push, push }, game, overrides.image ?? merged.image?.ref)

  return {
    game,
    steamAppId: want(merged.steamAppId, 'steamAppId'),
    versionFile: want(merged.version, 'version.file').file,
    gamePath: want(merged.gameFiles, 'gameFiles').container,
    executable: want(merged.executable, 'executable'),
    branches: steamBuild.branches,
    variants: steamBuild.variants,
    // OCI references are lowercase. A registry owner or repo can be mixed case on the web.
    image: image.toLowerCase(),
  }
}
