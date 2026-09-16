import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { expandHome } from '../config/load'
import { GamecrateError, Exit } from '../types'
import type { GamePlugin } from '../plugin'
import type { GameConfig, LaunchPlan } from '../types'

async function readInstallVersion(
  game: GameConfig,
  plugin: GamePlugin,
): Promise<{ version: string; buildNumber: number } | null> {
  const host = game.gameFiles.host
  if (game.gameFiles.source !== 'mount' || host === undefined) return null
  let raw: string
  try {
    raw = await readFile(join(expandHome(host), 'Version.txt'), 'utf8')
  } catch {
    return null
  }
  return plugin.parseVersion(raw.replace(/^﻿/, '').trim())
}

/** The expansions actually installed, ordered by the game's declared dlc list. */
async function readKnownExpansions(
  game: GameConfig,
  plugin: GamePlugin,
  warnings: string[],
): Promise<string[]> {
  // An empty dlc list is the game saying it ships no expansions, so there is no Data/ to read
  // and nothing to order by. Scanning anyway warns about a directory that was never expected.
  if (game.dlc.length === 0) return []
  const host = game.gameFiles.host
  if (game.gameFiles.source !== 'mount' || host === undefined) return [...game.dlc]
  const dataDir = join(expandHome(host), 'Data')
  let entries
  try {
    entries = await readdir(dataDir, { withFileTypes: true })
  } catch {
    warnings.push(`could not read ${dataDir}; falling back to the configured dlc list`)
    return [...game.dlc]
  }
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let id: string | null = null
    try {
      // The plugin reads the manifest's own packageId, so a dependency's can never land here.
      id = plugin.parseManifest(await readFile(join(dataDir, entry.name, game.manifest.file), 'utf8'))?.packageId ?? null
    } catch {
      continue
    }
    if (id !== null && id.toLowerCase() !== game.core.toLowerCase()) found.push(id)
  }
  const order = game.dlc.map((id) => id.toLowerCase())
  return found.sort((a, b) => {
    const ai = order.indexOf(a.toLowerCase())
    const bi = order.indexOf(b.toLowerCase())
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
  })
}

/** Rewritten in full every launch; the resolved list is the only source of truth. */
export async function generateModsConfig(plan: LaunchPlan): Promise<string> {
  const game = plan.gameConfig
  const target = join(plan.dataDirHost, game.modsConfig.file)
  await mkdir(dirname(target), { recursive: true })

  const installed = await readInstallVersion(game, plan.plugin)
  if (installed === null) {
    plan.warnings.push(`could not read Version.txt for ${plan.game}; ModsConfig version may be rejected`)
  }
  // Engines fill a case-sensitive active set from these strings but look ids up lowercased, so
  // manifest casing reads back as inactive and SetActive appends a twin. Write lowercase only.
  const declared = new Map([game.core, ...game.dlc].map((id) => [id.toLowerCase(), id]))
  const seen = new Set<string>()
  const activeMods: string[] = []
  for (const mod of plan.mods) {
    const key = mod.packageId.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    activeMods.push(key)
  }

  const knownExpansions = (await readKnownExpansions(game, plan.plugin, plan.warnings)).map(
    (id) => declared.get(id.toLowerCase()) ?? id,
  )
  await writeFile(
    target,
    fromPlugin(target, () =>
      plan.plugin.renderModsConfig({
        version: installed?.version ?? '',
        buildNumber: installed?.buildNumber ?? -1,
        activeMods,
        knownExpansions,
      }),
    ),
  )
  return target
}

/**
 * A plugin that cannot parse or render a game file is a config failure, not a game crash,
 * and the message is useless without the path it was working on.
 */
function fromPlugin(target: string, render: () => string): string {
  try {
    return render()
  } catch (cause) {
    if (cause instanceof GamecrateError) throw cause
    const error = new GamecrateError(`${target}: ${cause instanceof Error ? cause.message : String(cause)}`, Exit.Config)
    error.cause = cause
    throw error
  }
}

/** The keys the tool owns. Everything else in the user's Prefs survives untouched. */
function ownedPrefs(plan: LaunchPlan): Record<string, string> {
  const { settings } = plan
  const bool = (value: boolean): string => (value ? 'True' : 'False')
  const owned: Record<string, string> = {
    screenWidth: String(settings.width),
    screenHeight: String(settings.height),
    devMode: bool(settings.devMode),
    runInBackground: bool(settings.runInBackground),
    ...plan.plugin.windowedPrefs,
  }
  Object.assign(owned, settings.prefsExtra ?? {})
  owned.resetModsConfigOnCrash = 'False'
  return owned
}

/**
 * Merges key-by-key. The live Prefs holds ~40 tuned keys, so a rewrite destroys
 * volumeMaster, uiScale, langFolderName and the nested screenShakeIntensity block.
 */
export async function mergePrefs(plan: LaunchPlan): Promise<string> {
  const target = join(plan.dataDirHost, plan.gameConfig.prefs.file)
  await mkdir(dirname(target), { recursive: true })

  let existing: string | null = null
  try {
    existing = await readFile(target, 'utf8')
  } catch (error) {
    // Only a missing file means "start fresh". Any other read failure and the file is there
    // but unreadable, so writing would drop ~40 tuned keys we never got to see.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(target, fromPlugin(target, () => plan.plugin.mergePrefs(existing, ownedPrefs(plan))))
  return target
}
