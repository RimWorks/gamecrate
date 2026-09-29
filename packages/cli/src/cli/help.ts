import type { GameConfig, ProfileConfig, RootConfig } from '../types'
import { GamecrateError, Exit, own } from '../types'
import type { Option } from 'commander'
import {
  FLAG_ENV,
  GLOBAL_FLAGS,
  SUBCOMMANDS,
  VERB_GROUPS,
  publicOptions,
  shapeOf,
  suggest,
} from './args'
import type { SubcommandSpec, SubverbSpec } from './args'
import { profileNames } from '../config/load'

const NAME = 'gamecrate'

/**
 * Three levels: no topic gives the top level, a subcommand name gives its usage,
 * a game name gives that game's profiles and modes.
 */
export function renderHelp(topics: readonly string[] = [], config?: RootConfig): string {
  const topic = topics[0]
  if (topic === undefined) return topLevel(config)

  const sub = SUBCOMMANDS.find((s) => s.name === topic)
  if (sub) {
    const word = topics[1]
    if (word === undefined) return subcommandHelp(sub)
    const spec = own(sub.subverbs, word)
    if (spec) return subverbHelp(sub, word, spec)
    const names = Object.keys(sub.subverbs ?? {})
    throw new GamecrateError(
      `${sub.name} has no subverb ${word}`,
      Exit.Usage,
      names.length === 0 ? `${sub.name} takes no subverb` : `subverbs: ${names.join(', ')}`,
    )
  }

  const game = own(config?.games, topic)
  if (game) return gameHelp(topic, game)

  const names = config === undefined ? {} : profileNames(config)
  const owners = Object.keys(names).filter((g) =>
    (own(names, g) ?? []).some((p) => p.toLowerCase() === topic.toLowerCase()),
  )
  if (owners.length === 1) return gameHelp(owners[0]!, config!.games[owners[0]!]!)
  if (owners.length > 1) {
    const picks = owners.map((g) => `${NAME} help ${g}`).join(' or ')
    throw new GamecrateError(
      `${owners.length} games declare a profile named ${topic}: ${owners.join(', ')}`,
      Exit.Usage,
      `name the game: ${picks}`,
    )
  }

  const candidates = [
    ...SUBCOMMANDS.map((s) => s.name),
    ...Object.keys(config?.games ?? {}),
    ...Object.values(names).flat(),
  ]
  const hint = suggest(topic, candidates)
  throw new GamecrateError(
    `no help topic ${topic}`,
    Exit.Usage,
    hint ? `did you mean ${hint}?` : `topics: ${candidates.join(', ')}`,
  )
}

function topLevel(config?: RootConfig): string {
  const lines = [
    `${NAME}: run a modded game in a container`,
    '',
    'usage:',
    `  ${NAME} run <profile> [flags] [-- game args]`,
    `  ${NAME} <subcommand> [args] [flags]`,
  ]

  for (const group of VERB_GROUPS) {
    const verbs = SUBCOMMANDS.filter((s) => s.group === group.name)
    if (verbs.length === 0) continue
    lines.push('', `${group.title}:`, ...columns(verbs.map((s) => [s.name, s.summary] as const), 2))
  }

  const globals: readonly string[] = GLOBAL_FLAGS
  const global = publicOptions().filter((f) => globals.includes(f.long ?? ''))
  lines.push('', 'Everywhere:', ...columns(global.map(flagRow), 2))

  const games = Object.entries(config?.games ?? {})
  if (games.length > 0) {
    lines.push(
      '',
      'Games:',
      ...columns(games.map(([name, game]) => [name, gameSummary(game)] as const), 2),
    )
  }

  lines.push(
    '',
    `${NAME} help <subcommand> lists its flags.`,
    `${NAME} help <game> lists that game's profiles.`,
    'Anything after a bare -- goes to the game itself.',
    'A GAMECRATE_ env var stands in for a flag you leave out.',
  )
  return lines.join('\n') + '\n'
}

