import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expandHome } from '../config/load'
import { Exit, GamecrateError } from '../types'
import type { GameConfig, RootConfig } from '../types'
import { lockDir } from './source'

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

/**
 * Both content roots steamcmd writes under HOME, host layout first. Measured on 2026-09-21 by
 * running each: the host binary via the arch wrapper writes .steam/SteamApps, and
 * steamcmd/steamcmd with an identity bind and --user writes .local/share/Steam/steamapps.
 * Neither is configurable, and a machine can end up with both, so callers read both. The
 * filesystem is never consulted here: a tree that does not exist yet is still the right place
 * to look.
 */
export function downloadRoots(dataRoot: string, game: GameConfig): string[] {
  const home = steamHome(dataRoot)
  const appId = String(game.steamAppId)
  return [
    join(home, '.steam', 'SteamApps', 'workshop', 'content', appId),
    join(home, '.local', 'share', 'Steam', 'steamapps', 'workshop', 'content', appId),
  ]
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
  // About.xml names the steam client form far more often than the web one: 251 against 72 in a
  // real 367-mod library. StoreAppPage is a store page, not a workshop item, so it stays out.
  const client = /^steam:\/\/url\/CommunityFilePage\/(\d+)$/i.exec(url.trim())
  if (client !== null) return client[1]
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

export type DownloadOutcome =
  | { ok: true; dir: string; bytes: number }
  | { ok: false; reason: string }

export interface DownloadReport {
  items: Map<string, DownloadOutcome>
  warnings: string[]
}

// steamcmd colours its own output, and a code lands mid-sentence in the lines below. the output is
// also not newline separated per item: a real run put the second `Downloading item` on the same
// line as the first `Success.`, so these run over the whole text rather than line by line
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const SUCCESS = /Success\. Downloaded item (\d+) to "([^"]+)" \((\d+) bytes\)/g
const FAILED = /ERROR! Download item (\d+) failed \(([^)]+)\)/g
const ATTEMPTS = 2
const RETRY_DELAY_MS = 1000

/**
 * Downloads every id in one steamcmd invocation. Connect is 3.4s of a 3.5s single-item run, so a
 * hundred ids cost about what one does plus the transfer.
 *
 * A failed item is a warning, not a throw: whatever is already on disk stays usable.
 *
 * An anonymous download can fail transiently and succeed untouched on a second pass, so the
 * misses get one re-run before they count as failures. Two passes, not more: a genuinely
 * unavailable item pays the 3.4s connect for every pass that will never succeed.
 */
export async function downloadItems(
  config: RootConfig,
  game: GameConfig,
  dataRoot: string,
  ids: string[],
): Promise<DownloadReport> {
  const items = new Map<string, DownloadOutcome>()
  const warnings: string[] = []
  if (ids.length === 0) return { items, warnings }

  const runner = resolveSteamcmd(config)
  // docker creates a missing bind source as root, and then the --user process cannot write its own HOME
  mkdirSync(steamHome(dataRoot), { recursive: true })
  const reasons = new Map<string, string>()
  // the whole steam HOME, not one content root: which of the two trees steamcmd writes is not
  // known until it has run, and a lock under a name that moves locks nothing
  const release = await lockDir(steamHome(dataRoot))
  try {
    let pending = ids
    for (let attempt = 0; attempt < ATTEMPTS && pending.length > 0; attempt++) {
      const output = run(runner, game, pending)
      for (const m of output.matchAll(SUCCESS)) {
        items.set(m[1] as string, { ok: true, dir: m[2] as string, bytes: Number(m[3]) })
      }
      for (const m of output.matchAll(FAILED)) reasons.set(m[1] as string, m[2] as string)
      pending = pending.filter((id) => !items.has(id))
      if (pending.length > 0 && attempt + 1 < ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
  } finally {
    await release()
  }

  // the requested set is the verdict. steamcmd's exit code cannot say that one item of a batch
  // failed, so an id it never reported a success for is a failure whatever it printed
  for (const id of ids) {
    if (items.has(id)) continue
    const reason = reasons.get(id) ?? 'steamcmd reported nothing for it'
    items.set(id, { ok: false, reason })
    warnings.push(`could not download workshop item ${id}: ${reason}`)
  }
  return { items, warnings }
}

function run(runner: SteamcmdRunner, game: GameConfig, ids: string[]): string {
  const argv = [
    ...runner.argv,
    '+login', 'anonymous',
    ...ids.flatMap((id) => ['+workshop_download_item', String(game.steamAppId), id]),
    '+quit',
  ]
  const r = spawnSync(argv[0] as string, argv.slice(1), {
    encoding: 'utf8',
    env: { ...process.env, ...runner.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) {
    throw new GamecrateError(
      `could not run steamcmd: ${argv[0]}`,
      Exit.Environment,
      r.error.message,
    )
  }
  // the two streams interleave and both carry result lines, so they are parsed as one text
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(ANSI, '')
}
