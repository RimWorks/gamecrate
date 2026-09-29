import { GamecrateError, Exit } from '../types'
import type { ParsedArgs, RootConfig } from '../types'
import { profileNames } from '../config/load'

function known(config: RootConfig): string {
  const games = Object.keys(config.games)
  if (games.length === 0) return 'no config names a game'
  const profiles = Object.values(profileNames(config)).flat()
  const head = `known games: ${games.join(', ')}`
  return profiles.length === 0 ? head : `${head}; known profiles: ${profiles.join(', ')}`
}

/** The game that was named, without asking the config whether it declares it. */
export function namedGame(args: ParsedArgs, config: RootConfig): string {
  const game = args.game
  if (game !== undefined) return game
  const verb = args.subverb === undefined ? args.subcommand : `${args.subcommand} ${args.subverb}`
  throw new GamecrateError(
    `${verb} could not tell which game you mean`,
    Exit.Usage,
    `${known(config)}. name a profile, pass --game, or set game: in a .gamecrate.yml`,
  )
}

export function requireGame(args: ParsedArgs, config: RootConfig): string {
  const game = namedGame(args, config)
  if (!Object.hasOwn(config.games, game)) {
    throw new GamecrateError(`unknown game "${game}"`, Exit.Config, known(config))
  }
  return game
}
