import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'

/** True when `path` is a file this process may run. A directory is not one. */
export function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The first `name` on PATH this process may run, or undefined when no entry holds one. */
export function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    if (executable(candidate)) return candidate
  }
  return undefined
}

/**
 * The binary a build actually ships: the first `candidates` entry present in `dir`, else
 * `configured`. An unknown `dir` leaves `configured` alone.
 */
export function pickExecutable(
  dir: string | null | undefined,
  configured: string,
  candidates?: string[],
): string {
  if (dir === null || dir === undefined || dir === '') return configured
  for (const candidate of candidates ?? []) {
    if (existsSync(join(dir, basename(candidate)))) return candidate
  }
  return configured
}
