export interface GateInput {
  /** What steam says the branch is at. null when steamcmd reported none for this branch. */
  published: string | null
  /** False when no image exists yet. */
  imagePresent: boolean
  /** The steam.buildid label, null when absent. Ignored when imagePresent is false. */
  labelled: string | null
  force: boolean
}

export interface GateDecision {
  build: boolean
  reason: 'forced' | 'no-image' | 'no-label' | 'buildid-changed' | 'up-to-date' | 'unknown-published'
}

/**
 * A skip needs proof, so everything short of two matching buildids builds.
 * Callers pass `imagePresent: labels !== null`, `labelled: labels?.['steam.buildid'] ?? null`.
 */
export function decideGate(input: GateInput): GateDecision {
  if (input.force) return { build: true, reason: 'forced' }
  if (!input.imagePresent) return { build: true, reason: 'no-image' }
  if (input.labelled === null) return { build: true, reason: 'no-label' }
  if (input.published === null) return { build: true, reason: 'unknown-published' }
  if (input.published === input.labelled) return { build: false, reason: 'up-to-date' }
  return { build: true, reason: 'buildid-changed' }
}
