export interface GateInput {
  /** What steam says the branch is at. null when steamcmd reported none for this branch. */
  published: string | null
  /** True when steam took the login and listed no depots, which says nothing about the branch. */
  noDepots?: boolean
  /** False when no image exists yet. */
  imagePresent: boolean
  /** The steam.buildid label, null when absent. Ignored when imagePresent is false. */
  labelled: string | null
  force: boolean
}

export interface GateDecision {
  build: boolean
  reason:
    | 'forced' | 'no-image' | 'no-label' | 'buildid-changed' | 'up-to-date' | 'unknown-published'
    | 'steam-named-no-depots'
}

/**
 * A skip needs two matching buildids, or steam listing no depots over an image that exists.
 * Callers pass `imagePresent: labels !== null`, `labelled: labels?.['steam.buildid'] ?? null`.
 */
export function decideGate(input: GateInput): GateDecision {
  if (input.force) return { build: true, reason: 'forced' }
  if (!input.imagePresent) return { build: true, reason: 'no-image' }
  if (input.noDepots) return { build: false, reason: 'steam-named-no-depots' }
  if (input.labelled === null) return { build: true, reason: 'no-label' }
  if (input.published === null) return { build: true, reason: 'unknown-published' }
  if (input.published === input.labelled) return { build: false, reason: 'up-to-date' }
  return { build: true, reason: 'buildid-changed' }
}
