import type { Settings } from '../types'
import { RUNTIME_BASE } from '../image/base'

export const DEFAULT_DATA_ROOT = '~/.local/share/gamecrate'

/**
 * The published runtime a mounted install runs in, filled in when a config names no image. A
 * `source: image` game carries the game itself, so no default can stand in for it.
 */
export function applyDefaultImage(config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config
  const games = (config as { games?: unknown }).games
  if (typeof games !== 'object' || games === null) return config
  for (const game of Object.values(games as Record<string, unknown>)) {
    if (typeof game !== 'object' || game === null) continue
    const g = game as { image?: unknown; gameFiles?: { source?: unknown } }
    if (g.image !== undefined) continue
    if (g.gameFiles?.source !== 'mount') continue
    g.image = { ref: RUNTIME_BASE.linux }
  }
  return config
}

export const DEFAULT_SETTINGS: Settings = {
  width: 1920,
  height: 1080,
  devMode: true,
  runInBackground: true,
  resetModsConfigOnCrash: false,
  gpu: true,
  audio: true,
  input: false,
  network: 'bridge',
  display: 'x11',
  memory: '8g',
  cpus: 6,
  pidsLimit: 1024,
}
