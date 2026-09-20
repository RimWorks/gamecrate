import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { expandHome, findGlobalConfig, findProjectConfig, globalConfigDir } from '../config/load'
import { readConfigFile } from '../config/read'
import { isObj } from '../config/validate'
import { writeConfig } from '../config/write'
import type { ConfigEdit } from '../config/write'
import {
  cloneDir,
  defaultBranch,
  ensureClone,
  gitRefOf,
  lockClone,
  normalizeUrl,
} from '../mods/source'
import type { GitRef } from '../mods/source'
import { requirePlugin } from '../plugin'
import type { GamePlugin } from '../plugin'
import { Exit, GamecrateError } from '../types'
import type { GameConfig, LibraryEntry, ParsedArgs, ProjectDefaults, RootConfig } from '../types'
import { requireGame } from './game'
import { status, warn } from './output'

export interface ModsContext {
  config: RootConfig
  plugins: Map<string, GamePlugin>
  defaults: ProjectDefaults
  /** Where findProjectConfig starts walking. Injectable so tests need no chdir. */
  cwd: string
  /** The resolved global config path, or where to create one. Injectable for the same reason. */
  globalPath: string
}

/** The same fallback loadConfig uses, so an error names the file `config edit` would open. */
export async function globalConfigPath(): Promise<string> {
  return (await findGlobalConfig()) ?? join(globalConfigDir(), 'profiles.yml')
}

interface Pin {
  id: string
  entry: LibraryEntry
}

interface Target {
  file: string
  /** A project file has one library; the global file has one per game. */
  prefix: string[]
  existing: Record<string, unknown>
  /** The whole parsed file, so a delete can tell which ancestors it leaves empty. */
  root: Record<string, unknown>
}

export async function modsAdd(args: ParsedArgs, ctx: ModsContext): Promise<number> {
  const game = requireGame(args, ctx.config)
  const gameConfig = ctx.config.games[game]!
  const source = args.source
  if (source === undefined) {
    throw new GamecrateError('mods add needs one of --path, --workshop or --git', Exit.Usage)
  }
  // ahead of the target, which creates the global file: a refusal must not leave one behind.
  if (source.kind === 'workshop' && gameConfig.workshopRoot === null) {
    throw new GamecrateError(
      `games.${game}.workshopRoot is null, so workshop item ${source.value} cannot resolve`,
      Exit.Config,
      `set games.${game}.workshopRoot to the workshop directory for app ${gameConfig.steamAppId}`,
    )
  }

  const target = await resolveTarget(args, ctx, game)
  const pins = await discover(source, gameConfig, requirePlugin(ctx.plugins, game), ctx)
  if (pins.length === 0) {
    throw new GamecrateError(`no mod manifest at ${describe(source)}`, Exit.Resolution, `looked for ${gameConfig.manifest.file}`)
  }

  // `walk` returns one entry per directory that parses, and two directories in one repo can
  // declare one id. two edits to one key would write the later one and drop the other without
  // saying so, and nothing here knows which subdir was meant. refuse and let the user say.
  const where = new Map<string, string[]>()
  for (const pin of pins) {
    const at = where.get(pin.id.toLowerCase()) ?? []
    at.push(pin.entry.subdir ?? '.')
    where.set(pin.id.toLowerCase(), at)
  }
  const twice = [...where.values()].filter((at) => at.length > 1)
  if (twice.length > 0) {
    const lines = [...where.entries()].filter(([, at]) => at.length > 1)
    throw new GamecrateError(
      `${twice.length} mod id(s) are declared by more than one directory in ${describe(source)}`,
      Exit.Config,
      `${lines.map(([id, at]) => `  ${id}: ${at.join(', ')}`).join('\n')}\npin one of them with --subdir`,
    )
  }

  const clashes = pins.filter((pin) => existingKey(target.existing, pin.id) !== undefined)
  if (clashes.length > 0 && args.force !== true) {
    throw new GamecrateError(
      `${clashes.length} mod id(s) are already pinned in ${target.file}`,
      Exit.Config,
      `${clashes.map((pin) => `  ${pin.id}`).join('\n')}\noverwrite them with --force`,
    )
  }

  // one list, built whole, written once: a collision anywhere leaves the file untouched.
  const edits: ConfigEdit[] = []
  for (const pin of pins) {
    const old = existingKey(target.existing, pin.id)
    // delete first, so a replacement never merges with the old entry or leaves its key behind
    if (old !== undefined) edits.push({ path: [...target.prefix, old], value: undefined })
    edits.push({ path: [...target.prefix, pin.id], value: pin.entry })
  }
  // created only once the write is certain: a refusal must not leave an empty config behind
  if (!existsSync(target.file)) {
    // empty, never `{}`: the yaml writer turns an existing empty map into a flow map forever
    await mkdir(dirname(target.file), { recursive: true })
    await writeFile(target.file, '')
  }
  await writeConfig(target.file, edits)
  for (const pin of pins) status(`pinned ${pin.id} in ${target.file}`)
  return Exit.Ok
}

