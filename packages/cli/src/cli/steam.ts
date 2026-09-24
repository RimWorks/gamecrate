import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { steamBuild } from '../image/build'
import { resolveSteamBuildInput } from '../image/input'
import { accountFile, resolveSteamcmd, steamAccount, steamHome } from '../mods/steamcmd'
import type { GamePlugin } from '../plugin'
import { Exit, GamecrateError } from '../types'
import type { ParsedArgs, RootConfig } from '../types'
import { status } from './output'

export interface SteamContext {
  config: RootConfig
  plugins: Map<string, GamePlugin>
  /** Where a bare plugin specifier resolves from. Injectable so tests need no chdir. */
  cwd: string
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

/** which layout steamcmd reads depends on which steamcmd runs, so seed all of them */
function seedSession(home: string, body: Buffer): void {
  for (const path of sessionPaths(home)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
}

/**
 * STEAM_CONFIG_VDF, then the file `steam login` wrote, then a hand-primed session in the user's
 * own home. An expired session reports as a missing one: from out here the two files look identical.
 */
export function resolveSession(config: RootConfig, env: Record<string, string | undefined> = process.env): string {
  const home = steamHome(config.dataRoot)
  const raw = env['STEAM_CONFIG_VDF']
  if (raw !== undefined && raw !== '') {
    seedSession(home, Buffer.from(raw, 'base64'))
    return sessionPaths(home)[0] as string
  }
  const mine = findSession(home)
  if (mine !== undefined) return mine
  const fallback = findSession(homedir())
  if (fallback !== undefined) {
    // steamcmd runs with HOME=steamHome, and the docker runner mounts only that
    seedSession(home, readFileSync(fallback))
    return fallback
  }
  throw new GamecrateError(
    'no steam session found',
    Exit.Environment,
    `run gamecrate steam login, or set STEAM_CONFIG_VDF. looked under ${home} and ${homedir()}`,
  )
}

export async function steamBuildCommand(args: ParsedArgs, ctx: SteamContext): Promise<number> {
  const game = args.game
  if (game === undefined) throw new GamecrateError('steam build needs a game', Exit.Usage)

  // both up front: steamcmd's own words for a missing session or account are far worse than these,
  // and by the time it says them a multi-gigabyte download has already started
  status(`steam session from ${resolveSession(ctx.config)}`)
  steamAccount(ctx.config.dataRoot)

  const push = args.push === true
  const load = args.load === true || !push
  // no --plugin has to read as unset, or the @gamecrate/<game> convention never gets a turn
  const plugins = args.plugin !== undefined && args.plugin.length > 0 ? args.plugin : undefined
  const input = await resolveSteamBuildInput(game, ctx.config, { image: args.image, plugins, push }, ctx.cwd)

  const results = await steamBuild(input, {
    config: ctx.config,
    push,
    load,
    platform: args.platform ?? 'linux/amd64',
    baseOverride: args.base,
    force: args.force === true,
    onlyBranches: args.branches,
    onlyVariants: args.variant,
  })

  // the table goes to stderr through status, because stdout belongs to machine-readable output
  if (args.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  else for (const row of results) status(`${row.branch}/${row.variant}  ${row.status}  ${row.reason}`)

  return results.some((row) => row.status === 'failed') ? Exit.Environment : Exit.Ok
}

/**
 * The one interactive path in gamecrate: steamcmd gets the TTY so it can ask for the password and
 * the 2FA code itself. Neither ever passes through an argv we build.
 */
export async function steamLogin(args: ParsedArgs, ctx: SteamContext): Promise<number> {
  const home = steamHome(ctx.config.dataRoot)
  // docker creates a missing bind source as root, and then the --user process cannot write its own HOME
  mkdirSync(home, { recursive: true })
  const runner = resolveSteamcmd(ctx.config)
  const username = args.username ?? (await prompt('steam account name: '))
  if (username === '') throw new GamecrateError('steam login needs an account name', Exit.Usage)

  // resolveSteamcmd builds the docker argv for a batch download, which needs no tty
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
  // beside the session, so a later build never asks for STEAM_USERNAME again
  writeFileSync(accountFile(ctx.config.dataRoot), `${username}\n`)
  status(`session written to ${vdf}`)
  if (args.print === true) process.stdout.write(`${readFileSync(vdf).toString('base64')}\n`)
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
