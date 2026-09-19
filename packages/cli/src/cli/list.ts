import { basename } from 'node:path'

import { requireGame } from './game'
import { Exit, own } from '../types'
import type { ParsedArgs, ProjectDefaults, RootConfig } from '../types'

export function list(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults): number {
  const games = args.game === undefined ? Object.keys(config.games) : [requireGame(args, config)]
  const fromProject = (game: string, profile: string): boolean =>
    defaults.game === game && own(defaults.profiles, profile) !== undefined

  if (args.json) {
    const payload = games.map((name) => {
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
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return Exit.Ok
  }

  // four suffixes are legal, so naming one of them outright is wrong three times out of four
  const source =
    defaults.configPath === undefined ? 'the .gamecrate project config' : basename(defaults.configPath)

  const out: string[] = []
  for (const name of games) {
    const game = config.games[name]!
    const width = Math.max(7, ...Object.keys(game.profiles).map((n) => n.length))
    out.push(`${name}  (${game.modes.join(', ')})`)
    out.push(`  ${'modless'.padEnd(width)}  built-in: core + official DLC`)
    for (const [profile, spec] of Object.entries(game.profiles)) {
      const notes: string[] = []
      if (spec.alias) notes.push(`alias for ${spec.alias}`)
      if (spec.extends) notes.push(`extends ${spec.extends}`)
      const count = spec.mods?.length ?? 0
      if (!spec.alias) notes.push(count === 1 ? '1 entry' : `${count} entries`)
      if (spec.aliases?.length) notes.push(`aka ${spec.aliases.join(', ')}`)
      if (fromProject(name, profile)) notes.push(`from ${source}`)
      out.push(`  ${profile.padEnd(width)}  ${notes.join(', ')}`)
      if (spec.description) out.push(`  ${' '.repeat(width)}  ${spec.description}`)
      const instances = Object.keys(spec.instances ?? {})
      if (instances.length > 0) out.push(`  ${' '.repeat(width)}  instances: ${instances.join(', ')}`)
    }
  }
  process.stdout.write(`${out.join('\n')}\n`)
  return Exit.Ok
}
