import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative } from 'node:path'

import type { StaleReport } from '../types'

const SKIP_DIRS = new Set(['.git', '.retired', '.vs', 'bin', 'node_modules', 'obj'])

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
export async function scanBuildTimes(dir: string, limit = ENTRY_LIMIT): Promise<BuildTimes> {
  const state: WalkState = { root: dir, times: { sourceTimes: [] }, budget: limit }
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
  for (const entry of ordered(entries)) {
    if (state.budget-- <= 0) return
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      // RimWorld ships per-version Assemblies dirs, at any depth
      if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
        await walk(state, path, inAssemblies || entry.name === 'Assemblies')
      }
      continue
    }
    if (entry.isFile()) await record(state, path, entry.name, inAssemblies)
  }
}

const WANTED_DIRS = new Set(['source', 'assemblies'])

function ordered(entries: Dirent[]): Dirent[] {
  const rank = (entry: Dirent): number => {
    if (entry.isDirectory()) return WANTED_DIRS.has(entry.name.toLowerCase()) ? 0 : 2
    return 1
  }
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
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
