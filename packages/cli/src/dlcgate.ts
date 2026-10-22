/**
 * The dlc ids an install of this version cannot load, lowercased. null when the version will not
 * rank, which is a different answer from "nothing to gate" and the caller has to say so.
 */
export function gatedDlc(
  dlc: string[],
  dlcSince: Record<string, string> | undefined,
  version: string,
): Set<string> | null {
  const running = versionRank(version)
  if (running === null) return null
  const out = new Set<string>()
  if (dlcSince === undefined) return out
  const declared = new Set(dlc.map((id) => id.toLowerCase()))
  for (const [id, since] of Object.entries(dlcSince)) {
    const gate = versionRank(since)
    if (gate !== null && gate > running && declared.has(id.toLowerCase())) out.add(id.toLowerCase())
  }
  return out
}

function versionRank(version: string): number | null {
  const parts = /^(\d+)\.(\d+)/.exec(version.trim())
  return parts === null ? null : Number(parts[1]) * 1000 + Number(parts[2])
}
