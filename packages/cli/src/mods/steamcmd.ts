import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { warn } from '../cli/output'
import { expandHome } from '../config/load'
import { captureLive } from '../docker/run'
import { Exit, GamecrateError } from '../types'
import type { GameConfig, RootConfig } from '../types'
import type { TaskState } from '../cli/taskboard'
import { lockDir } from './source'

export const STEAMCMD_IMAGE = 'steamcmd/steamcmd'

/**
 * `host` spawns argv directly with env; `docker` already carries the bind and the user mapping.
 * Either way a caller appends steamcmd's own flags to argv.
 */
export type SteamcmdRunner =
  | { kind: 'host'; argv: string[]; env: Record<string, string> }
  | { kind: 'docker'; argv: string[]; env: Record<string, string>; home: string }

/** HOME for steamcmd. Everything it writes hangs off here, so it is per-dataRoot, not the user's. */
export function steamHome(dataRoot: string): string {
  return join(dataRoot, 'steam')
}

/** Where `steam login` records the account it signed in with, so a build needs no variable. */
export function accountFile(dataRoot: string): string {
  return join(steamHome(dataRoot), 'account')
}

/**
 * One answer to "who is logging in": STEAM_USERNAME for CI, else the name `steam login` wrote.
 * Neither is an error rather than a null, because a null reads downstream as "steam said nothing".
 */
export function steamAccount(dataRoot: string): string {
  const fromEnv = process.env.STEAM_USERNAME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const file = accountFile(dataRoot)
  const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  if (saved !== '') return saved
  throw new GamecrateError(
    'a game download needs a steam account',
    Exit.Environment,
    `set STEAM_USERNAME, or run \`gamecrate steam login\` once to record one at ${file}`,
  )
}

/**
 * Where downloads land. `run` pins it with `+force_install_dir`, so this is our layout rather
 * than whichever one the steamcmd on this machine would have picked.
 */
export function downloadRoot(dataRoot: string, game: GameConfig): string {
  return join(steamHome(dataRoot), 'steamapps', 'workshop', 'content', String(game.steamAppId))
}

/**
 * Drops a game's downloaded items and the .acf beside them. Never the steamcmd install above
 * those: that is 200MB of bootstrap which would re-download for nothing. Returns what it did.
 */
export async function removeDownloads(root: string, steamAppId: number): Promise<string> {
  if (!existsSync(root)) return `no workshop downloads at ${root}`
  const items = (await readdir(root).catch(() => [])).length
  await rm(root, { recursive: true, force: true })
  await rm(join(dirname(dirname(root)), `appworkshop_${steamAppId}.acf`), { force: true })
  return `removed ${root} (${items} item(s))`
}

