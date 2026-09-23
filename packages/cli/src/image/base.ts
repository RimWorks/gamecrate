import { Exit, GamecrateError } from '../types'

export type BaseKind = 'xvfb' | 'proton' | 'none'

/**
 * PLACEHOLDER DIGESTS. Replace both from the first .github/workflows/images.yml run,
 * which prints them in its step summary. A `steam build` against these fails to pull.
 *
 * Pinned by digest, never by tag: a rebuilt base would otherwise change under released code.
 */
export const RUNTIME_BASE: Readonly<Record<'xvfb' | 'proton', string>> = {
  xvfb: 'ghcr.io/rimworks/gamecrate/runtime-base@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  proton:
    'ghcr.io/rimworks/gamecrate/runtime-base-proton@sha256:0000000000000000000000000000000000000000000000000000000000000000',
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