function subcommandHelp(sub: SubcommandSpec): string {
  const verbs = Object.entries(sub.subverbs ?? {})
  const usage =
    sub.needsSubverb === true
      ? [`usage: ${NAME} ${sub.name} <subverb> [args] [flags]`]
      : [`usage: ${NAME} ${shapeOf(sub)} [flags]`]
  const lines = [...usage, '', `  ${sub.summary}`]

  if (verbs.length > 0) {
    lines.push('', 'Subverbs:', ...columns(verbs.map(([verb, spec]) => [`${verb} ${spec.usage}`.trim(), spec.summary] as const), 2))
  }

  lines.push(...flagBlock([...sub.flags, ...GLOBAL_FLAGS]))

  if (verbs.length > 0) {
    lines.push('', `  ${NAME} help ${sub.name} <subverb> lists that subverb's own flags.`)
  }
  if (sub.name === 'run') {
    lines.push(
      '',
      '  A profile belongs to one game, so the profile alone names it.',
    )
  }
  return lines.join('\n') + '\n'
}

function subverbHelp(sub: SubcommandSpec, verb: string, spec: SubverbSpec): string {
  const lines = [
    `usage: ${NAME} ${shapeOf(sub, verb)} [flags]`,
    '',
    `  ${spec.summary}`,
    ...flagBlock([...spec.flags, ...sub.flags, ...GLOBAL_FLAGS]),
  ]
  return lines.join('\n') + '\n'
}

function flagBlock(names: readonly string[]): string[] {
  const all = publicOptions()
  const seen = new Set<string>()
  const specs = names
    .filter((name) => !seen.has(name) && seen.add(name) !== undefined)
    .map((name) => all.find((f) => f.long === name))
    .filter((f): f is Option => f !== undefined)
  return specs.length === 0 ? [] : ['', 'Flags:', ...columns(specs.map(flagRow), 2)]
}

function gameHelp(name: string, game: GameConfig): string {
  const lines = [`usage: ${NAME} run <profile> [flags] [-- game args]`, '', `Profiles for ${name}:`]

  const rows: (readonly [string, string])[] = Object.entries(game.profiles).map(
    ([profile, config]) => [profile, profileNotes(config)] as const,
  )
  if (rows.length === 0) rows.push(['(none declared)', ''])
  lines.push(...columns(rows, 2))

  if (game.aliases && Object.keys(game.aliases).length > 0) {
    lines.push('', 'Mod name aliases:', ...columns(Object.entries(game.aliases).map(([k, v]) => [k, v] as const), 2))
  }

  lines.push('', `modes: ${game.modes.join(', ')}`, `core: ${game.core}`)
  if (game.dlc.length > 0) lines.push(`dlc: ${game.dlc.join(', ')}`)
  lines.push(`game files: ${game.gameFiles.source === 'mount' ? game.gameFiles.host ?? '(unset)' : game.image.ref}`)
  return lines.join('\n') + '\n'
}

function profileNotes(config: ProfileConfig): string {
  const notes: string[] = []
  if (config.alias) notes.push(`alias for ${config.alias}`)
  if (config.extends) notes.push(`extends ${config.extends}`)
  if (config.autoDependencies === false) notes.push('no auto dependencies')
  const count = config.mods?.length ?? 0
  if (!config.alias) notes.push(count === 1 ? '1 entry' : `${count} entries`)
  if (config.aliases?.length) notes.push(`aka ${config.aliases.join(', ')}`)
  return notes.join(', ')
}

function gameSummary(game: GameConfig): string {
  const count = Object.keys(game.profiles).length
  const profiles = count === 1 ? '1 profile' : `${count} profiles`
  return `${profiles}; modes ${game.modes.join(', ')}`
}

function flagRow(spec: Option): readonly [string, string] {
  const notes: string[] = []
  if (Array.isArray(spec.defaultValue)) notes.push('repeatable')
  const env = FLAG_ENV[spec.long ?? '']
  if (env) notes.push(`$${env}`)
  const summary = spec.description
  return [spec.flags, notes.length > 0 ? `${summary} (${notes.join(', ')})` : summary]
}

function columns(rows: readonly (readonly [string, string])[], indent: number): string[] {
  const width = Math.max(0, ...rows.map((r) => r[0].length))
  const pad = ' '.repeat(indent)
  return rows.map(([left, right]) => (right ? `${pad}${left.padEnd(width)}  ${right}` : `${pad}${left}`))
}
