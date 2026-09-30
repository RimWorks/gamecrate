import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { status } from '../cli/output'
import { capture } from '../docker/run'
import { downloadApp, publishedBuildId, steamHome } from '../mods/steamcmd'
import type { AppDownload } from '../mods/steamcmd'
import { Exit, GamecrateError } from '../types'
import type { RootConfig, SteamBranch, SteamVariant } from '../types'

import { resolveBase } from './base'
import { checkRegistryAuthEarly, craneAppend, craneDigest, craneLabels, craneMutateLabels, cranePush, craneTag } from './crane'
import { decideGate } from './gate'
import { branchPassword } from './input'
import type { SteamBuildInput } from './input'
import { sanitizeVersion, tagsFor } from './tags'

export interface CellResult {
  branch: string
  variant: string
  status: 'built' | 'skipped' | 'failed'
  reason: string
  tags: string[]
}

export interface SteamBuildOptions {
  config: RootConfig
  push: boolean
  load: boolean
  platform: string
  baseOverride?: string
  force: boolean
  /** --beta, repeatable. Undefined or empty means every declared branch. */
  onlyBranches?: string[]
  /** --variant, repeatable. Undefined or empty means every declared variant. */
  onlyVariants?: string[]
  /** --alias, repeatable. Extra aliases for every branch built, on top of its declared tags. */
  extraTags?: string[]
  /** The matrix, once it is narrowed, so a progress view can draw every row before work starts. */
  onPlan?: (cells: readonly PlannedCell[]) => void
  /** Each cell as it changes. `id` is `<branch>/<variant>`. */
  onCell?: (id: string, patch: CellProgress) => void
}

export interface PlannedCell {
  id: string
  branch: string
  variant: string
  base: string
}

export interface CellProgress {
  state?: 'running' | 'done' | 'skipped' | 'failed'
  detail?: string
}

/**
 * One row per cell attempted, in branch order then variant order. A cell failure is a row and
 * never a throw, because a throw would lose the rows for the cells that worked.
 */
export async function steamBuild(input: SteamBuildInput, opts: SteamBuildOptions): Promise<CellResult[]> {
  const branches = branchesFor(input.branches, opts.onlyBranches)
  const variants = narrow(input.variants, opts.onlyVariants, 'variant', 'variants')
  // before the first download, and only on a push: nothing else here talks to a registry
  if (opts.push) checkRegistryAuthEarly(input.image)
  // the declared first entry, not the first surviving one: --variant linux-ref never takes :latest
  const defaultBranch = input.branches[0]!.name
  const defaultVariant = input.variants[0]!.name
  const results: CellResult[] = []

  opts.onPlan?.(
    branches.flatMap((branch) =>
      variants.map((variant) => ({
        id: `${branch.name}/${variant.name}`,
        branch: branch.name,
        variant: variant.name,
        base: variant.base,
      })),
    ),
  )

  for (const branch of branches) {
    const published = await publishedBuildId(opts.config, input.steamAppId, branch.name).catch(() => null)
    // per branch, because a branch is a different set of files
    const downloads = new Map<string, Promise<AppDownload>>()
    for (const variant of variants) {
      results.push(await cell(input, opts, { branch, variant, published, defaultBranch, defaultVariant, downloads }))
    }
  }
  return results
}

/**
 * The branches --beta asked for, in the order it asked. A name the config never declared is
 * built as itself, because steam owns the branch list and no config here can enumerate it.
 */
export function branchesFor(all: SteamBranch[], only: string[] | undefined): SteamBranch[] {
  if (only === undefined || only.length === 0) return all
  const declared = new Map(all.map((branch) => [branch.name, branch]))
  return only.map((name) => declared.get(name) ?? { name })
}

function narrow<T extends { name: string }>(
  all: T[],
  only: string[] | undefined,
  kind: string,
  plural: string,
): T[] {
  if (only === undefined || only.length === 0) return all
  const known = new Set(all.map((entry) => entry.name))
  const missing = only.filter((name) => !known.has(name))
  if (missing.length > 0) {
    throw new GamecrateError(
      `unknown ${kind} ${missing.join(', ')}`,
      Exit.Usage,
      `declared ${plural}: ${all.map((entry) => entry.name).join(', ')}`,
    )
  }
  return all.filter((entry) => only.includes(entry.name))
}

interface CellContext {
  branch: SteamBranch
  variant: SteamVariant
  published: string | null
  defaultBranch: string
  defaultVariant: string
  downloads: Map<string, Promise<AppDownload>>
}

