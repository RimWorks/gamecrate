import type { Option } from 'commander'
import type { GameConfig, RootConfig } from '../types'
import { own } from '../types'
import { GLOBAL_FLAGS, RUN_FLAGS, SUBCOMMANDS, publicOptions, subtreeFlags } from './args'
import type { PositionalSlot, SubcommandSpec } from './args'
import { profileNames } from '../config/load'

/** One candidate. The description reaches zsh and is dropped by bash. */
export interface Candidate {
  value: string
  description?: string
}

const NAME = 'gamecrate'

function flagCandidates(names: readonly string[]): Candidate[] {
  const all = publicOptions()
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const spec = all.find((o) => o.long === name)
    if (spec !== undefined) out.push({ value: name, description: spec.description })
  }
  return out
}

function awaitingValue(token: string | undefined): Option | undefined {
  if (token?.startsWith('-') !== true) return undefined
  return publicOptions().find((o) => (o.long === token || o.short === token) && (o.required || o.optional))
}

function positionalsOf(words: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === '--') return out
    if (word.startsWith('-')) {
      if (awaitingValue(word) !== undefined && !word.includes('=')) i++
      continue
    }
    out.push(word)
  }
  return out
}

function verbCandidates(config?: RootConfig): Candidate[] {
  const verbs = SUBCOMMANDS.map((s) => ({
    value: s.name,
    description: s.summary,
  }))
  const games = Object.keys(config?.games ?? {}).map((name) => ({ value: name, description: 'a game' }))
  return [...verbs, ...games, ...bareProfiles(config)]
}

function bareProfiles(config?: RootConfig): Candidate[] {
  if (config === undefined) return []
  const taken = new Set([...SUBCOMMANDS.map((s) => s.name), ...Object.keys(config.games)])
  const owners = new Map<string, string[]>()
  for (const [game, names] of Object.entries(profileNames(config))) {
    for (const name of names) {
      if (taken.has(name)) continue
      owners.set(name, [...(owners.get(name) ?? []), game])
    }
  }
  return [...owners].map(([value, games]) => ({ value, description: `a ${games.join(' or ')} profile` }))
}

function profileOwners(config: RootConfig | undefined, name: string): string[] {
  if (config === undefined) return []
  const lower = name.toLowerCase()
  const names = profileNames(config)
  return Object.keys(names).filter((game) => (own(names, game) ?? []).some((p) => p.toLowerCase() === lower))
}

function gameSpecs(config: RootConfig | undefined, game: string | undefined): GameConfig[] {
  if (game === undefined) return Object.values(config?.games ?? {})
  const spec = own(config?.games, game)
  return spec === undefined ? [] : [spec]
}

function profileCandidates(config: RootConfig | undefined, game: string | undefined): Candidate[] {
  const out: Candidate[] = []
  for (const spec of gameSpecs(config, game)) {
    for (const [name, profile] of Object.entries(spec.profiles)) {
      out.push({ value: name, description: profile.alias === undefined ? 'a profile' : `alias for ${profile.alias}` })
      for (const alias of profile.aliases ?? []) out.push({ value: alias, description: `aka ${name}` })
    }
  }
  out.push({ value: 'modless', description: 'the built-in core and DLC only set' })
  return out
}

function libraryCandidates(config: RootConfig | undefined, game: string | undefined): Candidate[] {
  const out: Candidate[] = []
  for (const spec of gameSpecs(config, game)) {
    for (const id of Object.keys(spec.library ?? {})) out.push({ value: id, description: 'a library mod' })
  }
  return out
}

function slotCandidates(
  slot: PositionalSlot | undefined,
  config: RootConfig | undefined,
  game: string | undefined,
  sub?: SubcommandSpec,
  subverb?: string,
): Candidate[] {
  if (slot === 'profile') return profileCandidates(config, game)
  if (slot === 'rest' && sub?.name === 'mods' && subverb === 'rm') return libraryCandidates(config, game)
  return []
}

interface Scope {
  flags: readonly string[]
  slots: readonly PositionalSlot[]
  filled: string[]
  sub?: SubcommandSpec
  subverb?: string
}

