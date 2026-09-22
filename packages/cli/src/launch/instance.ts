import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'

import { collectRequests } from '../mods/worktree'
import { GamecrateError, Exit, NAME_PATTERN, own } from '../types'
import type {
  InstanceConfig,
  ParsedArgs,
  Problem,
  ProfileConfig,
  Settings,
  WorktreeRequest,
} from '../types'

/** Enough to keep a name readable in `docker ps` without truncating the hash off the end. */
const SLUG_LIMIT = 24

export interface InstanceSelection {
  /** Undefined for the base profile. */
  name?: string
  /** profileDir, or <profileDir>/instances/<name>. */
  dir: string
  requests: WorktreeRequest[]
  problems: Problem[]
  settings?: Partial<Settings>
}

export interface InstanceOptions {
  profileDir: string
  /** Absent when the caller only has a profile name, as `clean` on an unknown profile does. */
  profile?: ProfileConfig
  args: Partial<ParsedArgs>
  cwd?: string
  env?: string
}

/** Decides which sub-run of a profile this is. Any worktree in the set forks one. */
export function resolveInstance(options: InstanceOptions): InstanceSelection {
  const { profileDir, profile, args } = options
  const configured = lookup(profile, args.instance)

  const flags = configured?.worktree === undefined
    ? (args.worktree ?? [])
    : [configured.worktree, ...(args.worktree ?? [])]

  const { requests, problems } = collectRequests(
    flags,
    options.env ?? process.env['GAMECRATE_WORKTREE'],
    options.cwd ?? process.cwd(),
    args.noWorktree ?? false,
  )

  const name = args.instance === undefined ? derive(requests) : named(args.instance)
  return {
    ...(name === undefined ? {} : { name }),
    dir: name === undefined ? profileDir : join(profileDir, 'instances', name),
    requests,
    problems,
    ...(configured?.settings === undefined ? {} : { settings: configured.settings }),
  }
}

/** Same case-insensitive courtesy a profile key gets, so `--instance WT-A` finds `wt-a`. */
function lookup(profile: ProfileConfig | undefined, name: string | undefined): InstanceConfig | undefined {
  const instances = profile?.instances
  if (instances === undefined || name === undefined) return undefined
  const exact = own(instances, name)
  if (exact !== undefined) return exact
  const lower = name.toLowerCase()
  const key = Object.keys(instances).find((k) => k.toLowerCase() === lower)
  return key === undefined ? undefined : own(instances, key)
}

function named(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new GamecrateError(
      `invalid instance name "${name}"`,
      Exit.Usage,
      `it becomes a directory and a container name, so it must match ${NAME_PATTERN.source}`,
    )
  }
  return name
}

/**
 * A cwd worktree names an instance the same as an explicit one: it stages a different mod set,
 * so it must not share a save dir, a lock or a container name with the profile. The hash covers
 * every root because two repos can both hold a worktree called `fix-thing`.
 */
function derive(requests: WorktreeRequest[]): string | undefined {
  const first = requests[0]
  if (first === undefined) return undefined

  const digest = createHash('sha256').update(requests.map((r) => r.root).join('\0')).digest('hex')
  return `${slug(first.root)}-${digest.slice(0, 6)}`
}

function slug(root: string): string {
  let body = basename(root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, SLUG_LIMIT)
  while (body !== '' && '-._'.includes(body.slice(-1))) body = body.slice(0, -1)
  return body === '' ? 'wt' : body
}
