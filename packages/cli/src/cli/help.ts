import type { GameConfig, ProfileConfig, RootConfig } from '../types'
import { GamecrateError, Exit, own } from '../types'
import type { Option } from 'commander'
import { FLAG_ENV, GLOBAL_FLAGS, SUBCOMMANDS, buildProgram, suggest } from './args'
import type { SubcommandSpec } from './args'

const NAME = 'gamecrate'

/** Help and completion describe whatever the parser accepts, minus the hidden internals. */
function flags(): readonly Option[] {
  return buildProgram().options.filter((o) => !o.hidden)
}

/**
 * Three levels: no topic gives the top level, a subcommand name gives its usage,
 * a game name gives that game's profiles and modes.
 */
export function renderHelp(topic?: string, config?: RootConfig): string {
  if (!topic) return topLevel(config)

  const sub = SUBCOMMANDS.find((s) => s.name === topic)
  if (sub) return subcommandHelp(sub)

  const game = own(config?.games, topic)
  if (game) return gameHelp(topic, game)

  const candidates = [...SUBCOMMANDS.map((s) => s.name), ...Object.keys(config?.games ?? {})]
  const hint = suggest(topic, candidates)
  throw new GamecrateError(
    `no help topic ${topic}`,
    Exit.Usage,
    hint ? `did you mean ${hint}?` : `topics: ${candidates.join(', ')}`,
  )
}

function topLevel(config?: RootConfig): string {
  const lines = [
    `${NAME}: run modded games in containers`,
    '',
    'usage:',
    `  ${NAME} <game> [profile] [flags] [-- game args]`,
    `  ${NAME} <subcommand> [args] [flags]`,
    '',
    'subcommands:',
  ]

  const verbs = SUBCOMMANDS.map((s) => [`${s.name} ${s.usage}`.trim(), s.summary] as const)
  lines.push(...columns(verbs, 2), '', 'flags:', ...columns(flags().map(flagRow), 2))

  const games = Object.entries(config?.games ?? {})
  if (games.length > 0) {
    lines.push(
      '',
      'games:',
      ...columns(games.map(([name, game]) => [name, gameSummary(game)] as const), 2),
      '',
      `${NAME} help <game> lists that game's profiles.`,
    )
  }

  lines.push('', 'Game args go after a bare --. Env vars are GAMECRATE_ prefixed fallbacks only.')
  return lines.join('\n') + '\n'
}

function subcommandHelp(sub: SubcommandSpec): string {
  const lines = [`usage: ${NAME} ${sub.name} ${sub.usage}`.trimEnd() + ' [flags]', '', `  ${sub.summary}`]

  const names = [...sub.flags, ...GLOBAL_FLAGS]
  const all = flags()
  const specs = names
    .map((name) => all.find((f) => f.long === name))
    .filter((f): f is Option => f !== undefined)
  if (specs.length > 0) {
    lines.push('', 'flags:', ...columns(specs.map(flagRow), 2))
  }
  if (sub.name === 'run') {
    lines.push('', `  The subcommand slot defaults to run, so \`${NAME} <game> <profile>\` works.`)
  }
  return lines.join('\n') + '\n'
}

function gameHelp(name: string, game: GameConfig): string {
  const lines = [`usage: ${NAME} ${name} [profile] [flags] [-- game args]`, '', 'profiles:']

  const rows: (readonly [string, string])[] = Object.entries(game.profiles).map(
    ([profile, config]) => [profile, profileNotes(config)] as const,
  )
  if (rows.length === 0) rows.push(['(none declared)', ''])
  lines.push(...columns(rows, 2))

  if (game.aliases && Object.keys(game.aliases).length > 0) {
    lines.push('', 'mod name aliases:', ...columns(Object.entries(game.aliases).map(([k, v]) => [k, v] as const), 2))
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

/** The `<id>` part of a flag string, for the shell completions. */
function placeholder(spec: Option): string {
  return spec.flags.split(/[ ,]+/).find((token) => token.startsWith('<')) ?? ''
}

function columns(rows: readonly (readonly [string, string])[], indent: number): string[] {
  const width = Math.max(0, ...rows.map((r) => r[0].length))
  const pad = ' '.repeat(indent)
  return rows.map(([left, right]) => (right ? `${pad}${left.padEnd(width)}  ${right}` : `${pad}${left}`))
}

export function renderCompletion(shell: 'bash' | 'zsh'): string {
  const verbs = SUBCOMMANDS.map((s) => s.name).join(' ')
  const options = flags()
  const names = options.flatMap((f) => (f.short ? [f.long!, f.short] : [f.long!])).join(' ')
  const valueFlags = options.filter((f) => f.required).map((f) => f.long!)
  const fn = `_${NAME.replaceAll('-', '_')}`

  if (shell === 'bash') {
    const cases = options
      .filter((f) => f.argChoices)
      .map((f) => `    ${f.long}) COMPREPLY=($(compgen -W "${f.argChoices!.join(' ')}" -- "$cur")); return ;;`)
      .join('\n')
    return `${fn}() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
${cases}
    ${valueFlags.join('|')}) return ;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${names}" -- "$cur"))
    return
  fi
  if [[ $COMP_CWORD -eq 1 ]]; then
    local games
    games=$(${NAME} list --json 2>/dev/null | grep -oE '"[A-Za-z0-9._-]+"' | tr -d '"')
    COMPREPLY=($(compgen -W "${verbs} $games" -- "$cur"))
  fi
}
complete -F ${fn} ${NAME}
`
  }

  const zshVerbs = SUBCOMMANDS.map((s) => `    '${s.name}:${s.summary.replaceAll("'", String.raw`'\''`)}'`).join('\n')
  const zshFlags = options.map((f) => {
    const desc = f.description.replaceAll("'", String.raw`'\''`).replaceAll(/[[\]:]/g, '')
    const arg = placeholder(f)
    const choices = f.argChoices ? `(${f.argChoices.join(' ')})` : '_files'
    const value = arg ? `:${arg.replaceAll(/[<>]/g, '')}:${choices}` : ''
    const repeat = Array.isArray(f.defaultValue) ? '*' : ''
    return `    '${repeat}${f.long}[${desc}]${value}'`
  }).join('\n')

  return `#compdef ${NAME}

${fn}() {
  local -a verbs
  verbs=(
${zshVerbs}
  )
  _arguments -s \\
${zshFlags} \\
    '1: :{_describe verb verbs}' \\
    '*:: :->rest'
}

${fn} "$@"
`
}
