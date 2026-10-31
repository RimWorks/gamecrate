import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { expandHome } from '../config/load'
import { executable, onPath } from '../executable'
import { captureLive } from '../docker/run'
import { Exit, GamecrateError } from '../types'
import type { RootConfig } from '../types'
import { lockDir } from './source'
import { appDownloadRoot, lastLines, steamAccount, steamHome, steamUnreachable } from './steamcmd'
import type { AppDownload } from './steamcmd'

const NO_LOGIN = /Enter account password for|Access token was rejected/
const LOGIN_FAILED = /Unable to login to Steam3: (\S+)/
const STEAM_DOWN = /^(ServiceUnavailable|TryAnotherCM|Timeout)$/
const BRANCH_FAILED = /Password was invalid for branch|was not found, either it does not exist or it has a password/
const NOT_OWNED = /is not available from this account/
const TOKEN_VAR = 'DEPOTDOWNLOADER_ACCOUNT_B64'

/**
 * The game downloader, when one is installed. A configured path that is not an executable file is
 * an error; nothing installed hands the download back to steamcmd.
 */
export function resolveDepotDownloader(config: RootConfig): string | undefined {
  const configured = config.depotdownloader?.path
  if (configured === undefined) return onPath('depotdownloader')
  const path = expandHome(configured)
  if (executable(path)) return path
  throw new GamecrateError(
    `depotdownloader.path is not an executable file: ${path}`,
    Exit.Environment,
    'point depotdownloader.path at the depotdownloader binary, or remove it to use PATH or steamcmd',
  )
}

/** HOME and the data dir for depotdownloader, so its login token lives under dataRoot. */
export function depotDownloaderEnv(dataRoot: string): Record<string, string> {
  const home = steamHome(dataRoot)
  return { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') }
}

function storeDir(dataRoot: string): string | undefined {
  const root = join(depotDownloaderEnv(dataRoot).XDG_DATA_HOME as string, 'IsolatedStorage')
  if (!existsSync(root)) return undefined
  const found = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .find((entry) => basename(entry) === 'AssemFiles')
  return found === undefined ? undefined : join(root, found)
}

/** The token `-remember-password` saved, wherever .NET's isolated storage put it, or undefined. */
export function findDepotDownloaderToken(dataRoot: string): string | undefined {
  const dir = storeDir(dataRoot)
  if (dir === undefined) return undefined
  const path = join(dir, 'account.config')
  return existsSync(path) ? path : undefined
}

/**
 * DEPOTDOWNLOADER_ACCOUNT_B64 onto disk, for a runner with no login of its own. depotdownloader
 * creates its store on any run, so a version check says where the file goes.
 */
export function seedDepotDownloaderToken(
  config: RootConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const inline = env[TOKEN_VAR]
  if (inline === undefined || inline === '') return undefined
  const binary = resolveDepotDownloader(config)
  if (binary === undefined) {
    throw new GamecrateError(
      `${TOKEN_VAR} is set but depotdownloader is not installed`,
      Exit.Environment,
      'put depotdownloader on PATH or set depotdownloader.path, or unset it to download with steamcmd',
    )
  }
  const home = steamHome(config.dataRoot)
  mkdirSync(home, { recursive: true })
  const probe = spawnSync(binary, ['-V'], {
    encoding: 'utf8',
    env: { ...process.env, ...depotDownloaderEnv(config.dataRoot) },
  })
  const dir = probe.error === undefined && probe.status === 0 ? storeDir(config.dataRoot) : undefined
  if (dir === undefined) {
    throw new GamecrateError(
      `depotdownloader did not create its store under ${home}`,
      Exit.Environment,
      probe.error?.message ?? lastLines(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`, 4),
    )
  }
  const path = join(dir, 'account.config')
  rmSync(path, { force: true })
  writeFileSync(path, Buffer.from(inline, 'base64'), { mode: 0o600 })
  return path
}

/**
 * Depots only, so the account's workshop subscriptions never come along. The output maps onto the
 * failures `downloadApp` raises, so a build reads either the same way.
 */
export async function downloadAppWithDepotDownloader(binary: string, config: RootConfig, opts: {
  steamAppId: number
  branch: string
  depot?: 'linux' | 'windows' | 'macos'
  password?: string
  dataRoot: string
}): Promise<AppDownload> {
  const user = steamAccount(opts.dataRoot)
  const dir = appDownloadRoot(opts.dataRoot, opts.steamAppId, opts.branch, opts.depot)
  if (existsSync(join(dir, 'steamapps'))) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const argv = [
    binary,
    '-username', user,
    '-remember-password',
    '-app', String(opts.steamAppId),
    '-branch', opts.branch,
    ...(opts.password === undefined ? [] : ['-branchpassword', opts.password]),
    ...(opts.depot === undefined ? [] : ['-os', opts.depot, '-osarch', '64']),
    '-dir', dir,
  ]

  const release = await lockDir(steamHome(opts.dataRoot))
  let text: string
  let code: number
  try {
    ;({ text, code } = await captureLive(argv, { ...process.env, ...depotDownloaderEnv(opts.dataRoot) }))
  } catch (error) {
    throw new GamecrateError(
      `could not run depotdownloader: ${binary}`,
      Exit.Environment,
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    await release()
  }

  if (code === 0) return { dir, warnings: [] }
  if (NO_LOGIN.test(text)) throw needsLogin(user, 'it has no stored login for that account')
  const login = LOGIN_FAILED.exec(text)
  if (login !== null) {
    if (STEAM_DOWN.test(login[1] as string)) throw steamUnreachable(opts.steamAppId)
    throw needsLogin(user, `steam said ${login[1]}`)
  }
  if (BRANCH_FAILED.test(text)) {
    throw new GamecrateError(
      `depotdownloader did not find branch "${opts.branch}" for app ${opts.steamAppId}`,
      Exit.Environment,
      'the branch may not exist, or the password may be wrong',
    )
  }
  if (NOT_OWNED.test(text)) {
    throw new GamecrateError(
      `app ${opts.steamAppId} is not available to ${user}`,
      Exit.Environment,
      'the account that logged in does not own it',
    )
  }
  throw new GamecrateError(
    `depotdownloader exited ${code} for app ${opts.steamAppId} on branch "${opts.branch}"`,
    Exit.Environment,
    lastLines(text, 4),
  )
}

function needsLogin(user: string, why: string): GamecrateError {
  return new GamecrateError(
    `depotdownloader could not log in as ${user}`,
    Exit.Environment,
    `${why}. run \`gamecrate steam login\` to sign in again, including the steam guard tap`,
  )
}
