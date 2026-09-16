import type { Settings } from '../types'

export const DEFAULT_DATA_ROOT = '~/.local/share/gamecrate'

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
