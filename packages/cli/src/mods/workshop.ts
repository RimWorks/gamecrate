import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveProfile } from '../config/load'
import { libraryPin, reachedEntries } from './source'
import { downloadItems, downloadRoots, workshopUrlId } from './steamcmd'
import { checkDrift } from './workshopapi'
import type { GamePlugin } from '../plugin'
import type {
  GameConfig,
  ModEntry,
  ModManifest,
  ParsedArgs,
  Problem,
  ProfileConfig,
  RootConfig,
} from '../types'

/**
 * A workshop item can depend on another workshop item, so one pass is never enough. Five rounds
 * clears every real chain measured so far and bounds a broken or hostile one.
 */
const ROUNDS = 5

export interface PreparedWorkshop {
  /** Every id this walk inspected: the profile's own, plus the dependencies it reached. */
  ids: Set<string>
  warnings: string[]
  problems: Problem[]
  /** Inspected ids with no directory under any mounted root when the walk finished. */
  unfetched: string[]
}

/**
 * Downloads every workshop item the profile names and every workshop dependency of those,
 * recursively, before the mod index is built. Never throws for a download that failed.
 */
export async function prepareWorkshop(
  game: GameConfig,
  profileName: string,
  args: ParsedArgs,
  config: RootConfig,
  allowFetch: boolean,
  plugin: GamePlugin,
): Promise<PreparedWorkshop> {
  const roots = mountedRoots(config.dataRoot, game)
  const ids = new Set<string>()
  const warnings: string[] = []
  const problems: Problem[] = []

  let frontier = wantedIds(game, resolveProfile(game, profileName), args)
  for (let round = 0; round < ROUNDS && frontier.length > 0; round++) {
    for (const id of frontier) ids.add(id)
    if (allowFetch) {
      try {
        const drift = await checkDrift(frontier, roots)
        warnings.push(...drift.warnings)
        const downloaded = await downloadItems(config, game, config.dataRoot, drift.needed)
        warnings.push(...downloaded.warnings)
      } catch (error) {
        // a launch downloads on the side, so no downloader is a warning here. what is missing
        // comes back through unfetched. `mods add` and `mods sync` still throw.
        warnings.push(`could not download workshop items: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const next = new Set<string>()
    for (const id of frontier) {
      const manifest = await manifestOf(roots, id, game, plugin, problems)
      for (const dep of manifest?.modDependencies ?? []) {
        const depId = workshopUrlId(dep.steamWorkshopUrl)
        if (depId !== undefined && !ids.has(depId)) next.add(depId)
      }
    }
    frontier = [...next]
  }

  if (frontier.length > 0) {
    problems.push({
      where: `profile ${profileName}`,
      message: `workshop dependencies are still unresolved after ${ROUNDS} rounds: ${frontier.join(', ')}`,
      suggestion: 'name them in the profile so they download in the first round',
    })
  }
  return { ids, warnings, problems, unfetched: [...ids].filter((id) => itemDir(roots, id) === undefined) }
}

/**
 * The roots a launch actually mounts, in the order buildIndex scans them: both download
 * layouts first, then the steam client's own tree. A copy the user is subscribed to counts as
 * on disk, so it neither downloads again nor reports unfetched.
 */
function mountedRoots(dataRoot: string, game: GameConfig): string[] {
  return [...downloadRoots(dataRoot, game), ...(game.workshopRoot === null ? [] : [game.workshopRoot])]
}

function itemDir(roots: string[], id: string): string | undefined {
  return roots.map((root) => join(root, id)).find((dir) => existsSync(dir))
}

// a directory with no manifest is not a mod, the same call scanWorkshopRoot makes. a manifest that
// throws is a broken file and worth reporting, which is what parseAll does with one.
async function manifestOf(
  roots: string[],
  id: string,
  game: GameConfig,
  plugin: GamePlugin,
  problems: Problem[],
): Promise<ModManifest | null> {
  const dir = itemDir(roots, id)
  if (dir === undefined) return null
  const file = join(dir, game.manifest.file)
  if (!existsSync(file)) return null
  try {
    return plugin.parseManifest(await readFile(file, 'utf8'))
  } catch (error) {
    problems.push({ where: file, message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

function wantedIds(game: GameConfig, profile: ProfileConfig, args: Partial<ParsedArgs>): string[] {
  const out = new Set<string>()
  for (const entry of reachedEntries(game, profile, args)) {
    const id = workshopIdOf(entry, game)
    if (id !== undefined) out.add(id)
  }
  return [...out]
}

/** The published file id an entry names, resolving library pins in the order `refFor` does. */
function workshopIdOf(entry: ModEntry, game: GameConfig): string | undefined {
  if (typeof entry !== 'string' && 'match' in entry) return undefined
  const object = typeof entry === 'string' ? { id: entry } : entry
  if (object.path !== undefined) return undefined
  if (object.workshop !== undefined) return published(String(object.workshop))
  if (object.id.startsWith('workshop:')) return published(object.id.slice('workshop:'.length))
  if (object.id.includes(':')) return undefined
  const pin = libraryPin(game, object.id)
  if (pin?.path !== undefined) return undefined
  return pin?.workshop === undefined ? undefined : published(String(pin.workshop))
}

// a `workshop:` ref is user text, and steamcmd takes anything handed to it
function published(value: string): string | undefined {
  return /^\d+$/.test(value) ? value : undefined
}
