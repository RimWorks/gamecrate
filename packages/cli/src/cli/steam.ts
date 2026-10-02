import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { namedGame } from './game'
import { steamBuild } from '../image/build'
import { resolveSteamBuildInput } from '../image/input'
import { accountFile, resolveSteamcmd, steamAccount, steamHome } from '../mods/steamcmd'
import type { GamePlugin } from '../plugin'
import { Exit, GamecrateError } from '../types'
import type { ParsedArgs, RootConfig } from '../types'
import { status } from './output'
import { emit } from '../channels'
import { startBoard } from './taskboard'
import type { Board } from './taskboard'
import { dashboardGate } from './tty'

export interface SteamContext {
  config: RootConfig
  plugins: Map<string, GamePlugin>
  /** Where a bare plugin specifier resolves from. Injectable so tests need no chdir. */
  cwd: string
  /** The file loadConfig read, so config.plugins resolves here the way it does there. */
  configFile?: string
}

/**
 * Every layout a steamcmd writes config.vdf into, measured 2026-09-23: the arch wrapper writes
 * .steam/config, the docker image writes .local/share/Steam/config, a valve tarball writes Steam/config.
 */
export function sessionPaths(home: string): string[] {
  return [
    join(home, '.steam', 'config', 'config.vdf'),
    join(home, '.local', 'share', 'Steam', 'config', 'config.vdf'),
    join(home, 'Steam', 'config', 'config.vdf'),
  ]
}

export function findSession(home: string): string | undefined {
  return sessionPaths(home).find((path) => existsSync(path))
}

function seedSession(home: string, body: Buffer): void {
  for (const path of sessionPaths(home)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
}

const BASE64_BODY = /^[A-Za-z0-9+/\s]+={0,2}\s*$/

function looksLikeSession(value: string): boolean {
  return value.length > 100 && BASE64_BODY.test(value)
}

function decodeSession(body: Buffer): Buffer {
  const text = body.toString('utf8')
  return BASE64_BODY.test(text) ? Buffer.from(text, 'base64') : body
}

/**
 * STEAM_CONFIG_VDF_B64, then the file STEAM_CONFIG_VDF names, holding base64 or a raw config.vdf,
 * then the file `steam login` wrote, then a session in the user's own home. Expired reads as missing.
 */
export function resolveSession(config: RootConfig, env: Record<string, string | undefined> = process.env): string {
  const home = steamHome(config.dataRoot)
  const inline = env['STEAM_CONFIG_VDF_B64']
  if (inline !== undefined && inline !== '') {
    seedSession(home, Buffer.from(inline, 'base64'))
    return sessionPaths(home)[0] as string
  }
  const named = env['STEAM_CONFIG_VDF']
  if (named !== undefined && named !== '') {
    if (!existsSync(named)) {
      throw new GamecrateError(
        'steam session file not found',
        Exit.Environment,
        looksLikeSession(named)
          ? 'STEAM_CONFIG_VDF names a file now. pass a base64 session as STEAM_CONFIG_VDF_B64 instead'
          : `STEAM_CONFIG_VDF names ${named}, which does not exist. point it at a file, or pass the session inline as STEAM_CONFIG_VDF_B64`,
      )
    }
    seedSession(home, decodeSession(readFileSync(named)))
    return sessionPaths(home)[0] as string
  }
  const mine = findSession(home)
  if (mine !== undefined) return mine
  const fallback = findSession(homedir())
  if (fallback !== undefined) {
    seedSession(home, readFileSync(fallback))
    return fallback
  }
  throw new GamecrateError(
    'no steam session found',
    Exit.Environment,
    `run gamecrate steam login, or set STEAM_CONFIG_VDF_B64 or STEAM_CONFIG_VDF. looked under ${home} and ${homedir()}`,
  )
}

export async function steamBuildCommand(args: ParsedArgs, ctx: SteamContext): Promise<number> {
  const game = namedGame(args, ctx.config)

  status(`steam session from ${resolveSession(ctx.config)}`)
  steamAccount(ctx.config.dataRoot)

  const push = args.push === true
  const load = args.load !== false
  const plugins = args.plugin !== undefined && args.plugin.length > 0 ? args.plugin : undefined
  const input = await resolveSteamBuildInput(
    game,
    ctx.config,
    { image: args.image, plugins, push },
    ctx.cwd,
    ctx.configFile,
  )

  const drawable = !args.json && !args.plain && dashboardGate()
  let board: Board | undefined

  const results = await steamBuild(input, {
    config: ctx.config,
    push,
    load,
    platform: args.platform ?? 'linux/amd64',
    baseOverride: args.base,
    force: args.force === true,
    onlyBranches: args.branches,
    extraTags: args.aliases,
    onlyVariants: args.variant,
    ...(drawable
      ? {
          onPlan: (cells) => {
            board = startBoard({
              title: game,
              subtitle: `${new Set(cells.map((c) => c.branch)).size} branch, ${cells.length} cells`,
              tasks: cells.map((cell) => ({ id: cell.id, label: cell.variant, note: cell.base })),
            })
          },
          onCell: (id, patch) => board?.update(id, patch),
        }
      : {}),
  }).finally(() => board?.close())

  if (args.json) emit('data', `${JSON.stringify(results, null, 2)}\n`)
  else for (const row of results) status(`${row.branch}/${row.variant}  ${row.status}  ${row.reason}`)

  return results.some((row) => row.status === 'failed') ? Exit.Environment : Exit.Ok
}

/**
 * The one interactive path in gamecrate: steamcmd gets the TTY so it can ask for the password and
 * the 2FA code itself. Neither ever passes through an argv we build.
 */
export async function steamLogin(args: ParsedArgs, ctx: SteamContext): Promise<number> {
  const home = steamHome(ctx.config.dataRoot)
  mkdirSync(home, { recursive: true })
  const runner = resolveSteamcmd(ctx.config)
  const username = args.username ?? (await prompt('steam account name: '))
  if (username === '') throw new GamecrateError('steam login needs an account name', Exit.Usage)

  const argv = runner.kind === 'docker' ? [...runner.argv.slice(0, 2), '-it', ...runner.argv.slice(2)] : [...runner.argv]
  const result = spawnSync(argv[0] as string, [...argv.slice(1), '+login', username, '+quit'], {
    stdio: 'inherit',
    env: { ...process.env, ...runner.env },
  })
  if (result.error) {
    throw new GamecrateError(`could not run steamcmd: ${argv[0]}`, Exit.Environment, result.error.message)
  }

  const vdf = findSession(home)
  if (result.status !== 0 || vdf === undefined) {
    throw new GamecrateError(
      'steam login did not leave a session behind',
      Exit.Environment,
      `steamcmd exited ${result.status ?? 'on a signal'} and wrote no config.vdf under ${home}`,
    )
  }
  writeFileSync(accountFile(ctx.config.dataRoot), `${username}\n`)
  status(`session written to ${vdf}`)
  if (args.print === true) emit('data', `${readFileSync(vdf).toString('base64')}\n`)
  return Exit.Ok
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}