export async function modsRm(args: ParsedArgs, ctx: ModsContext): Promise<number> {
  const game = requireGame(args, ctx.config)
  const target = await resolveTarget(args, ctx, game)

  const keys = args.rest.map((id) => ({ id, key: existingKey(target.existing, id) }))
  const missing = keys.filter((entry) => entry.key === undefined)
  if (missing.length > 0) {
    throw new GamecrateError(
      `${missing.length} mod id(s) are not pinned in ${target.file}`,
      Exit.Config,
      missing.map((entry) => `  ${entry.id}`).join('\n'),
    )
  }

  const removed = keys.map((entry) => entry.key as string)
  const edits: ConfigEdit[] = removed.map((key) => ({ path: [...target.prefix, key], value: undefined }))
  edits.push(...emptied(target, removed))
  await writeConfig(target.file, edits)
  for (const entry of keys) status(`unpinned ${entry.id} from ${target.file}`)
  return Exit.Ok
}

export async function modsSync(args: ParsedArgs, ctx: ModsContext): Promise<number> {
  const only = args.rest.map((id) => id.toLowerCase())
  const games = args.game === undefined ? Object.keys(ctx.config.games) : [requireGame(args, ctx.config)]

  const wanted: { id: string; git: string; entry: LibraryEntry }[] = []
  for (const name of games) {
    for (const [id, entry] of Object.entries(ctx.config.games[name]?.library ?? {})) {
      if (entry.git === undefined) continue
      if (only.length > 0 && !only.includes(id.toLowerCase())) continue
      wanted.push({ id, git: entry.git, entry })
    }
  }
  const missing = only.filter((id) => !wanted.some((pin) => pin.id.toLowerCase() === id))
  if (missing.length > 0) {
    throw new GamecrateError(
      `${missing.length} mod id(s) are not git-pinned in the library`,
      Exit.Resolution,
      missing.map((id) => `  ${id}`).join('\n'),
    )
  }
  if (wanted.length === 0) {
    status('nothing to sync')
    return Exit.Ok
  }

  // one ls-remote per url, and one fetch per clone directory
  const branches = new Map<string, GitRef>()
  const fetched = new Set<string>()
  for (const pin of wanted) {
    let ref = gitRefOf(pin.entry)
    if (ref === undefined) {
      const url = normalizeUrl(pin.git)
      ref = branches.get(url) ?? defaultBranch(pin.git)
      branches.set(url, ref)
    }
    const dir = cloneDir(ctx.config.dataRoot, pin.git, ref)
    // the fetch dedupes, the report does not: every id the user named gets its own line
    if (!fetched.has(dir)) {
      fetched.add(dir)
      const unlock = await lockClone(dir)
      try {
        // `force` is the point: a plain fetch never moves a tag, and never resets toward a commit.
        const result = await ensureClone(ctx.config.dataRoot, gitPin(pin.git, pin.entry), ref, 'force')
        if (result.warning !== undefined) warn(result.warning)
      } finally {
        await unlock()
      }
    }
    status(`synced ${pin.id} at ${ref.kind} ${ref.value}`)
  }
  return Exit.Ok
}

function gitPin(url: string, entry: LibraryEntry): { url: string; subdir?: string } {
  return { url, ...(entry.subdir === undefined ? {} : { subdir: entry.subdir }) }
}

function describe(source: NonNullable<ParsedArgs['source']>): string {
  if (source.kind === 'path') return source.value
  if (source.kind === 'workshop') return `workshop item ${source.value}`
  return source.subdir === undefined ? source.url : `${source.url} (${source.subdir})`
}

/** The library the loader would read out of one file, never the merged config. */
async function resolveTarget(args: ParsedArgs, ctx: ModsContext, game: string): Promise<Target> {
  if (args.target === 'project') {
    const file = await findProjectConfig(ctx.cwd)
    if (file === undefined) {
      throw new GamecrateError(
        'no .gamecrate config in this directory or any parent; create one with a top-level game:',
        Exit.Config,
      )
    }
    const raw = await readConfigFile(file)
    const bag = isObj(raw) ? raw : {}
    const its = bag['game']
    if (typeof its !== 'string') {
      throw new GamecrateError(`${file} has no top-level game:`, Exit.Config, `add game: ${game}`)
    }
    // a project `game:` is applied before the positionals, so these two can still disagree
    if (its !== game) {
      throw new GamecrateError(`${file} belongs to ${its}, not ${game}`, Exit.Config, `write to ${its}, or use --global`)
    }
    return { file, prefix: ['library'], existing: libraryOf(bag), root: bag }
  }

  const file = ctx.globalPath
  const raw = await readConfigFile(file)
  const root = isObj(raw) ? raw : {}
  const games = root['games']
  const block = isObj(games) ? games[game] : undefined
  return {
    file,
    prefix: ['games', game, 'library'],
    existing: isObj(block) ? libraryOf(block) : {},
    root,
  }
}

