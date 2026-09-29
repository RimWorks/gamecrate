import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { readFromImage } from './prepare'
import { expandHome } from '../config/load'
import { GamecrateError, Exit } from '../types'
import type { GamePlugin } from '../plugin'
import type { GameConfig, LaunchPlan, ModSettingsFile } from '../types'

async function readInstallVersion(
  game: GameConfig,
  plugin: GamePlugin,
): Promise<{ version: string; buildNumber: number } | null> {
  const raw = await installVersionText(game)
  if (raw === null) return null
  return plugin.parseVersion(raw.replace(/^﻿/, '').trim())
}

async function installVersionText(game: GameConfig): Promise<string | null> {
  if (game.gameFiles.source !== 'mount') {
    const ref = game.image?.ref
    return ref === undefined || ref === ''
      ? null
      : await readFromImage(ref, `${game.gameFiles.container}/${game.version.file}`)
  }
  const host = game.gameFiles.host
  if (host === undefined) return null
  try {
    return await readFile(join(expandHome(host), game.version.file), 'utf8')
  } catch {
    return null
  }
}

async function readKnownExpansions(
  game: GameConfig,
  plugin: GamePlugin,
  warnings: string[],
): Promise<string[]> {
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
    plan.warnings.push(`could not read ${game.version.file} for ${plan.game}; ModsConfig version may be rejected`)
  }
  // engines fill a case-sensitive active set but look ids up lowercased
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(target, fromPlugin(target, () => plan.plugin.mergePrefs(existing, ownedPrefs(plan))))
  return target
}

export async function writeModSettings(plan: LaunchPlan, blocks: readonly ModSettingsFile[]): Promise<string[]> {
  const written: string[] = []
  const dir = plan.gameConfig.modSettingsDir
  const render = plan.plugin.renderModSettings
  if (dir === undefined || render === undefined) return written

  const root = resolve(plan.dataDirHost, dir)
  for (const block of blocks) {
    const target = resolve(root, block.file)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new GamecrateError(
        `modSettings file "${block.file}" points outside ${root}`,
        Exit.Config,
        'a settings file is named relative to that directory, and cannot climb out of it',
      )
    }
    let existing: string | null = null
    try {
      existing = await readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const next = fromPlugin(target, () => render(existing, block))
    if (next === existing) continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, next)
    written.push(target)
  }
  return written
}

