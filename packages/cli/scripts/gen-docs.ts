import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Option } from 'commander'
import { z } from 'zod'
import { FLAG_ENV, GLOBAL_FLAGS, RUN_FLAGS, SUBCOMMANDS, VERB_GROUPS, publicOptions } from '../src/cli/args'
import type { SubcommandSpec } from '../src/cli/args'
import { SCHEMAS } from '../src/config/validate'
import { DEFAULT_DATA_ROOT, DEFAULT_SETTINGS } from '../src/config/builtin'

const DOCS = join(import.meta.dirname, '..', 'docs')

interface Def {
  type: string
  shape?: Record<string, Node>
  element?: Node
  innerType?: Node
  valueType?: Node
  options?: Node[]
  entries?: Record<string, string>
}

interface Node {
  _zod: { def: Def }
}

const NAMED = new Map<Node, string>([
  [SCHEMAS.settings as unknown as Node, 'settings'],
  [SCHEMAS.profile as unknown as Node, 'profile'],
  [SCHEMAS.modSettingsFile as unknown as Node, 'mod settings file'],
  [SCHEMAS.libraryEntry as unknown as Node, 'library entry'],
])

const code = (text: string): string => "`" + text + "`"

const cell = (text: string): string => text.replaceAll('|', String.raw`\|`)

function def(node: Node): Def {
  return node._zod.def
}

function unwrap(node: Node): { inner: Node; optional: boolean } {
  const d = def(node)
  if (d.type === 'optional' && d.innerType !== undefined) {
    const next = unwrap(d.innerType)
    return { inner: next.inner, optional: true }
  }
  return { inner: node, optional: false }
}

