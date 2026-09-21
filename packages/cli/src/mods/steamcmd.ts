import { accessSync, constants, mkdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { expandHome } from '../config/load'
import { Exit, GamecrateError } from '../types'
import type { GameConfig, RootConfig } from '../types'

export const STEAMCMD_IMAGE = 'steamcmd/steamcmd'

/**
 * `host` spawns argv directly with env; `docker` already carries the bind and the user mapping.
 * Either way a caller appends steamcmd's own flags to argv.
 */
export type SteamcmdRunner =
  | { kind: 'host'; argv: string[]; env: Record<string, string> }
  | { kind: 'docker'; argv: string[]; env: Record<string, string> }

/** HOME for steamcmd. Everything it writes hangs off here, so it is per-dataRoot, not the user's. */
export function steamHome(dataRoot: string): string {
  return join(dataRoot, 'steam')
}

// verified against a real steamcmd run on 2026-09-20: steamcmd builds this whole chain under
// HOME itself, so it is derived rather than configured.
export function downloadRoot(dataRoot: string, game: GameConfig): string {
  return join(steamHome(dataRoot), '.steam', 'SteamApps', 'workshop', 'content', String(game.steamAppId))
}

/**
 * Configured path if set, else PATH, else the docker image. A configured path that is not an
 * executable file is an error, not a fallback. Docker gets `--user`: without it the tree
 * comes back root-owned and the next run with a host binary cannot write it. The bind is an
 * identity bind so the paths steamcmd prints are valid on the host too.
 */
export function resolveSteamcmd(config: RootConfig): SteamcmdRunner {
  const home = steamHome(config.dataRoot)
  const configured = config.steamcmd?.path === undefined ? undefined : expandHome(config.steamcmd.path)
  if (configured !== undefined) {
    if (!executable(configured)) {
      throw new GamecrateError(
        `steamcmd.path is not an executable file: ${configured}`,
        Exit.Environment,
        'point steamcmd.path at the steamcmd binary, or remove it to use PATH or docker',
      )
    }
    return { kind: 'host', argv: [configured], env: { HOME: home } }
  }
  const found = onPath('steamcmd')
  if (found !== undefined) return { kind: 'host', argv: [found], env: { HOME: home } }
  if (onPath('docker') !== undefined) {
    // docker creates a missing bind source as root, and then the --user process cannot write its own HOME
    mkdirSync(home, { recursive: true })
    return {
      kind: 'docker',
      argv: [
        'docker', 'run', '--rm',
        '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        '-v', `${home}:${home}`,
        '-e', `HOME=${home}`,
        STEAMCMD_IMAGE,
      ],
      env: {},
    }
  }
  throw new GamecrateError(
    'steamcmd is not available',
    Exit.Environment,
    `steamcmd.path is unset, steamcmd is not on PATH, and docker is not there to run ${STEAMCMD_IMAGE}`,
  )
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    if (executable(candidate)) return candidate
  }
  return undefined
}

/** The published file id out of a workshop url, or undefined if it is not one. */
export function workshopUrlId(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (!/(^|\.)steamcommunity\.com$/.test(parsed.hostname.toLowerCase())) return undefined
  const id = parsed.searchParams.get('id')
  return id !== null && /^\d+$/.test(id) ? id : undefined
}
