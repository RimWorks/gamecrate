import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { exports as exportsField, legacy } from 'resolve.exports'

import { expandHome } from './config/load'
import { GamecrateError, Exit } from './types'
import type { GameConfig, ModManifest } from './types'

/** Bumped when a change would make an older plugin misbehave rather than merely lag. */
export const PLUGIN_API_VERSION = 1

export interface ModsConfigInput {
  version: string
  buildNumber: number
  /** Lowercased packageIds, load order. */
  activeMods: string[]
  knownExpansions: string[]
}

/**
 * A game's file formats plus the parts of its config that describe the game, not this machine.
 * Everything here takes plain data and throws plain Errors, so no plugin links the core runtime.
 */
export interface GamePlugin {
  apiVersion: number
  /** The key this game answers to on the command line. */
  game: string
  /** Merged under the user's `games.<game>` block, so a user only writes what is theirs. */
  defaults: Partial<GameConfig>
  /** null means "this file is not a mod manifest". A malformed file throws. */
  parseManifest(text: string): ModManifest | null
  renderModsConfig(input: ModsConfigInput): string
  mergePrefs(existing: string | null, owned: Record<string, string>): string
  /** Prefs keys that put the game in a window instead of fullscreen. */
  windowedPrefs: Record<string, string>
  /** Version.txt as the engine writes it. null when it does not parse. */
  parseVersion(text: string): { version: string; buildNumber: number } | null
}

const REQUIRED_FUNCTIONS = [
  'parseManifest',
  'renderModsConfig',
  'mergePrefs',
  'parseVersion',
] as const

function fail(spec: string, message: string, detail?: string): never {
  throw new GamecrateError(`plugin "${spec}": ${message}`, Exit.Config, detail)
}

/**
 * A directory's entry point, read from its own package.json. A compiled binary must do this by
 * hand: Bun's resolver never reads the target package.json there, so it only finds index.js.
 */
function entryOf(dir: string): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    // A directory with no package.json still has an index to try.
    return resolve(dir, 'index.js')
  }
  let entry: string | undefined
  try {
    entry = exportsField(manifest, '.', { conditions: ['bun'] })?.[0]
  } catch {
    // No condition matched, so fall through to the legacy fields.
  }
  entry ??= legacy(manifest, { fields: ['module', 'main'] }) as string | undefined
  return resolve(dir, entry ?? 'index.js')
}

/**
 * Walks node_modules upward by hand. require.resolve refuses "<pkg>/package.json" the moment a
 * package has an exports map, and that file is the only thing that tells entryOf where to go.
 */
function packageDir(spec: string, from: string): string | null {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, 'node_modules', spec)
    if (statSync(join(candidate, 'package.json'), { throwIfNoEntry: false })?.isFile()) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** A path is anything that looks like one; everything else is a package. */
function locate(spec: string, from: string): string {
  const expanded = expandHome(spec)
  let target: string | null
  if (expanded.startsWith('.') || isAbsolute(expanded)) {
    target = resolve(from, expanded)
  } else {
    target = packageDir(expanded, from)
    if (target === null) {
      fail(spec, `cannot be resolved from ${from}`, 'install it, or give a path starting with ./')
    }
  }
  return statSync(target, { throwIfNoEntry: false })?.isDirectory() ? entryOf(target) : target
}

function check(spec: string, value: unknown): GamePlugin {
  if (typeof value !== 'object' || value === null) fail(spec, 'has no default export')
  const plugin = value as Partial<GamePlugin>
  if (plugin.apiVersion !== PLUGIN_API_VERSION) {
    fail(spec, `speaks apiVersion ${String(plugin.apiVersion)}, this build speaks ${PLUGIN_API_VERSION}`)
  }
  if (typeof plugin.game !== 'string' || plugin.game === '') fail(spec, 'declares no game name')
  const missing = REQUIRED_FUNCTIONS.filter((name) => typeof plugin[name] !== 'function')
  if (missing.length > 0) fail(spec, `is missing ${missing.join(', ')}`)
  if (typeof plugin.defaults !== 'object' || plugin.defaults === null) {
    fail(spec, 'declares no defaults object')
  }
  if (typeof plugin.windowedPrefs !== 'object' || plugin.windowedPrefs === null) {
    fail(spec, 'declares no windowedPrefs object')
  }
  return plugin as GamePlugin
}

/** Keyed by game name. A second plugin claiming a name already taken is a config error. */
export async function loadPlugins(specs: string[], configFile: string): Promise<Map<string, GamePlugin>> {
  const from = dirname(configFile)
  const out = new Map<string, GamePlugin>()
  for (const spec of specs) {
    const target = locate(spec, from)
    let module: { default?: unknown }
    try {
      module = (await import(pathToFileURL(target).href)) as { default?: unknown }
    } catch (error) {
      fail(spec, `failed to load ${target}`, error instanceof Error ? error.message : String(error))
    }
    const plugin = check(spec, module.default)
    if (out.has(plugin.game)) fail(spec, `also claims the game "${plugin.game}"`)
    out.set(plugin.game, plugin)
  }
  return out
}

export function requirePlugin(plugins: Map<string, GamePlugin>, game: string): GamePlugin {
  const plugin = plugins.get(game)
  if (plugin === undefined) {
    throw new GamecrateError(
      `no plugin provides the game "${game}"`,
      Exit.Config,
      `loaded plugins: ${[...plugins.keys()].join(', ') || '(none)'}`,
    )
  }
  return plugin
}
