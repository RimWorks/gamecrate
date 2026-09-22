import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { StaleReport } from '../types'

/** Directories that never hold a mod's own sources or shipped assemblies. */
const SKIP_DIRS = new Set(['.git', '.retired', '.vs', 'bin', 'node_modules', 'obj'])

/**
 * A mod's Textures tree alone runs to five figures, so the cap has to clear it. A walk that
 * stops before it reaches Source/ reports "fresh" for a mod it never looked at.
 */
const ENTRY_LIMIT = 20_000

export interface Timestamped {
  /** Relative to the mod directory. */
  path: string
  mtimeMs: number
}

export interface BuildTimes {
  newestSource?: Timestamped
  newestAssembly?: Timestamped
  /** Every .cs mtime, so a report can count how many beat the assembly. */
  sourceTimes: number[]
}

/** One walk answers both questions: is this stale, and which files say so. */
export async function scanBuildTimes(dir: string): Promise<BuildTimes> {
  const state: WalkState = { root: dir, times: { sourceTimes: [] }, budget: ENTRY_LIMIT }
  await walk(state, dir, false)
  return state.times
}

interface WalkState {
  root: string
  times: BuildTimes
  budget: number
}

async function walk(state: WalkState, current: string, inAssemblies: boolean): Promise<void> {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (state.budget-- <= 0) return
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      // RimWorld ships per-version Assemblies dirs, so it is any depth, not just the root.
      if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
        await walk(state, path, inAssemblies || entry.name === 'Assemblies')
      }
      continue
    }
    if (entry.isFile()) await record(state, path, entry.name, inAssemblies)
  }
}

async function record(state: WalkState, path: string, name: string, inAssemblies: boolean): Promise<void> {
  const lower = name.toLowerCase()
  const isSource = lower.endsWith('.cs')
  const isAssembly = inAssemblies && lower.endsWith('.dll')
  if (!isSource && !isAssembly) return

  let mtimeMs: number
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    return
  }
  const { times } = state
  const found: Timestamped = { path: relative(state.root, path), mtimeMs }
  if (isSource) {
    times.sourceTimes.push(mtimeMs)
    if (mtimeMs > (times.newestSource?.mtimeMs ?? -1)) times.newestSource = found
  } else if (mtimeMs > (times.newestAssembly?.mtimeMs ?? -1)) {
    times.newestAssembly = found
  }
}

/**
 * One build writes a dll and touches a source microseconds apart, so a bare `>` calls a clean
 * build stale. Measured on two real mods: 0.054ms and 7ms. A forgotten rebuild is minutes old
 * at least, so a second separates the two without hiding one.
 */
const SKEW_MS = 1000

function newerThan(source: number, assembly: number): boolean {
  return source - assembly > SKEW_MS
}

/**
 * Drives `--build auto`, so a mod that has never been compiled counts as stale. The warning
 * is the stricter one: see staleReport.
 */
export function decideStale(times: BuildTimes): boolean {
  const { newestSource, newestAssembly } = times
  if (newestSource === undefined) return false
  return newestAssembly === undefined || newerThan(newestSource.mtimeMs, newestAssembly.mtimeMs)
}

/**
 * Null when there is nothing to say: no C#, no assemblies to compare against, or the build is
 * current. A mod may legitimately ship XML only, so this never reports on one.
 */
export function staleReport(times: BuildTimes): StaleReport | null {
  const { newestSource, newestAssembly } = times
  if (newestSource === undefined || newestAssembly === undefined) return null
  if (!newerThan(newestSource.mtimeMs, newestAssembly.mtimeMs)) return null
  return {
    newestSource: newestSource.path,
    newestSourceMs: newestSource.mtimeMs,
    assembly: newestAssembly.path,
    assemblyMs: newestAssembly.mtimeMs,
    newerCount: times.sourceTimes.filter((t) => newerThan(t, newestAssembly.mtimeMs)).length,
  }
}

/** Lines up the continuation under the message, past the `warning: ` that warn() adds. */
const INDENT = ' '.repeat('warning: '.length)

export function staleWarning(packageId: string, report: StaleReport, now = Date.now()): string {
  const files = report.newerCount === 1 ? '1 source file' : `${report.newerCount} source files`
  return [
    `${packageId} has ${files} newer than ${report.assembly}`,
    `${INDENT}newest: ${report.newestSource} (${ago(report.newestSourceMs, now)})`,
    `${INDENT}you are probably running a stale build`,
  ].join('\n')
}

/** Coarse on purpose: "4m" is the whole signal, a duration to the second is noise. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

export function ago(mtimeMs: number, now = Date.now()): string {
  return `${duration(now - mtimeMs)} ago`
}