/**
 * Configured path if set, else PATH, else the docker image. A configured path that is not an
 * executable file is an error, not a fallback.
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
      home,
    }
  }
  throw new GamecrateError(
    'steamcmd is not available',
    Exit.Environment,
    `steamcmd.path is unset, steamcmd is not on PATH, and docker is not there to run ${STEAMCMD_IMAGE}`,
  )
}

const IMAGE_STEAM = '/root/.local/share/Steam'

function prewarm(runner: SteamcmdRunner): void {
  if (runner.kind !== 'docker') return
  const steam = join(runner.home, '.local', 'share', 'Steam')
  if (existsSync(join(steam, 'steamcmd'))) return

  mkdirSync(steam, { recursive: true })
  const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`
  const copy = `cp -a '${IMAGE_STEAM}/.' '${steam}/' && chown -R ${owner} '${runner.home}'`
  const r = spawnSync('docker', [
    'run', '--rm', '-v', `${runner.home}:${runner.home}`,
    '--entrypoint', 'sh', STEAMCMD_IMAGE, '-c', copy,
  ], { encoding: 'utf8' })
  if (r.status !== 0) {
    warn(`could not reuse the image's steamcmd, so it will update itself: ${r.stderr ?? r.error?.message ?? ''}`)
  }
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
  // About.xml names the steam client form 251 times against 72 web ones in a real 367-mod library
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

const ANSI = new RegExp(String.raw`${String.fromCodePoint(27)}\[[0-9;?]*[ -/]*[@-~]`, 'g')
const SUCCESS = /Success\. Downloaded item (\d+) to "([^"]+)" \((\d+) bytes\)/g
const FAILED = /ERROR! Download item (\d+) failed \(([^)]+)\)/g
const STARTING = /Downloading item (\d+)/g
const ATTEMPTS = 2
const RETRY_DELAY_MS = 1000
const WATCH_BUFFER = 8 * 1024

/** One row per workshop item, reported as steamcmd works through the batch. */
export interface DownloadHooks {
  onPlan(tasks: readonly { id: string; label: string }[]): void
  onCell(id: string, patch: { state: TaskState; detail?: string }): void
}

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
  hooks?: DownloadHooks,
): Promise<DownloadReport> {
  const items = new Map<string, DownloadOutcome>()
  const warnings: string[] = []
  if (ids.length === 0) return { items, warnings }

  const runner = resolveSteamcmd(config)
  const streamed = new Set<string>()
  // docker creates a missing bind source as root, and then the --user process cannot write its own HOME
  mkdirSync(steamHome(dataRoot), { recursive: true })
  const reasons = new Map<string, string>()
  // the whole steam HOME, not one content root: which of the two trees steamcmd writes is not
  // known until it has run, and a lock under a name that moves locks nothing
  const release = await lockDir(steamHome(dataRoot))
  try {
    let pending = ids
    for (let attempt = 0; attempt < ATTEMPTS && pending.length > 0; attempt++) {
      const output = await run(runner, game, dataRoot, pending, hooks, streamed)
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
    if (items.has(id)) {
      if (!streamed.has(id)) hooks?.onCell(id, { state: 'done' })
      continue
    }
    const reason = reasons.get(id) ?? 'steamcmd reported nothing for it'
    items.set(id, { ok: false, reason })
    warnings.push(`could not download workshop item ${id}: ${reason}`)
    if (!streamed.has(id)) hooks?.onCell(id, { state: 'failed', detail: reason })
  }
  return { items, warnings }
}

async function run(
  runner: SteamcmdRunner,
  game: GameConfig,
  dataRoot: string,
  ids: string[],
  hooks: DownloadHooks | undefined,
  streamed: Set<string>,
): Promise<string> {
  const argv = [
    ...runner.argv,
    // before +login, or steamcmd applies it to nothing
    '+force_install_dir', steamHome(dataRoot),
    '+login', 'anonymous',
    ...ids.flatMap((id) => ['+workshop_download_item', String(game.steamAppId), id]),
    '+quit',
  ]
  if (hooks === undefined) return spawnSteamcmd(argv, runner)
  return await spawnSteamcmdLive(argv, runner, watchItems(hooks, streamed))
}

function watchItems(hooks: DownloadHooks, streamed: Set<string>): (text: string) => void {
  let unterminated = ''
  const settled = new Set<string>()
  return (text) => {
    unterminated = (unterminated + text).replace(ANSI, '').slice(-WATCH_BUFFER)
    for (const m of unterminated.matchAll(STARTING)) {
      if (!settled.has(m[1]!)) hooks.onCell(m[1]!, { state: 'running' })
    }
    for (const m of unterminated.matchAll(SUCCESS)) {
      if (settled.has(m[1]!)) continue
      settled.add(m[1]!)
      streamed.add(m[1]!)
      hooks.onCell(m[1]!, { state: 'done' })
    }
    for (const m of unterminated.matchAll(FAILED)) {
      if (settled.has(m[1]!)) continue
      settled.add(m[1]!)
      streamed.add(m[1]!)
      hooks.onCell(m[1]!, { state: 'failed', detail: m[2]! })
    }
  }
}

/**
 * spawnSteamcmd, but the caller watches it work. A game download runs for twenty minutes and
 * steamcmd prints a percentage the whole time, which a captured spawn swallows until it exits.
 */
async function spawnSteamcmdLive(
  argv: string[],
  runner: SteamcmdRunner,
  onChunk?: (text: string) => void,
): Promise<string> {
  prewarm(runner)
  let text: string
  try {
    ({ text } = await captureLive(argv, { ...process.env, ...runner.env }, onChunk))
  } catch (error) {
    throw new GamecrateError(
      `could not run steamcmd: ${argv[0]}`,
      Exit.Environment,
      error instanceof Error ? error.message : String(error),
    )
  }
  return text.replace(ANSI, '')
}

/** argv already carries runner.argv; the runner is here for its env. */
function spawnSteamcmd(argv: string[], runner: SteamcmdRunner): string {
  prewarm(runner)
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

/**
 * Per branch and per depot, not per variant: `linux` and `linux-ref` come out of one +app_update.
 * A shared directory means the second +app_update rewrites the first one's files.
 */
export function appDownloadRoot(dataRoot: string, appId: number, branch: string, depot?: string): string {
  return join(steamHome(dataRoot), 'apps', `${appId}-${branch}-${depot ?? 'native'}`)
}

export interface AppDownload {
  dir: string
  warnings: string[]
}

// a fresh download ends "fully installed", a current one "already up to date". measured
// 2026-09-24 against app 1007: pinning the first message called the second a missing branch.
// both are keyed to the requested app, because steamcmd reports the redistributables too
const appOk = (id: number) => new RegExp(`Success! App '${id}'`)
const appState = (id: number) => new RegExp(`Error! App '${id}' state is (0x[0-9a-fA-F]+)`)
// steam's own strings. a stale session is the likeliest first-run failure, and it looks nothing
// like a bad branch, so it is checked before the branch message
const LOGIN_FAILED = /Login Failure|FAILED \(Invalid Password\)|Account Logon Denied|Two-factor/i
const STEAM_UNREACHABLE = /Info request for AppId \d+ returned error Timeout|Failed to load platform info/i
const BOOTSTRAP_FAILED = /Steamcmd needs to be online to update/i

function steamUnreachable(appId: number): GamecrateError {
  return new GamecrateError(
    `steam did not answer for app ${appId}`,
    Exit.Unavailable,
    'steam was slow or down, so nothing local is wrong. retry in a few minutes',
  )
}

const BOOTSTRAP_LOGS = [
  join('Steam', 'logs', 'bootstrap_log.txt'),
  join('.steam', 'logs', 'bootstrap_log.txt'),
  join('.local', 'share', 'Steam', 'logs', 'bootstrap_log.txt'),
]

function bootstrapFailed(home: string): GamecrateError {
  return new GamecrateError(
    'steamcmd could not install its own update',
    Exit.Unavailable,
    'it self-updates on first run and that download did not finish, so the branch and the '
    + `password were never reached. retry in a few minutes. its own log says: ${bootstrapLog(home)}`,
  )
}

function bootstrapLog(home: string): string {
  for (const name of BOOTSTRAP_LOGS) {
    const path = join(home, name)
    if (existsSync(path)) return lastLines(readFileSync(path, 'utf8'), 6)
  }
  return `nothing, no bootstrap log under ${home}`
}

/** True when steam never answered, which is nobody's local problem and worth retrying. */
export function isSteamUnavailable(error: unknown): boolean {
  return error instanceof GamecrateError && error.code === Exit.Unavailable
}

/**
 * A wrong -betapassword, a missing branch and a steam that never answers all read the same from
 * outside, so the error separates them: only the last one is worth retrying.
 */
export async function downloadApp(config: RootConfig, opts: {
  steamAppId: number
  branch: string
  depot?: 'linux' | 'windows' | 'macos'
  password?: string
  dataRoot: string
}): Promise<AppDownload> {
  const user = steamAccount(opts.dataRoot)
  const runner = resolveSteamcmd(config)
  const dir = appDownloadRoot(opts.dataRoot, opts.steamAppId, opts.branch, opts.depot)
  // docker creates a missing bind source as root, and the --user process then cannot write it
  mkdirSync(dir, { recursive: true })
  const commands: string[][] = [
    ['@ShutdownOnFailedCommand', '1'],
    ['@NoPromptForPassword', '1'],
    // before login, or steamcmd applies them to nothing
    ['force_install_dir', dir],
    ...(opts.depot === undefined ? [] : [['@sSteamCmdForcePlatformType', opts.depot]]),
    ['login', user],
    [
      'app_update', String(opts.steamAppId),
      '-beta', opts.branch,
      ...(opts.password === undefined ? [] : ['-betapassword', opts.password]),
    ],
    ['quit'],
  ]

  // steamcmd has no stdin or env form for -betapassword, so the password path pays a 0600 file for
  // the download rather than a line in `ps`. same reason crane.ts keeps one out of a docker argv
  const script = opts.password === undefined ? undefined : writeRunscript(opts.dataRoot, commands)
  const argv = script === undefined
    ? [...runner.argv, ...commands.flatMap((c) => [`+${c[0] as string}`, ...c.slice(1)])]
    : [...runner.argv, '+runscript', script]

  const release = await lockDir(steamHome(opts.dataRoot))
  let output: string
  try {
    output = await spawnSteamcmdLive(argv, runner)
  } finally {
    // a failed download must not leave a password behind
    if (script !== undefined) rmSync(script, { force: true })
    await release()
  }

  if (appOk(opts.steamAppId).test(output)) return { dir, warnings: [] }
  if (BOOTSTRAP_FAILED.test(output)) throw bootstrapFailed(steamHome(opts.dataRoot))
  if (LOGIN_FAILED.test(output)) {
    throw new GamecrateError(
      `the steam login failed for ${user}`,
      Exit.Environment,
      'run `gamecrate steam login` to sign in again, including any steam guard code',
    )
  }
  if (STEAM_UNREACHABLE.test(output)) throw steamUnreachable(opts.steamAppId)
  const state = appState(opts.steamAppId).exec(output)
  throw new GamecrateError(
    `steamcmd did not install app ${opts.steamAppId} on branch "${opts.branch}"`,
    Exit.Environment,
    state === null
      ? 'the branch may not exist, or the password may be wrong. steam reports both the same way'
      : `steam left the app in state ${state[1]}. the branch may not exist, or the password may be wrong`,
  )
}

/**
 * The same commands as a file for `+runscript`, created 0600 rather than chmod'd after, so it is
 * never world-readable for a moment. A value with a space is quoted; steamcmd reads both forms.
 */
function writeRunscript(dataRoot: string, commands: string[][]): string {
  // beside steamHome because the docker runner binds that path and nothing else, so os.tmpdir()
  // would not exist inside the container
  const home = steamHome(dataRoot)
  mkdirSync(home, { recursive: true })
  const path = join(home, `runscript-${randomBytes(9).toString('hex')}.txt`)
  const body = commands.map((c) => c.map(quoteIfSpaced).join(' ')).join('\n')
  writeFileSync(path, `${body}\n`, { mode: 0o600, flag: 'wx' })
  return path
}

/** A runscript line splits on whitespace, so only a value holding one needs the quotes. */
function quoteIfSpaced(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

/** null when steam reports no buildid for that branch. A missing account or a silent steam throws. */
export async function publishedBuildId(
  config: RootConfig,
  appId: number,
  branch: string,
): Promise<string | null> {
  const user = steamAccount(config.dataRoot)
  // docker creates a missing bind source as root, and the --user process then cannot write it
  mkdirSync(steamHome(config.dataRoot), { recursive: true })
  const release = await lockDir(steamHome(config.dataRoot))
  let output: string
  try {
    const runner = resolveSteamcmd(config)
    output = spawnSteamcmd([
      ...runner.argv,
      '+@ShutdownOnFailedCommand', '1',
      '+@NoPromptForPassword', '1',
      '+login', user,
      '+app_info_update', '1',
      '+app_info_print', String(appId),
      '+quit',
    ], runner)
  } finally {
    await release()
  }
  if (BOOTSTRAP_FAILED.test(output)) throw bootstrapFailed(steamHome(config.dataRoot))
  if (STEAM_UNREACHABLE.test(output)) throw steamUnreachable(appId)
  const found = buildIdFor(output, branch)
  if (found === null) warn(`steam named no buildid for "${branch}". steamcmd said: ${lastLines(output, 4)}`)
  return found
}

/** The tail of a captured run, joined onto one line so a log keeps it together. */
function lastLines(output: string, count: number): string {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.slice(-count).join(' | ')
}

/**
 * The buildid sits at depots -> branches -> <branch> -> buildid, and the branch name shows up
 * elsewhere too, so anchor on "branches", then the branch key, then its first "buildid".
 */
export function buildIdFor(output: string, branch: string): string | null {
  const key = `"${branch}"`
  let inBranches = false
  let inBranch = false
  for (const line of output.split('\n')) {
    if (line.includes('"branches"')) inBranches = true
    if (inBranches && line.includes(key)) inBranch = true
    if (inBranch && line.includes('"buildid"')) {
      const digits = (line.split('"').at(-2) ?? '').replaceAll(/\D/g, '')
      return digits === '' ? null : digits
    }
  }
  return null
}
