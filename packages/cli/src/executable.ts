import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

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
