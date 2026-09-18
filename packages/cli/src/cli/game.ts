import { GamecrateError, Exit } from '../types'
import type { ParsedArgs, RootConfig } from '../types'

export function requireGame(args: ParsedArgs, config: RootConfig): string {
  const game = args.game
  if (game === undefined) {
    throw new GamecrateError(
      `${args.subcommand} needs a game`,
      Exit.Usage,
      `known games: ${Object.keys(config.games).join(', ')}`,
    )
  }
  if (!Object.hasOwn(config.games, game)) {
    throw new GamecrateError(
      `unknown game "${game}"`,
      Exit.Config,
      `known games: ${Object.keys(config.games).join(', ')}`,
    )
  }
  return game
}
