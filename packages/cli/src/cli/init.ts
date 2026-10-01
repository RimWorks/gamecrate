import { spawnSync } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { extname, join } from 'node:path'

import { findGlobalConfig, globalConfigDir } from '../config/load'
import { emit } from '../channels'
import { status, warn } from './output'
import { Exit, GamecrateError } from '../types'
import type { ParsedArgs } from '../types'

const REGISTRY = 'https://registry.npmjs.org/-/v1/search?text=%40gamecrate&size=50'
const SELF = '@gamecrate/cli'

export interface PluginChoice {
  /** The npm package, such as `@gamecrate/rimworld`. */
  name: string
  version: string
  /** The trailing segment, which is also the game name the plugin declares. */
  game: string
}

/** The `@gamecrate/*` packages the registry knows, minus the CLI itself. */
export function readPlugins(body: string): PluginChoice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const objects = (parsed as { objects?: { package?: { name?: string; version?: string } }[] }).objects ?? []
  const out: PluginChoice[] = []
  for (const entry of objects) {
    const name = entry.package?.name
    const version = entry.package?.version
    if (name === undefined || version === undefined) continue
    if (!name.startsWith('@gamecrate/') || name === SELF) continue
    out.push({ name, version, game: name.slice('@gamecrate/'.length) })
  }
  return out.sort((a, b) => a.game.localeCompare(b.game))
}

async function fetchPlugins(): Promise<PluginChoice[]> {
  try {
    const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return []
    return readPlugins(await response.text())
  } catch {
    return []
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

async function askDefault(question: string, fallback: string): Promise<string> {
  const answer = await ask(`${question} [${fallback}]: `)
  return answer === '' ? fallback : answer
}

async function askYes(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N]: `))
}

function interactive(): boolean {
  return process.stdin.isTTY === true
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function pickPlugin(args: ParsedArgs): Promise<PluginChoice> {
  const found = await fetchPlugins()
  if (args.game !== undefined) {
    const match = found.find((p) => p.game === args.game)
    return match ?? { name: `@gamecrate/${args.game}`, version: 'latest', game: args.game }
  }
  if (!interactive()) {
    throw new GamecrateError('init needs a game', Exit.Usage, 'pass --game <name>, or run it on a terminal')
  }
  if (found.length === 0) {
    warn('the npm registry did not answer, so there is no list to pick from')
    const typed = await ask('plugin package name (like @gamecrate/rimworld): ')
    if (typed === '') throw new GamecrateError('no plugin named', Exit.Usage)
    const game = typed.startsWith('@gamecrate/') ? typed.slice('@gamecrate/'.length) : typed
    return { name: typed, version: 'latest', game }
  }

  emit('status', 'games with a published plugin:\n')
  for (const [i, p] of found.entries()) emit('status', `  ${i + 1}) ${p.game}  (${p.name} ${p.version})\n`)
  const answer = await askDefault('pick one by number or name', found[0]!.game)
  const byIndex = found[Number(answer) - 1]
  return byIndex ?? found.find((p) => p.game === answer || p.name === answer) ?? found[0]!
}

function npm(argv: string[], cwd: string): void {
  const run = spawnSync('npm', argv, { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
  if (run.status !== 0) {
    throw new GamecrateError(
      `npm ${argv.join(' ')} failed in ${cwd}`,
      Exit.Environment,
      (run.stderr ?? '').trim().split('\n').slice(-3).join(' ') || 'no output',
    )
  }
}

function installPlugin(dir: string, plugin: PluginChoice): void {
  status(`installing ${plugin.name} globally`)
  npm(['install', '-g', plugin.name], dir)
}

export interface InitAnswers {
  game: string
  plugin: string
  host: string
  profile: string
}

export function renderGlobalConfig(a: InitAnswers): string {
  return `plugins: ['${a.plugin}']
games:
  ${a.game}:
    gameFiles:
      host: ${a.host}
    profiles:
      ${a.profile}:
        mods: []
`
}

export function renderProjectConfig(a: InitAnswers): string {
  return `game: ${a.game}
defaultProfile: ${a.profile}
profiles:
  ${a.profile}:
    mods: []
`
}

export async function initCommand(args: ParsedArgs): Promise<number> {
  const dir = globalConfigDir()
  const existing = await findGlobalConfig()
  if (existing !== undefined && args.yes !== true) {
    if (!interactive()) {
      throw new GamecrateError(`${existing} already exists`, Exit.Config, 'pass --yes to overwrite it')
    }
    if (!(await askYes(`${existing} already exists. overwrite it?`))) {
      status('left the config alone')
      return Exit.Ok
    }
  }

  const plugin = await pickPlugin(args)
  const answers: InitAnswers = {
    game: plugin.game,
    plugin: plugin.name,
    host: '',
    profile: 'dev',
  }

  if (interactive()) {
    answers.host = await askDefault(`where is ${plugin.game} installed on this host?`, join(process.env['HOME'] ?? '~', 'games', plugin.game))
    answers.profile = await askDefault('name your first profile', 'dev')
  } else {
    answers.host = join(process.env['HOME'] ?? '~', 'games', plugin.game)
  }

  await mkdir(dir, { recursive: true })
  installPlugin(dir, plugin)

  if (existing !== undefined && extname(existing) !== '.yml') {
    throw new GamecrateError(
      `${existing} is not YAML, and init only writes YAML`,
      Exit.Config,
      `delete or rename it first, then run init again`,
    )
  }
  const target = existing ?? join(dir, 'config.yml')
  await writeFile(target, renderGlobalConfig(answers))
  status(`wrote ${target}`)

  const wantsProject = args.target === 'project' || (interactive() && (await askYes('is this directory a mod repo?')))
  if (wantsProject) {
    const projectFile = join(process.cwd(), '.gamecrate.yml')
    if (await exists(projectFile)) warn(`${projectFile} already exists, leaving it alone`)
    else {
      await writeFile(projectFile, renderProjectConfig(answers))
      status(`wrote ${projectFile}`)
    }
  }

  emit('data', `\nnext: edit ${target} to point at your real game directory,\nthen run gamecrate doctor\n`)
  return Exit.Ok
}
