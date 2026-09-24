import { Exit, GamecrateError } from '../types'

export type BaseKind = 'xvfb' | 'proton' | 'none'

/**
 * Pinned by digest, never by tag: a rebuilt base would otherwise change under released code.
 * These are the linux/amd64 manifests, not the index a push reports. See landmines.md.
 */
export const RUNTIME_BASE: Readonly<Record<'xvfb' | 'proton', string>> = {
  xvfb: 'ghcr.io/rimworks/gamecrate/runtime-base@sha256:454f107523fbea816cce2f403855ae9afb0d8e458aa0e83534c06ad7731d04fe',
  proton:
    'ghcr.io/rimworks/gamecrate/runtime-base-proton@sha256:17f9d6962a55fdb621b0a0e63a601110dd20ea1caf4afcdf01e1bc2dea1bfab9',
} as const

/**
 * The ref a variant's layer gets appended onto. null for 'none': a reference image
 * appends onto scratch and never runs, so `--base` does not make one runnable.
 */
export function resolveBase(kind: BaseKind, override?: string): string | null {
  if (kind === 'none') return null
  const pinned = RUNTIME_BASE[kind]
  if (!pinned) {
    throw new GamecrateError(
      `unknown runtime base "${kind}"`,
      Exit.Config,
      `known values: ${[...Object.keys(RUNTIME_BASE), 'none'].join(', ')}`,
    )
  }
  return override ?? pinned
}