function scopeOf(positional: readonly string[], config?: RootConfig): Scope | undefined {
  const first = positional[0]
  if (first === undefined) return undefined

  const sub = SUBCOMMANDS.find((s) => s.name === first)
  if (sub === undefined) {
    const run = { flags: [...RUN_FLAGS, ...GLOBAL_FLAGS], filled: positional.slice(1) }
    if (own(config?.games, first) !== undefined) return { ...run, slots: ['profile', 'rest'] }
    if (profileOwners(config, first).length > 0) return { ...run, slots: ['rest'] }
    return undefined
  }

  const word = positional[1]
  const spec = word === undefined ? undefined : own(sub.subverbs, word)
  if (spec === undefined) {
    return {
      flags: [...subtreeFlags(sub), ...GLOBAL_FLAGS],
      slots: sub.needsSubverb === true ? [] : sub.positionals,
      filled: positional.slice(1),
      sub,
    }
  }
  return {
    flags: [...spec.flags, ...sub.flags, ...GLOBAL_FLAGS],
    slots: spec.positionals,
    filled: positional.slice(2),
    sub,
    subverb: word,
  }
}

/**
 * `words` is the line after the binary, last element being the word under the cursor. Filtering
 * by prefix is ours, not the shell's, so zsh descriptions survive.
 */
export function complete(words: readonly string[], config?: RootConfig): Candidate[] {
  const cur = words.at(-1) ?? ''
  const prior = words.slice(0, -1)

  const pending = awaitingValue(prior.at(-1))
  if (pending !== undefined) {
    const choices = pending.argChoices ?? []
    return choices.filter((c) => c.startsWith(cur)).map((value) => ({ value }))
  }

  const positional = positionalsOf(prior)
  const scope = scopeOf(positional, config)

  if (cur.startsWith('-')) {
    const names = scope?.flags ?? [...RUN_FLAGS, ...GLOBAL_FLAGS]
    return flagCandidates(names).filter((c) => c.value.startsWith(cur))
  }

  if (scope === undefined) return verbCandidates(config).filter((c) => c.value.startsWith(cur))

  const out: Candidate[] = []
  const { sub, subverb, filled, slots } = scope

  if (sub?.subverbs !== undefined && subverb === undefined && filled.length === 0) {
    for (const [verb, entry] of Object.entries(sub.subverbs)) out.push({ value: verb, description: entry.summary })
  }

  const last = slots.at(-1)
  const slot = slots[filled.length] ?? (last === 'rest' ? 'rest' : undefined)
  const game = undefined
  const taken = new Set(filled)
  out.push(...slotCandidates(slot, config, game, sub, subverb).filter((c) => !taken.has(c.value)))

  return out.filter((c) => c.value.startsWith(cur))
}

export function renderCandidates(candidates: readonly Candidate[]): string {
  return candidates.map((c) => (c.description === undefined ? c.value : `${c.value}\t${c.description}`)).join('\n') + '\n'
}

/**
 * A static stub that asks the binary. Dynamic values stay dynamic, and nothing here has to be
 * regenerated when a verb or a profile changes.
 */
export function renderCompletion(shell: 'bash' | 'zsh'): string {
  const fn = `_${NAME.replaceAll('-', '_')}`

  if (shell === 'bash') {
    return `${fn}() {
  local IFS=$'\\n'
  local reply
  reply=$(${NAME} __complete "\${COMP_WORDS[@]:1}" 2>/dev/null)
  COMPREPLY=()
  for line in $reply; do
    COMPREPLY+=("\${line%%$'\\t'*}")
  done
}
complete -o nosort -F ${fn} ${NAME}
`
  }

  return `#compdef ${NAME}

${fn}() {
  local -a lines candidates args
  args=("\${words[@]:1}")
  # zsh drops the word under the cursor when it is empty, and the binary needs that slot
  [[ \${#args} -lt $((CURRENT - 1)) ]] && args+=("")
  lines=("\${(@f)$(${NAME} __complete "\${args[@]}" 2>/dev/null)}")
  for line in $lines; do
    [[ -z $line ]] && continue
    candidates+=("\${line/$'\\t'/:}")
  done
  _describe -t gamecrate ${NAME} candidates
}

compdef ${fn} ${NAME}
`
}
