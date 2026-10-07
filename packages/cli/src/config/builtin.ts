import type { Settings } from '../types'
import { RUNTIME_BASE } from '../image/base'

export const DEFAULT_DATA_ROOT = '~/.local/share/gamecrate'

/**
 * The published runtime a mounted install runs in, filled in when a config names no image. A
 * `source: image` game carries the game itself, so no default can stand in for it.
 */
export function applyDefaultImage(config: unknown, flags?: { game?: string; image?: string }): unknown {
  if (typeof config !== 'object' || config === null) return config
  const games = (config as { games?: unknown }).games
  if (typeof games !== 'object' || games === null) return config
  for (const [name, game] of Object.entries(games as Record<string, unknown>)) {
    if (typeof game !== 'object' || game === null) continue
    const g = game as GameBlock
    if (name === flags?.game && flags.image !== undefined) applyImageFlag(g, flags.image)
    if (g.image !== undefined) continue
    if (g.gameFiles?.source !== 'mount') continue
    g.image = { ref: RUNTIME_BASE.linux }
  }
  return config
}

interface GameBlock {
  image?: { ref?: unknown }
  gameFiles?: { source?: unknown; host?: unknown }
}

function applyImageFlag(g: GameBlock, ref: string): void {
  if (g.gameFiles !== undefined) g.gameFiles.source = 'image'
  if (g.image === undefined) g.image = { ref }
  else g.image.ref = ref
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