async function cell(input: SteamBuildInput, opts: SteamBuildOptions, ctx: CellContext): Promise<CellResult> {
  const { branch, variant } = ctx
  const row = { branch: branch.name, variant: variant.name }
  const id = `${branch.name}/${variant.name}`
  // a cell can run for forty minutes, so every decision says itself as it is made
  const say = (text: string): void => {
    opts.onCell?.(id, { detail: text })
    status(`${id}  ${text}`)
  }
  opts.onCell?.(id, { state: 'running' })
  // a base: 'none' variant appends onto scratch, so its config carries no architecture and
  // docker build --label refuses it. it is a registry artifact, and nothing local can run it
  if (!opts.push && variant.base === 'none') {
    opts.onCell?.(id, { state: 'skipped', detail: 'reference-only, use --push' })
    say('skipped, reference-only, use --push')
    return { ...row, status: 'skipped', reason: 'reference-only, use --push', tags: [] }
  }
  const tagInput = {
    branch: branch.name,
    variant: variant.name,
    defaultBranch: branch.name === ctx.defaultBranch,
    defaultVariant: variant.name === ctx.defaultVariant,
    aliases: [...(branch.tags ?? []), ...(opts.extraTags ?? [])],
  }
  // the version is unknown before the download, so the gate reads this cell's moving tag
  const moving = tagsFor({ version: null, ...tagInput })
  const gateRef = `${input.image}:${moving[0]!}`

  const found = await readGate(gateRef, opts)
  const decision = decideGate({
    published: ctx.published,
    imagePresent: found.present,
    labelled: found.buildid,
    force: opts.force,
  })
  if (!decision.build) {
    try {
      await moveTags(input.image, gateRef, moving.slice(1), opts)
    } catch (error) {
      opts.onCell?.(id, { state: 'failed', detail: message(error) })
      return { ...row, status: 'failed', reason: message(error), tags: [] }
    }
    opts.onCell?.(id, { state: 'skipped', detail: decision.reason })
    say(`skipped, ${decision.reason}`)
    return { ...row, status: 'skipped', reason: decision.reason, tags: moving }
  }

  try {
    const dir = await download(input, opts, ctx, say)
    const raw = await readFile(join(dir, input.versionFile), 'utf8')
    const version = sanitizeVersion(raw, ctx.published ?? 'unknown')
    const tags = tagsFor({ ...tagInput, version })

    const layers = join(steamHome(opts.config.dataRoot), 'layers')
    // docker creates a missing bind source as root, and the --user process then cannot write it
    mkdirSync(layers, { recursive: true })
    const tar = join(layers, `${branch.name}-${variant.name}-${version}.tar`)
    const base = resolveBase(variant.base, opts.baseOverride)
    // the tag is what we append onto, the digest is what the image records it was built on
    const baseDigest = base === null ? null : await resolvedBase(base, opts.platform)
    const versioned = `${input.image}:${tags[0]!}`
    try {
      say(`appending onto ${base ?? 'scratch'}`)
      await craneAppend({
        gameDir: dir,
        include: variant.include,
        gamePath: input.gamePath,
        base,
        platform: opts.platform,
        tag: versioned,
        out: tar,
      })

      if (opts.push) {
        say(`pushing ${versioned}`)
        await cranePush(tar, versioned)
        await craneMutateLabels(versioned, labelsFor(input, ctx, baseDigest))
        // only now: a half-pushed build must not move latest
        for (const tag of tags.slice(1)) await craneTag(versioned, tag)
      }
      // a scratch image carries no architecture, so the local daemon cannot run it
      if (opts.load && base !== null) {
        say(`loading ${versioned}`)
        await dockerLoad(tar, versioned)
        await dockerLabel(versioned, labelsFor(input, ctx, baseDigest))
        // off the labelled ref, so a moving tag never points at an unlabelled image
        for (const tag of tags.slice(1)) await dockerTag(versioned, `${input.image}:${tag}`)
      }
    } finally {
      // a whole game per cell, so it goes as soon as push and load are done reading it. the
      // intermediate is removed here too: the script's own rm is skipped when set -e trips
      rmSync(tar, { force: true })
      rmSync(`${tar}.layer.tar`, { force: true })
    }
    opts.onCell?.(id, { state: 'done', detail: decision.reason })
    return { ...row, status: 'built', reason: decision.reason, tags }
  } catch (error) {
    opts.onCell?.(id, { state: 'failed', detail: message(error) })
    return { ...row, status: 'failed', reason: message(error), tags: [] }
  }
}

async function moveTags(
  image: string,
  ref: string,
  tags: string[],
  opts: SteamBuildOptions,
): Promise<void> {
  for (const tag of tags) {
    if (opts.push) await craneTag(ref, tag)
    if (opts.load) await dockerTag(ref, `${image}:${tag}`)
  }
}

/** The cached +app_update for this branch and depot. Two variants on one depot share it. */
async function download(
  input: SteamBuildInput,
  opts: SteamBuildOptions,
  ctx: CellContext,
  say: (text: string) => void,
): Promise<string> {
  const key = ctx.variant.depot ?? 'default'
  let pending = ctx.downloads.get(key)
  if (pending === undefined) {
    say(`downloading ${input.steamAppId} (branch ${ctx.branch.name}, depot ${key})`)
    pending = downloadApp(opts.config, {
      steamAppId: input.steamAppId,
      branch: ctx.branch.name,
      depot: ctx.variant.depot,
      password: branchPassword(ctx.branch),
      dataRoot: opts.config.dataRoot,
    })
    ctx.downloads.set(key, pending)
  } else {
    say(`reusing the ${ctx.branch.name} ${key} download`)
  }
  return (await pending).dir
}

function loadOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim() || '(no output)'
}

/** A tag records as the digest it resolved to. An unreadable one records as itself. */
async function resolvedBase(base: string, platform: string): Promise<string> {
  if (base.includes('@sha256:')) return base
  const digest = await craneDigest(base, platform)
  return digest === null ? base : `${base.split(':')[0]!}@${digest}`
}

/** What phase 5 reads back off the image. */
function labelsFor(input: SteamBuildInput, ctx: CellContext, base: string | null): Record<string, string> {
  const labels: Record<string, string> = {
    'gamecrate.variant': ctx.variant.name,
    'gamecrate.branch': ctx.branch.name,
    'gamecrate.executable': ctx.branch.executable?.[ctx.variant.name] ?? ctx.variant.executable ?? input.executable,
    'gamecrate.launcher': ctx.variant.base === 'windows' ? 'proton' : 'direct',
  }
  if (ctx.published !== null) labels['steam.buildid'] = ctx.published
  if (base !== null) labels['gamecrate.runtime'] = base
  return labels
}

/**
 * Presence and the label stay apart, or a missing label reads as a missing image. With both
 * --push and --load the older of the two destinations decides: a current registry says nothing
 * about the local daemon, and skipping on it leaves `run` with no image to start.
 */
async function readGate(ref: string, opts: SteamBuildOptions): Promise<{ present: boolean; buildid: string | null }> {
  const reads: (Record<string, string> | null)[] = []
  if (opts.push) reads.push(await craneLabels(ref))
  if (opts.load) reads.push(await inspectLabels(ref))
  if (reads.includes(null)) return { present: false, buildid: null }
  const ids = reads.map((labels) => labels?.['steam.buildid'] ?? null)
  return { present: reads.length > 0, buildid: ids.every((id) => id === ids[0]) ? (ids[0] ?? null) : null }
}

/** The --load gate. null when the local daemon has no such image. */
async function inspectLabels(ref: string): Promise<Record<string, string> | null> {
  const { code, stdout } = await capture(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', ref])
  if (code !== 0) return null
  try {
    return (JSON.parse(stdout.trim()) as Record<string, string> | null) ?? {}
  } catch {
    return null
  }
}

/** The tar carries its own tag, so docker names the loaded image and nothing parses an id. */
async function dockerLoad(tar: string, ref: string): Promise<void> {
  const { code, stdout, stderr } = await capture(['docker', 'load', '-i', tar])
  if (code !== 0 || !stdout.includes(`Loaded image: ${ref}`)) {
    throw new GamecrateError(
      `docker load failed for ${tar}`,
      Exit.Environment,
      `expected "Loaded image: ${ref}", got: ${loadOutput(stdout, stderr)}`,
    )
  }
}

/**
 * Docker has no label-only mutate, so a one-line FROM carries them. Config only, no new layer:
 * measured 1.4s on a 3.1GB base, and the same seven RootFS layers as the image it came from.
 * The context is an empty temp dir: the layers directory would ship gigabytes to the daemon.
 */
async function dockerLabel(ref: string, labels: Record<string, string>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gamecrate-label-'))
  writeFileSync(join(dir, 'Dockerfile'), `FROM ${ref}\n`)
  const argv = ['docker', 'build', '-f', join(dir, 'Dockerfile'), '-t', ref]
  for (const [key, value] of Object.entries(labels)) argv.push('--label', `${key}=${value}`)
  argv.push(dir)
  const { code, stdout, stderr } = await capture(argv)
  rmSync(dir, { recursive: true, force: true })
  if (code !== 0) {
    throw new GamecrateError(`docker build --label failed for ${ref}`, Exit.Environment, `${stdout}\n${stderr}`.trim())
  }
}

async function dockerTag(from: string, ref: string): Promise<void> {
  const { code, stdout, stderr } = await capture(['docker', 'tag', from, ref])
  if (code !== 0) {
    throw new GamecrateError(`docker tag ${ref} failed`, Exit.Environment, `${stdout}\n${stderr}`.trim())
  }
}

/**
 * The detail carries the fix, and without it an auth failure and a 502 read the same. The results
 * table is one line per row, so a multi-line detail such as crane's own output collapses into one.
 */
function message(error: unknown): string {
  const head = error instanceof Error ? error.message : String(error)
  const detail = error instanceof GamecrateError ? error.detail?.replaceAll(/\s+/g, ' ').trim() : undefined
  return detail ? `${head}: ${detail}` : head
}
