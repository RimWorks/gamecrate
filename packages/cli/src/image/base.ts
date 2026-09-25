import { Exit, GamecrateError } from '../types'

export type BaseKind = 'xvfb' | 'proton' | 'none'

/**
 * A major tag, so an apt fix in a base reaches a released cli without a new release. Each built
 * image records the digest this resolved to, which is what makes that safe. See landmines.md.
 */
export const RUNTIME_BASE: Readonly<Record<'xvfb' | 'proton', string>> = {
  xvfb: 'ghcr.io/rimworks/gamecrate/runtime-base:1',
  proton: 'ghcr.io/rimworks/gamecrate/runtime-base-proton:1',
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