function typeOf(node: Node): string {
  const named = NAMED.get(node)
  if (named !== undefined) return named
  const d = def(node)
  switch (d.type) {
    case 'enum': {
      const values = Object.keys(d.entries ?? {}).map(code)
      if (values.length < 2) return values.join('')
      return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`
    }
    case 'array':
      return `array of ${d.element === undefined ? 'any' : typeOf(unwrap(d.element).inner)}`
    case 'record':
      return `object of ${d.valueType === undefined ? 'any' : typeOf(unwrap(d.valueType).inner)}`
    case 'union':
      return (d.options ?? []).map((o) => typeOf(unwrap(o).inner)).join(' or ')
    case 'unknown':
      return code('any')
    default:
      return code(d.type)
  }
}

interface Key {
  path: string
  required: boolean
  type: string
  description: string
}

function descriptionOf(raw: Node, inner: Node): string {
  const meta = (node: Node): string | undefined =>
    z.globalRegistry.get(node as unknown as z.ZodType)?.description
  return meta(raw) ?? meta(inner) ?? ''
}

/** An object written inline is worth descending into; a named or scalar one is not. */
function inlineObject(node: Node | undefined): Node | undefined {
  if (node === undefined) return undefined
  const { inner } = unwrap(node)
  if (NAMED.has(inner) || def(inner).type !== 'object') return undefined
  return inner
}

/** Flattens a schema into one row per key, descending only into objects written inline. */
function keysOf(node: Node, prefix = '', skip: readonly string[] = []): Key[] {
  const rows: Key[] = []
  for (const [name, raw] of Object.entries(def(node).shape ?? {})) {
    if (prefix === '' && skip.includes(name)) continue
    const { inner, optional } = unwrap(raw)
    const path = prefix === '' ? name : `${prefix}.${name}`
    rows.push({ path, required: !optional, type: typeOf(inner), description: descriptionOf(raw, inner) })
    if (NAMED.has(inner)) continue
    const d = def(inner)
    const descend: [string, Node | undefined][] = [
      [path, d.type === 'object' ? inner : undefined],
      [`${path}[]`, inlineObject(d.element)],
      [`${path}.<name>`, inlineObject(d.valueType)],
    ]
    for (const [at, target] of descend) {
      if (target !== undefined) rows.push(...keysOf(target, at))
    }
  }
  return rows
}

interface TableOpts {
  skip?: readonly string[]
  keep?: readonly string[]
  defaults?: Record<string, unknown>
}

function keyTable(node: Node, opts: TableOpts = {}): string {
  const defaults = opts.defaults ?? {}
  const rows = keysOf(node, '', opts.skip ?? [])
    .filter((r) => opts.keep === undefined || opts.keep.includes(r.path.split(/[.[]/)[0] ?? ''))
    .map((r) => ({ ...r, required: r.required && defaults[r.path] === undefined }))
  const columns = ['Key', ...(rows.some((r) => r.required) ? ['Required'] : []), 'Type']
  if (rows.some((r) => defaults[r.path] !== undefined)) columns.push('Default')
  columns.push('What it means')
  const body = rows.map((r) => {
    const cells: Record<string, string> = {
      Key: code(r.path),
      Required: r.required ? 'yes' : 'no',
      Type: cell(r.type),
      Default: defaults[r.path] === undefined ? '' : code(String(defaults[r.path])),
      'What it means': cell(r.description),
    }
    return `| ${columns.map((name) => cells[name]).join(' | ')} |`
  })
  return [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...body].join('\n')
}

const PLUGIN_GAME_KEYS = [
  'gameFiles',
  'dataDir',
  'modsDir',
  'logFile',
  'executable',
  'managed',
  'steamAppId',
  'workshopRoot',
  'manifest',
  'modsConfig',
  'prefs',
  'modSettingsDir',
  'version',
  'steamBuild',
  'records',
  'saveExtensions',
  'core',
  'dlc',
  'preCore',
  'base',
  'steamlessMod',
  'modes',
  'ignoresWmDelete',
] as const

const OWN_GAME_KEYS = ['image', 'scanRoots', 'library', 'aliases', 'settings', 'profiles'] as const

function gameKeyTable(keep: readonly string[]): string {
  const declared = Object.keys(def(SCHEMAS.game as unknown as Node).shape ?? {})
  const covered = new Set<string>([...PLUGIN_GAME_KEYS, ...OWN_GAME_KEYS])
  const missing = declared.filter((name) => !covered.has(name))
  const extra = [...covered].filter((name) => !declared.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `game key split is stale: add ${missing.join(', ') || 'nothing'} and drop ${extra.join(', ') || 'nothing'}`,
    )
  }
  return keyTable(SCHEMAS.game as unknown as Node, { keep })
}

function subcommands(): string {
  const shape = (sub: SubcommandSpec): string => `${sub.name} ${sub.usage}`.trim()
  const out: string[] = []
  for (const group of VERB_GROUPS) {
    const here = SUBCOMMANDS.filter((s) => s.group === group.name)
    if (here.length === 0) continue
    out.push(`### ${group.title}`, '')
    for (const sub of here) {
      out.push(`- ${code(shape(sub))}: ${sub.summary}`)
      for (const [verb, spec] of Object.entries(sub.subverbs ?? {})) {
        const label = `${sub.name} ${verb} ${spec.usage}`.trim()
        out.push(`  - ${code(label)}: ${spec.summary}`)
      }
    }
    out.push('')
  }
  return out.join('\n').trim()
}

function ownersOf(name: string): string[] {
  if ((GLOBAL_FLAGS as readonly string[]).includes(name)) return []
  const run = (RUN_FLAGS as readonly string[]).includes(name) ? ['run'] : []
  return [
    ...run,
    ...SUBCOMMANDS.flatMap((s) => {
      if (s.name === 'run') return []
      return [
        ...(s.flags.includes(name) ? [s.name] : []),
        ...Object.entries(s.subverbs ?? {})
          .filter(([, spec]) => spec.flags.includes(name))
          .map(([verb]) => `${s.name} ${verb}`),
      ]
    }),
  ]
}

function note(option: Option): string {
  if (Array.isArray(option.defaultValue)) return 'Repeatable.'
  if (option.defaultValue === undefined) return ''
  return `Default ${code(String(option.defaultValue))}.`
}

function what(option: Option): string {
  const summary = option.description.trim()
  const extra = note(option)
  if (extra === '') return summary
  const sentence = summary.endsWith('.') ? summary : `${summary}.`
  return `${sentence} ${extra}`
}

function flags(): string {
  const rows = [...publicOptions()]
    .sort((a, b) => (a.long ?? a.flags).localeCompare(b.long ?? b.flags))
    .map((option) => {
      const owners = ownersOf(option.long ?? option.flags)
      const where = owners.length === 0 ? 'every subcommand' : owners.map(code).join(', ')
      return `| ${cell(code(option.flags))} | ${cell(where)} | ${cell(what(option))} |`
    })
  return ['| Flag | Subcommands | What it does |', '| --- | --- | --- |', ...rows].join('\n')
}

function env(): string {
  return Object.entries(FLAG_ENV)
    .map(([flag, name]) => `- ${code(name)} for ${code(flag)}`)
    .join('\n')
}

const SETTINGS_DEFAULTS: Record<string, unknown> = { ...DEFAULT_SETTINGS }

const BLOCKS: Record<string, Record<string, () => string>> = {
  'reference.md': {
    subcommands,
    flags,
    variables: env,
  },
  'configuration.md': {
    'root-keys': () =>
      keyTable(SCHEMAS.root as unknown as Node, { skip: ['games'], defaults: { dataRoot: DEFAULT_DATA_ROOT } }),
    'own-game-keys': () => gameKeyTable(OWN_GAME_KEYS),
    'plugin-game-keys': () => gameKeyTable(PLUGIN_GAME_KEYS),
    'profile-keys': () => keyTable(SCHEMAS.profile as unknown as Node),
    'mod-entry-keys': () => keyTable(SCHEMAS.modEntryObject as unknown as Node),
    'match-entry-keys': () => keyTable(SCHEMAS.matchEntry as unknown as Node),
    'settings-keys': () => keyTable(SCHEMAS.settings as unknown as Node, { defaults: SETTINGS_DEFAULTS }),
    'mod-settings-keys': () => keyTable(SCHEMAS.modSettingsFile as unknown as Node),
  },
}

function render(source: string, file: string, blocks: Record<string, () => string>): string {
  let out = source
  for (const [name, build] of Object.entries(blocks)) {
    const open = `<!-- generated:${name} -->`
    const close = `<!-- /generated:${name} -->`
    const from = out.indexOf(open)
    const to = out.indexOf(close)
    if (from === -1 || to === -1 || to < from) {
      throw new Error(`${file}: missing marker pair for ${name}`)
    }
    out = `${out.slice(0, from + open.length)}\n\n${build()}\n\n${out.slice(to)}`
  }
  return out
}

const check = process.argv.includes('--check')
const stale: string[] = []

for (const [file, blocks] of Object.entries(BLOCKS)) {
  const path = join(DOCS, file)
  const source = readFileSync(path, 'utf8')
  const next = render(source, file, blocks)
  if (next === source) continue
  if (check) stale.push(file)
  else writeFileSync(path, next)
}

if (check && stale.length > 0) {
  console.error(`out of date: ${stale.join(', ')}`)
  console.error('run `npm run docs` to regenerate')
  process.exit(1)
}
console.log(check ? 'docs are current' : 'docs written')