/**
 * A yaml map left with no entries re-emits as `{}`, and the next write into it comes back as a
 * one-line flow map. So a delete that empties a map deletes the map's own key too, and keeps
 * walking up for as long as that leaves the parent empty.
 */
function emptied(target: Target, removed: string[]): ConfigEdit[] {
  const out: ConfigEdit[] = []
  let gone = removed
  for (let depth = target.prefix.length; depth > 0; depth--) {
    const path = target.prefix.slice(0, depth)
    const bag = bagAt(target.root, path)
    if (bag === undefined || Object.keys(bag).some((key) => !gone.includes(key))) break
    out.push({ path, value: undefined })
    gone = [path[depth - 1] as string]
  }
  return out
}

function bagAt(root: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let bag: unknown = root
  for (const key of path) {
    if (!isObj(bag)) return undefined
    bag = bag[key]
  }
  return isObj(bag) ? bag : undefined
}

function libraryOf(bag: Record<string, unknown>): Record<string, unknown> {
  const library = bag['library']
  return isObj(library) ? library : {}
}

/** `libraryPin` matches a pin case-blind, so a collision is case-blind too. */
function existingKey(library: Record<string, unknown>, id: string): string | undefined {
  if (Object.hasOwn(library, id)) return id
  const lower = id.toLowerCase()
  return Object.keys(library).find((key) => key.toLowerCase() === lower)
}

async function discover(
  source: NonNullable<ParsedArgs['source']>,
  game: GameConfig,
  plugin: GamePlugin,
  ctx: ModsContext,
): Promise<Pin[]> {
  if (source.kind === 'path') {
    // stored absolute: a config is read from wherever the next run starts, not from here
    const dir = resolve(ctx.cwd, expandHome(source.value))
    const id = await readId(dir, game.manifest.file, plugin)
    return id === undefined ? [] : [{ id, entry: { path: dir } }]
  }
  if (source.kind === 'workshop') {
    const dir = join(game.workshopRoot as string, String(source.value))
    const id = await readId(dir, game.manifest.file, plugin)
    return id === undefined ? [] : [{ id, entry: { workshop: source.value } }]
  }

  const ref = source.ref ?? defaultBranch(source.url)
  const dir = cloneDir(ctx.config.dataRoot, source.url, ref)
  const unlock = await lockClone(dir)
  let root: string
  try {
    const result = await ensureClone(ctx.config.dataRoot, { url: source.url }, ref, 'fetch')
    if (result.warning !== undefined) warn(result.warning)
    root = result.dir
  } finally {
    await unlock()
  }

  const start = source.subdir === undefined ? root : join(root, source.subdir)
  const found = await walk(start, game.manifest.file, plugin)
  return found.map(({ id, dir: at }) => {
    const entry: LibraryEntry = { git: source.url }
    const pinned = source.ref
    if (pinned?.kind === 'branch') entry.branch = pinned.value
    else if (pinned?.kind === 'tag') entry.tag = pinned.value
    else if (pinned?.kind === 'commit') entry.commit = pinned.value
    const rel = relative(root, at)
    if (rel !== '') entry.subdir = rel
    return { id, entry }
  })
}

/**
 * Stops at the first manifest on a branch, so a mod whose per-version About files sit under a
 * parent manifest is one mod. Sibling per-version directories with no parent manifest are still
 * two hits that declare one id, and the later one wins the write.
 */
async function walk(
  root: string,
  manifestFile: string,
  plugin: GamePlugin,
): Promise<{ id: string; dir: string }[]> {
  const out: { id: string; dir: string }[] = []
  const descend = async (dir: string): Promise<void> => {
    const id = await readId(dir, manifestFile, plugin)
    if (id !== undefined) {
      out.push({ id, dir })
      return
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await descend(join(dir, entry.name))
    }
  }
  await descend(root)
  return out
}

/** Undefined covers absent, unreadable and unparsable alike: all three mean "no mod here". */
async function readId(dir: string, manifestFile: string, plugin: GamePlugin): Promise<string | undefined> {
  const text = await readFile(join(dir, manifestFile), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return plugin.parseManifest(text)?.packageId
  } catch {
    return undefined
  }
}
