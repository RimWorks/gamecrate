export interface TagInput {
  version: string
  branch: string
  variant: string
  /** True when this branch is the first entry of steamBuild.branches. */
  defaultBranch: boolean
  /** True when this variant is the first entry of steamBuild.variants. */
  defaultVariant: boolean
  /** Branch aliases, so a moving "2.0" can point at whatever beta is today. */
  aliases?: string[]
}

/**
 * An OCI tag takes no space, so the first whitespace-delimited field is the version and the
 * rest of the line is dropped. "1.6.4871 rev598" becomes "1.6.4871".
 */
export function sanitizeVersion(raw: string, fallback: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? ''
  const mapped = first.replaceAll(/[^A-Za-z0-9._-]/g, '-').replace(/-+$/, '')
  return mapped.length > 0 ? mapped : fallback
}

/**
 * The moving prefixes of a dotted version: 1.6.4871 gives 1 and 1.6, never the whole thing.
 * A prefix follows the newest build that carries it, the way `latest` does.
 */
export function versionPrefixes(version: string): string[] {
  const parts = version.split('.')
  if (parts.length < 2 || parts.some((p) => p === '')) return []
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'))
}

/** Every tag this cell writes. Versioned forms first, latest forms after. */
export function tagsFor(input: TagInput): string[] {
  const scope = input.defaultBranch ? '' : `-${input.branch}`
  const versioned: string[] = []
  const latest: string[] = []
  if (input.defaultVariant) {
    versioned.push(`${input.version}${scope}`)
    latest.push(`latest${scope}`)
  }
  versioned.push(`${input.version}${scope}-${input.variant}`)
  latest.push(`latest${scope}-${input.variant}`)
  // scoped like every other moving tag: two branches on one repo must not race for "1.6"
  for (const prefix of versionPrefixes(input.version)) {
    if (input.defaultVariant) latest.push(`${prefix}${scope}`)
    latest.push(`${prefix}${scope}-${input.variant}`)
  }
  for (const alias of input.aliases ?? []) {
    if (input.defaultVariant) latest.push(alias)
    latest.push(`${alias}-${input.variant}`)
  }
  return [...versioned, ...latest]
}
