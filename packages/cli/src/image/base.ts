import { Exit, GamecrateError } from '../types'

export type BaseKind = 'xvfb' | 'proton' | 'none'

/**
 * Pinned by digest, never by tag: a rebuilt base would otherwise change under released code.
 * These are the linux/amd64 manifests, not the index a push reports. See landmines.md.
 */
export const RUNTIME_BASE: Readonly<Record<'xvfb' | 'proton', string>> = {
  xvfb: 'ghcr.io/rimworks/gamecrate/runtime-base@sha256:bb56228089823908bc3f6452ba3eb10f35f395813b2358758080452201ee4792',
  proton:
    'ghcr.io/rimworks/gamecrate/runtime-base-proton@sha256:55ee5e995a88207074ac455fc1932adb57239da66536bed26041436cb7f44fea',
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
