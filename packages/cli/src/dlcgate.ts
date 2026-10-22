/**
 * The dlc ids an install of this version cannot load, lowercased. A version that will not rank
 * gates nothing, so a caller that wants to say so checks `versionRank` itself.
 */
export function gatedDlc(
  dlc: string[],
  dlcSince: Record<string, string> | undefined,
  version: string,
): Set<string> {
  const out = new Set<string>()
  const running = versionRank(version)
  if (running === null || dlcSince === undefined) return out
  const declared = new Set(dlc.map((id) => id.toLowerCase()))
  for (const [id, since] of Object.entries(dlcSince)) {
    const gate = versionRank(since)
    if (gate !== null && gate > running && declared.has(id.toLowerCase())) out.add(id.toLowerCase())
  }
  return out
}

/** Major and minor only. "1.4" and "1.4.3901 rev238" rank the same, which is what a gate compares. */
export function versionRank(version: string): number | null {
  const parts = /^(\d+)\.(\d+)/.exec(version.trim())
  return parts === null ? null : Number(parts[1]) * 1000 + Number(parts[2])
}
