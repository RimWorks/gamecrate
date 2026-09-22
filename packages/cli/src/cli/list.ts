import { basename } from 'node:path'

import { requireGame } from './game'
import { Exit, own } from '../types'
import type { ParsedArgs, ProfileConfig, ProjectDefaults, RootConfig } from '../types'

type FromProject = (game: string, profile: string) => boolean

export function list(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults): number {
  const games = args.game === undefined ? Object.keys(config.games) : [requireGame(args, config)]
  const fromProject: FromProject = (game, profile) =>
    defaults.game === game && own(defaults.profiles, profile) !== undefined

  if (args.json) {
    process.stdout.write(`${JSON.stringify(jsonReport(games, config, fromProject), null, 2)}\n`)
    return Exit.Ok
  }

  // four suffixes are legal, so naming one of them outright is wrong three times out of four
  const source =
    defaults.configPath === undefined ? 'the .gamecrate project config' : basename(defaults.configPath)

  const out: string[] = []
  for (const name of games) {
    const game = config.games[name]!
    const width = Math.max(7, ...Object.keys(game.profiles).map((n) => n.length))
    out.push(`${name}  (${game.modes.join(', ')})`, `  ${'modless'.padEnd(width)}  built-in: core + official DLC`)
    for (const [profile, spec] of Object.entries(game.profiles)) {
      out.push(...profileRows(profile, spec, width, profileNotes(spec, fromProject(name, profile), source)))
    }
  }
  process.stdout.write(`${out.join('\n')}\n`)
  return Exit.Ok
}

function jsonReport(games: string[], config: RootConfig, fromProject: FromProject): unknown[] {
  return games.map((name) => {
    const game = config.games[name]!
    return {
      game: name,
      core: game.core,
      dlc: game.dlc,
      modes: game.modes,
      profiles: Object.entries(game.profiles).map(([profile, spec]) => ({
        profile,
        alias: spec.alias ?? null,
        description: spec.description ?? null,
        extends: spec.extends ?? null,
        mods: spec.mods?.length ?? 0,
        instances: Object.keys(spec.instances ?? {}),
        source: fromProject(name, profile) ? 'project' : 'config',
      })),
    }
  })
}

function profileNotes(spec: ProfileConfig, isProject: boolean, source: string): string[] {
  const notes: string[] = []
  if (spec.alias) notes.push(`alias for ${spec.alias}`)
  if (spec.extends) notes.push(`extends ${spec.extends}`)
  const count = spec.mods?.length ?? 0
  if (!spec.alias) notes.push(count === 1 ? '1 entry' : `${count} entries`)
  if (spec.aliases?.length) notes.push(`aka ${spec.aliases.join(', ')}`)
  if (isProject) notes.push(`from ${source}`)
  return notes
}

function profileRows(profile: string, spec: ProfileConfig, width: number, notes: string[]): string[] {
  const pad = ' '.repeat(width)
  const rows = [`  ${profile.padEnd(width)}  ${notes.join(', ')}`]
  if (spec.description) rows.push(`  ${pad}  ${spec.description}`)
  const instances = Object.keys(spec.instances ?? {})
  if (instances.length > 0) rows.push(`  ${pad}  instances: ${instances.join(', ')}`)
  return rows
}
