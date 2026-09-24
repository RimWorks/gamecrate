import { Exit, GamecrateError } from '../types'
import type { GameConfig, ParsedArgs, ProjectDefaults } from '../types'

/**
 * Not in parseArgs: filling a default there would erase the difference between a typed
 * profile and a defaulted one, which clean and fix-perms both need.
 */
export function profileOf(args: ParsedArgs, defaults: ProjectDefaults): string {
  return args.profile ?? defaults.defaultProfile ?? defaults.profileOrder?.[0] ?? 'modless'
}

/**
 * The launch path, where a silent fallback to modless drops every mod the game needs. With no
 * profile configured there is nothing to be ambiguous about, so modless still answers.
 */
export function launchProfile(args: ParsedArgs, defaults: ProjectDefaults, game: GameConfig): string {
  const named = args.profile ?? defaults.defaultProfile ?? defaults.profileOrder?.[0]
  if (named !== undefined) return named
  const known = Object.keys(game.profiles)
  if (known.length === 0) return 'modless'
  throw new GamecrateError(
    'no profile named, and no defaultProfile is set',
    Exit.Usage,
    `known profiles: ${[...known, 'modless'].join(', ')}. set defaults.defaultProfile to pick one every time`,
  )
}
