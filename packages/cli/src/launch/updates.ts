import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { status, warn } from '../cli/output'
import { decideGate } from '../image/gate'
import { steamBuild } from '../image/build'
import { resolveSteamBuildInput } from '../image/input'
import { publishedBuildId } from '../mods/steamcmd'
import { imageDigest } from './prepare'
import type { ImageFacts } from './image'
import type { ParsedArgs, RootConfig } from '../types'
import type { UpdateCheckSpec } from '../types'

const DEFAULT_HOURS = 6

export interface CheckInput {
  facts: ImageFacts
  spec: UpdateCheckSpec | undefined
  /** null when this image has never been checked. */
  lastCheckedAt: number | null
  now: number
}

export type SkipReason = 'disabled' | 'not-ours' | 'throttled'

/**
 * An update check spends four seconds and needs a steam session, so it runs only for an image
 * gamecrate built, only when asked, and only once per window.
 */
export function shouldCheck(input: CheckInput): { check: boolean; reason?: SkipReason } {
  if (input.spec?.check === false) return { check: false, reason: 'disabled' }
  const { branch, buildid } = input.facts
  if (!input.facts.present || branch === null || buildid === null) {
    return { check: false, reason: 'not-ours' }
  }
  const hours = input.spec?.everyHours ?? DEFAULT_HOURS
  if (hours <= 0 || input.lastCheckedAt === null) return { check: true }
  const due = input.lastCheckedAt + hours * 3_600_000
  return input.now >= due ? { check: true } : { check: false, reason: 'throttled' }
}

/** Keyed by image id, so a rebuilt image is never judged by the old one's answer. */
function stampFile(imageId: string): string {
  const root = process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache')
  return join(root, 'gamecrate', 'updates', `${imageId.replace(/[^A-Za-z0-9]/g, '-')}.json`)
}

export function lastCheckedAt(imageId: string): number | null {
  const file = stampFile(imageId)
  if (!existsSync(file)) return null
  try {
    const at = (JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }).at
    return typeof at === 'number' ? at : null
  } catch {
    return null
  }
}

export function recordCheck(imageId: string, now: number): void {
  const file = stampFile(imageId)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ at: now }))
  } catch {
    // a stamp that cannot be written costs one repeated check, never a failed launch
  }
}

/**
 * The throttled staleness check a launch runs. Rebuilds the one cell this image came from,
 * after asking, because a rebuild is a multi-gigabyte download nobody asked for by typing a
 * game name.
 */
export async function offerRebuild(input: {
  game: string
  config: RootConfig
  args: ParsedArgs
  facts: ImageFacts
  cwd: string
  configFile?: string
  ask: (question: string) => Promise<boolean>
}): Promise<void> {
  const { game, config, args, facts } = input
  const spec = config.games[game]?.image.updates
  const ref = config.games[game]!.image.ref
  const id = await imageDigest(ref)
  if (id === null) return
  const now = Date.now()
  const verdict = shouldCheck({ facts, spec, lastCheckedAt: lastCheckedAt(id), now })
  if (!verdict.check) return

  // args.plugin is [] when the flag was never typed, and an empty list would resolve nothing
  const plugins = args.plugin !== undefined && args.plugin.length > 0 ? args.plugin : undefined
  const built = await resolveSteamBuildInput(game, config, { plugins }, input.cwd, input.configFile)
  const published = await publishedBuildId(config, built.steamAppId, facts.branch!)
  recordCheck(id, now)
  const decision = decideGate({ published, imagePresent: true, labelled: facts.buildid, force: false })
  if (!decision.build || decision.reason !== 'buildid-changed') return

  const cell = `${facts.branch!}/${facts.variant ?? 'default'}`
  warn(`${game} ${cell} is at build ${facts.buildid}, steam publishes ${published}`)
  if (!(await input.ask(`rebuild ${ref} now? this downloads the game again [y/N] `))) {
    status(`keeping the current image. gamecrate steam build ${game} rebuilds it later`)
    return
  }
  await steamBuild(built, {
    config,
    push: false,
    load: true,
    platform: args.platform ?? 'linux/amd64',
    force: true,
    onlyBranches: [facts.branch!],
    onlyVariants: facts.variant === null ? [] : [facts.variant],
  })
}
