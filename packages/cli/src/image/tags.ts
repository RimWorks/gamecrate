export interface TagInput {
  version: string
  branch: string
  variant: string
  /** True when this branch is the first entry of steamBuild.branches. */
  defaultBranch: boolean
  /** True when this variant is the first entry of steamBuild.variants. */
  defaultVariant: boolean
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
  return [...versioned, ...latest]
}
