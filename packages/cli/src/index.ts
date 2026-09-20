#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { chown, cp, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { buildPolicy, parseArgs, supervisedDir, wantsDetach, wantsReplace } from './cli/args'
import { requireGame } from './cli/game'
import { list } from './cli/list'
import { globalConfigPath, modsAdd, modsRm, modsSync } from './cli/mods'
import { profileOf } from './cli/profile'
import { renderCompletion, renderHelp } from './cli/help'
import { currentLog, openRunLog, planWarnings, printPlan, redirectOutput, reportProblems, status, tailArgv, warn } from './cli/output'
import {
  findGlobalConfig,
  globalConfigDir,
  loadConfig,
  loadProjectDefaults,
  profileDataDir,
  profileDirs,
  resolveProfile,
} from './config/load'
import { resolveIdentity } from './docker/identity'
import { preflight } from './docker/preflight'
import { capture, exited, spawnArgv, runContainer, stopContainer, STDOUT_LOG, STOP_TIMEOUT_SECONDS, waitForMarker } from './docker/run'
import { buildRunSpec, containerName, windowTitle } from './docker/spec'
import { adoptNewWindow } from './docker/window'
import { generateModsConfig, mergePrefs } from './launch/generate'
import {
  acquireImage,
  buildLocalMods,
  captureScreenshot,
  ensureRuntimeLayer,
  heldLock,
  isRunning,
  readLock,
  replacePrevious,
  stopRun,
  takeLock,
  writeLaunchRecord,
} from './launch/prepare'
import { awaitExit, awaitRunLog, forkSupervisor, recordExit, supervisorFailed } from './launch/supervisor'
import { resolveInstance } from './launch/instance'
import { resolvePlan, workshopRootProblem } from './launch/resolve'
import { listRuns } from './run/registry'
import { detectForeignOwnership, ensureProfileTree, stageMods } from './launch/stage'
import { buildIndex } from './mods/modindex'
import { cachedSources, prepareSources, sourcesRoot } from './mods/source'
import type { PreparedSources } from './mods/source'
import { requirePlugin } from './plugin'
import type { GamePlugin } from './plugin'
import { ago, decideStale, duration, scanBuildTimes, staleReport } from './mods/staleness'
import { resolveWorktree } from './mods/worktree'
import { GamecrateError, Exit, reasonFor } from './types'
import type {
  DockerRunSpec,
  Identity,
  LaunchPlan,
  LaunchResult,
  ParsedArgs,
  Problem,
  ProfileConfig,
  ProjectDefaults,
  RootConfig,
  StaleReport,
} from './types'

// Stamped by `bun build --define` from package.json, which semantic-release sets at publish time.
declare const __VERSION__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'

async function main(argv: string[]): Promise<number> {
  // read off argv, so the recovery below sits above parseArgs and loadConfig too.
  const supervised = supervisedDir(argv)
  try {
    return await command(argv, supervised)
  } catch (error) {
    if (supervised === undefined) throw error
    return await supervisorFailed(supervised, reportFatal(error))
  }
}

async function command(argv: string[], supervised: string | undefined): Promise<number> {
  const probe = parseArgs(argv)
  if (probe.subcommand === 'version') {
    process.stdout.write(`gamecrate ${VERSION}\n`)
    return Exit.Ok
  }

  // no longer parallel: the splice needs the project fragment before the global config validates.
  const defaults = await loadProjectDefaults()
  const { config, plugins } = await loadConfig(undefined, defaults)
  const args = parseArgs(argv, { games: Object.keys(config.games), defaults })

  if (args.help) {
    process.stdout.write(renderHelp(helpTopic(args), config))
    return Exit.Ok
  }
  const redirect =
    args.log !== undefined && (args.subcommand === 'run' || args.subcommand === 'shell')
      ? redirectOutput(args.log, args.supervised)
      : undefined

  try {
    return await dispatch(argv, args, config, plugins, defaults)
  } catch (error) {
    // Printed here, not at the top level: with --log the failure belongs in the log file,
    // and the top-level printer only runs once the redirect is already closed.
    const code = reportFatal(error)
    return supervised === undefined ? code : await supervisorFailed(supervised, code)
  } finally {
    redirect?.close()
  }
}

async function dispatch(
  argv: string[],
  args: ParsedArgs,
  config: RootConfig,
  plugins: Map<string, GamePlugin>,
  defaults: ProjectDefaults,
): Promise<number> {
  switch (args.subcommand) {
    case 'help':
      return help(args, config)
    case 'list':
      return list(args, config, defaults)
    case 'mods': {
      const ctx = { config, plugins, defaults, cwd: process.cwd(), globalPath: await globalConfigPath() }
      if (args.subverb === 'add') return modsAdd(args, ctx)
      if (args.subverb === 'rm') return modsRm(args, ctx)
      if (args.subverb === 'sync') return modsSync(args, ctx)
      return mods(args, config, plugins, defaults)
    }
    case 'doctor':
      return doctor(config, plugins)
    case 'clean':
      return clean(args, config, defaults)
    case 'clone':
      return clone(args, config)
    case 'logs':
      return logs(args, config, defaults)
    case 'verify':
      return verify(args, config, plugins, defaults)
    case 'build':
      return build(args, config)
    case 'ps':
      return ps(args, config)
    case 'stop':
      return stop(args, config, defaults)
    case 'attach':
      return attach(args, config, defaults)
    case 'wait':
      return waitFor(args, config, defaults)
    case 'shell':
      return run(argv, args, config, plugins, defaults, true)
    case 'config':
      return configEdit(args)
    case 'fix-perms':
      return fixPerms(args, config)
    case 'run':
      return run(argv, args, config, plugins, defaults, false)
    default:
      throw new GamecrateError(`no such subcommand ${args.subcommand}`, Exit.Usage)
  }
}

function helpTopic(args: ParsedArgs): string | undefined {
  if (args.subcommand === 'help') return args.rest[0]
  if (args.subcommand === 'run') return args.game
  return args.subcommand
}

function help(args: ParsedArgs, config: RootConfig): number {
  const topic = args.rest[0]
  if (topic === 'completion') {
    const shell = args.rest[1]
    if (shell !== 'bash' && shell !== 'zsh') {
      throw new GamecrateError('help completion takes bash or zsh', Exit.Usage)
    }
    process.stdout.write(renderCompletion(shell))
    return Exit.Ok
  }
  process.stdout.write(renderHelp(topic, config))
  return Exit.Ok
}

/**
 * Where a subcommand should look when `--instance` or `--worktree` names one. Resolving the
 * profile can throw on a name that was never defined, which is not this helper's business.
 */
function instanceDir(args: ParsedArgs, config: RootConfig, game: string, profile: string): string {
  const dir = profileDataDir(config, game, profile)
  let spec: ProfileConfig | undefined
  try {
    spec = resolveProfile(config.games[game]!, profile)
  } catch {
    spec = undefined
  }
  return resolveInstance({ profileDir: dir, ...(spec === undefined ? {} : { profile: spec }), args }).dir
}

/** Environment problems are exit 5, never 4: they are about this machine, not the config. */
function reportEnvironment(problems: Problem[]): never {
  const out: string[] = []
  for (const problem of problems) {
    out.push(`  ${problem.where}\n    ${problem.message}`)
    if (problem.suggestion) out.push(`      try: ${problem.suggestion}`)
  }
  throw new GamecrateError(
    `${problems.length} environment problem(s)`,
    Exit.Environment,
    out.join('\n'),
  )
}

/**
 * config -> index -> resolve -> stage -> generate -> run spec -> execute.
 * `--dry-run` and `--print-plan` stop after validation, before the first write.
 */
async function run(
  argv: string[],
  args: ParsedArgs,
  config: RootConfig,
  plugins: Map<string, GamePlugin>,
  defaults: ProjectDefaults,
  asShell: boolean,
): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)

  const gameConfig = config.games[game]!
  // --dry-run and --print-plan resolve without side effects, and a clone is a side effect.
  const allowFetch = !args.dryRun && !args.printPlan
  const sources = await prepareSources(gameConfig, profile, args, config.dataRoot, allowFetch)
  try {
    return await resolved(argv, args, config, plugins, asShell, game, profile, sources)
  } finally {
    await sources.release()
  }
}

async function resolved(
  argv: string[],
  args: ParsedArgs,
  config: RootConfig,
  plugins: Map<string, GamePlugin>,
  asShell: boolean,
  game: string,
  profile: string,
  sources: PreparedSources,
): Promise<number> {
  for (const warning of sources.warnings) warn(warning)
  const index = await buildIndex(
    game,
    config.games[game]!,
    requirePlugin(plugins, game),
    sourcesRoot(config.dataRoot),
  )
  const { plan, problems } = await resolvePlan({ game, profile, root: config, plugins, args, index, sources: sources.dirs })
  if (problems.length > 0) reportProblems(problems)

  const identity = resolveIdentity(args.root)

  if (args.printPlan || args.dryRun) {
    const environment = await preflight(plan)
    // buildRunSpec is a validation gate of its own: the "=" landmine throws here.
    buildRunSpec(plan, [], identity)
    if (args.printPlan) printPlan(plan, args.json)
    for (const warning of planWarnings(plan)) warn(warning)
    if (environment.length > 0) reportEnvironment(environment)
    if (!args.printPlan) {
      const what = plan.instance === undefined ? profile : `${profile}/${plan.instance}`
      status(`${game} ${what}: ${plan.mods.length} mods resolve cleanly`)
    }
    return Exit.Ok
  }

  const environment = await preflight(plan)
  if (environment.length > 0) reportEnvironment(environment)

  await ensureProfileTree(plan)
  const profileSpec = resolveProfile(config.games[game]!, profile)
  if (wantsReplace(args, profileSpec)) await replacePrevious(plan)
  // only a typed --detach refuses shell; a config-level one lands here and just skips the fork.
  if (!asShell && wantsDetach(args, profileSpec)) return await forkSupervisor(plan, argv)

  const lock = args.supervised ? heldLock(plan) : await takeLock(plan)
  try {
    const result = await launch(plan, args, config, identity, asShell, profileSpec, sources.release)
    if (args.supervised) await recordExit(plan, result)
    return result.code
  } finally {
    await lock.release()
  }
}

async function launch(
  plan: LaunchPlan,
  args: ParsedArgs,
  config: RootConfig,
  identity: Identity,
  asShell: boolean,
  profileSpec: ProfileConfig,
  releaseSources: () => Promise<void>,
): Promise<LaunchResult> {
  const game = plan.game
  const profile = plan.profile
  const foreign = await detectForeignOwnership(plan.dataDirHost, identity.uid, 5)
  if (foreign.length > 0) {
    throw new GamecrateError(
      `${foreign.length} path(s) under ${plan.dataDirHost} are not owned by uid ${identity.uid}`,
      Exit.Environment,
      `${foreign.join('\n')}\nrun: gamecrate fix-perms ${game} ${profile}`,
    )
  }

  const runDir = openRunLog(plan.logsDirHost)
  plan.runDirHost = runDir
  // the supervisor has no terminal. --log already redirected in main(), so never both.
  const supervisorLog =
    args.supervised && args.log === undefined ? redirectOutput(join(runDir, 'supervisor.log')) : undefined

  try {
    return await execute(plan, args, config, identity, asShell, profileSpec, runDir, releaseSources)
  } finally {
    supervisorLog?.close()
  }
}

async function execute(
  plan: LaunchPlan,
  args: ParsedArgs,
  config: RootConfig,
  identity: Identity,
  asShell: boolean,
  profileSpec: ProfileConfig,
  runDir: string,
  releaseSources: () => Promise<void>,
): Promise<LaunchResult> {
  const game = plan.game
  await buildLocalMods(plan, buildPolicy(args, profileSpec))
  // the build writes into the clones, so their lock only comes off once it is done. it covers
  // fetch and build, not the session: stageMods bind-mounts a clone subdir into the container,
  // and nothing stops another launch resetting that tree while the game holds it.
  // TODO(a session-long lock would serialize every launch): delete this when a clone is staged
  // by copy, or by a read-lock a resetting writer has to wait on.
  await releaseSources()
  await acquireImage(game, config.games[game]!, args.pull ?? 'missing')
  // Offscreen modes need an X server the published images do not ship; add it once, on top.
  const runtimeImage =
    plan.mode === 'headed'
      ? config.games[game]!.image.ref
      : await ensureRuntimeLayer(config.games[game]!.image.ref)

  const modMounts = await stageMods(plan)
  await generateModsConfig(plan)
  await mergePrefs(plan)
  for (const warning of planWarnings(plan)) warn(warning)

  const spec = buildRunSpec(plan, modMounts, identity)
  spec.image = runtimeImage
  if (asShell) {
    spec.command = ['/bin/bash']
    spec.extraArgs = [...spec.extraArgs, '--interactive', '--tty']
  }
  await writeLaunchRecord(plan, spec.image)

  try {
    // Every path below hands the container to runContainer, which owns SIGINT/SIGTERM: its
    // handler stops the container, returns 130, and still flushes the log.
    if (plan.marker !== undefined && !asShell) return await runWithMarker(spec, plan, runDir)
    if (plan.mode === 'screenshot' && !asShell) return await runWithScreenshot(spec, plan, runDir)
    // An offscreen run has nobody to close the window, so --timeout bounds it even with no
    // marker. Without this it runs forever and keeps the profile lock.
    if (plan.mode !== 'headed' && !asShell) return await runBounded(spec, plan, runDir)
    // Only X11 lets us touch the window from out here; a wayland client owns its own caption
    // and its own close button.
    let windowClosed = false
    const window =
      asShell || plan.settings.display !== 'x11'
        ? null
        : await adoptNewWindow({
            executable: plan.gameConfig.executable,
            title: windowTitle(plan),
            stripDelete: plan.gameConfig.ignoresWmDelete === true,
            onClosed: () => {
              windowClosed = true
              void stopContainer(spec.name, STOP_TIMEOUT_SECONDS)
            },
          })
    try {
      const code = await runContainer(spec, {
        logDir: runDir,
        stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
      })
      if (windowClosed) return { code: Exit.Ok, reason: 'window-closed' }
      return { code: normalize(code), reason: reasonFor(code) }
    } finally {
      window?.stop()
    }
  } finally {
    await copyOutLogs(plan)
  }
}

/**
 * Where a marker can appear. An engine may route its own log away from stdout, and a
 * copy-out dir is bind-mounted, so both are readable live.
 */
function markerSources(plan: LaunchPlan, logDir: string): string[] {
  const sources = [join(logDir, STDOUT_LOG)]
  const { logFile } = plan.gameConfig
  if (logFile.mode === 'arg') sources.push(join(logDir, 'Player.log'))
  else sources.push(join(plan.dataDirHost, logFile.from))
  return sources
}

/** Offscreen run with no marker: the deadline is the only thing that can end it. */
async function runBounded(
  spec: DockerRunSpec,
  plan: LaunchPlan,
  logDir: string,
): Promise<LaunchResult> {
  const container = runContainer(spec, { logDir, stopTimeoutSeconds: STOP_TIMEOUT_SECONDS })
  const winner = await Promise.race([
    container.then((code) => ({ kind: 'exit' as const, code })),
    sleep(plan.timeoutSeconds * 1000).then(() => ({ kind: 'timeout' as const })),
  ])
  if (winner.kind === 'exit') return { code: normalize(winner.code), reason: reasonFor(winner.code) }

  status(`no marker given; stopping after ${plan.timeoutSeconds}s`)
  await stopContainer(spec.name, STOP_TIMEOUT_SECONDS)
  await container
  return { code: Exit.Ok, reason: 'timeout' }
}

/** Waits for the game to render, grabs one frame, then stops the container. */
async function runWithScreenshot(
  spec: DockerRunSpec,
  plan: LaunchPlan,
  logDir: string,
): Promise<LaunchResult> {
  const container = runContainer(spec, { logDir, stopTimeoutSeconds: STOP_TIMEOUT_SECONDS })
  const settled = sleep(plan.renderWaitSeconds * 1000).then(() => 'ready' as const)

  const winner = await Promise.race([
    container.then((code) => ({ kind: 'exit' as const, code })),
    settled.then(() => ({ kind: 'ready' as const })),
  ])
  if (winner.kind === 'exit') {
    status(`game exited before the ${plan.renderWaitSeconds}s render wait finished; no frame captured`)
    return { code: normalize(winner.code), reason: reasonFor(winner.code) }
  }

  const shot = await grabFrame(spec.name, plan)
  await stopContainer(spec.name, STOP_TIMEOUT_SECONDS)
  await container
  // we stopped it right after the grab, so this is never a crash, even when the grab failed.
  return { code: shot === null ? Exit.Environment : Exit.Ok, reason: 'stopped' }
}

async function grabFrame(container: string, plan: LaunchPlan): Promise<string | null> {
  const path = await captureScreenshot(container, plan)
  if (path === null) warn('screenshot capture failed; is imagemagick in the image?')
  else status(`screenshot: ${path}`)
  return path
}
/** The marker races the container; whichever finishes first decides the exit code. */
async function runWithMarker(
  spec: DockerRunSpec,
  plan: LaunchPlan,
  logDir: string,
): Promise<LaunchResult> {
  const marker = plan.marker!
  const container = runContainer(spec, { logDir, stopTimeoutSeconds: STOP_TIMEOUT_SECONDS })
  const seen = waitForMarker(markerSources(plan, logDir), marker, plan.timeoutSeconds)

  const winner = await Promise.race([
    container.then((code) => ({ kind: 'exit' as const, code })),
    seen.then((hit) => ({ kind: 'marker' as const, hit })),
  ])
  if (winner.kind === 'exit') return { code: normalize(winner.code), reason: reasonFor(winner.code) }

  if (plan.mode === 'screenshot') await grabFrame(spec.name, plan)
  await stopContainer(spec.name, STOP_TIMEOUT_SECONDS)
  await container
  if (winner.hit) {
    status(`marker seen: ${marker}`)
    return { code: Exit.Ok, reason: 'marker' }
  }
  status(`marker "${marker}" not seen within ${plan.timeoutSeconds}s`)
  return { code: Exit.MarkerTimeout, reason: 'marker-timeout' }
}

function normalize(code: number): number {
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : Exit.GameFailed
}

/** A copy-out game writes logs under its own data root with no flag, so they move after. */
async function copyOutLogs(plan: LaunchPlan): Promise<void> {
  const spec = plan.gameConfig.logFile
  if (spec.mode !== 'copy-out') return
  const source = join(plan.dataDirHost, spec.from)
  if (!existsSync(source)) return
  const target = join(plan.runDirHost, basename(spec.from.replace(/\/+$/, '')))
  try {
    await cp(source, target, { recursive: true, force: true })
  } catch (error) {
    warn(`could not copy ${source}: ${describe(error)}`)
  }
}


async function mods(
  args: ParsedArgs,
  config: RootConfig,
  plugins: Map<string, GamePlugin>,
  defaults: ProjectDefaults,
): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)
  const index = await buildIndex(
    game,
    config.games[game]!,
    requirePlugin(plugins, game),
    sourcesRoot(config.dataRoot),
  )
  const sources = cachedSources(config.games[game]!, profile, args, config.dataRoot)
  const { plan, problems } = await resolvePlan({ game, profile, root: config, plugins, args, index, sources })
  if (problems.length > 0) reportProblems(problems)
  printPlan(plan, args.json)
  return Exit.Ok
}

async function doctor(config: RootConfig, plugins: Map<string, GamePlugin>): Promise<number> {
  let failed = false
  for (const game of Object.keys(config.games)) {
    // same map mods and verify get: without it doctor drops a pin's subdir and can name the
    // wrong directory of a repinned clone.
    const sources = cachedSources(config.games[game]!, 'modless', {}, config.dataRoot)
    const { plan, problems } = await resolvePlan({ game, profile: 'modless', root: config, plugins, sources })
    const workshop = workshopRootProblem(game, config.games[game]!)
    const all = [...problems, ...(await preflight(plan)), ...(workshop === null ? [] : [workshop])]
    if (all.length === 0) {
      status(`${game}: ok`)
      continue
    }
    failed = true
    status(`${game}: ${all.length} problem(s)`)
    for (const problem of all) {
      process.stderr.write(`  ${problem.where}\n    ${problem.message}\n`)
      if (problem.suggestion) process.stderr.write(`      try: ${problem.suggestion}\n`)
    }
  }
  return failed ? Exit.Environment : Exit.Ok
}

async function logs(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)
  const dir = instanceDir(args, config, game, profile)
  if (args.follow) return await follow(dir, false, `${game} ${profile}`)
  const runs = join(dir, 'logs', 'runs')

  const latest = (await readdir(runs, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .at(-1)
  if (latest === undefined) {
    throw new GamecrateError(`no runs recorded for ${game} ${profile}`, Exit.Usage, runs)
  }

  const runDir = join(runs, latest)
  const files = (await readdir(runDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ run: latest, dir: runDir, files }, null, 2)}\n`)
    return Exit.Ok
  }

  status(runDir)
  for (const name of files) {
    const text = await readFile(join(runDir, name), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line.length > 0) process.stdout.write(`${name}: ${line}\n`)
    }
  }
  return Exit.Ok
}

interface DockerInspect {
  State?: { Running?: boolean; StartedAt?: string }
  Mounts?: { Source?: string; Destination?: string }[]
}

interface ContainerInfo {
  running: boolean
  startedAt: number
  mounts: { source: string; destination: string }[]
}

async function inspectContainer(name: string): Promise<ContainerInfo | null> {
  const { code, stdout: text } = await capture(['docker', 'inspect', name])
  if (code !== 0) return null

  let first: DockerInspect | undefined
  try {
    first = (JSON.parse(text) as DockerInspect[])[0]
  } catch {
    return null
  }
  if (first === undefined) return null

  const startedAt = Date.parse(first.State?.StartedAt ?? '')
  return {
    running: first.State?.Running === true,
    startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
    mounts: (first.Mounts ?? [])
      .filter((m) => m.Source !== undefined && m.Destination !== undefined)
      .map((m) => ({ source: m.Source!, destination: m.Destination! })),
  }
}

interface BoundMod {
  packageId: string
  hostDir: string
  branch: string | null
  assembly: { path: string; mtimeMs: number } | null
  hasSources: boolean
  stale: boolean
  report: StaleReport | null
}

function boundStatus(mod: BoundMod): string {
  if (mod.report !== null) {
    const files = mod.report.newerCount === 1 ? '1 source' : `${mod.report.newerCount} sources`
    return `STALE - ${files} newer`
  }
  if (mod.assembly !== null) return 'OK'
  return mod.hasSources ? 'STALE - never built' : '(xml only)'
}

/**
 * What the container is running right now, read off its own mounts. A green build proves the
 * compiler ran somewhere, not that it wrote into the directory this container bound.
 */
async function verify(
  args: ParsedArgs,
  config: RootConfig,
  plugins: Map<string, GamePlugin>,
  defaults: ProjectDefaults,
): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)
  const sources = cachedSources(config.games[game]!, profile, args, config.dataRoot)
  const { plan, problems } = await resolvePlan({ game, profile, root: config, plugins, args, sources })
  if (problems.length > 0) reportProblems(problems)

  const name = containerName(plan)
  const info = await inspectContainer(name)
  if (info === null || !info.running) {
    throw new GamecrateError(
      `no container named ${name} is running`,
      Exit.Environment,
      'launch it first, or name the run with --instance or --worktree',
    )
  }

  // Per-mod binds are one level under the mods dir; the staged tree itself is the parent.
  const prefix = `${plan.gameConfig.modsDir.container}/`
  const bound = info.mounts
    .filter((m) => m.destination.startsWith(prefix))
    .filter((m) => !m.destination.slice(prefix.length).includes('/'))
    .sort((a, b) => (a.destination < b.destination ? -1 : 1))

  const boundMods: BoundMod[] = await Promise.all(
    bound.map(async (mount): Promise<BoundMod> => {
      const times = await scanBuildTimes(mount.source)
      const request = resolveWorktree(mount.source, 'ref', 0)
      return {
        packageId: mount.destination.slice(prefix.length),
        hostDir: mount.source,
        branch: 'root' in request ? request.branch : null,
        assembly: times.newestAssembly ?? null,
        hasSources: times.newestSource !== undefined,
        stale: decideStale(times),
        report: staleReport(times),
      }
    }),
  )

  const stale = boundMods.filter((mod) => mod.stale)
  if (args.json) {
    const payload = {
      container: name,
      running: true,
      upSeconds: Math.round((Date.now() - info.startedAt) / 1000),
      instance: plan.instance ?? plan.profile,
      stale: stale.length,
      mods: boundMods.map((mod) => ({
        packageId: mod.packageId,
        hostDir: mod.hostDir,
        branch: mod.branch,
        assembly: mod.assembly?.path ?? null,
        assemblyMs: mod.assembly?.mtimeMs ?? null,
        stale: mod.stale,
        status: boundStatus(mod),
        ...(mod.report === null ? {} : { report: mod.report }),
      })),
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return stale.length > 0 ? Exit.Stale : Exit.Ok
  }

  process.stdout.write(`${renderVerify(name, info, plan, boundMods)}\n`)
  return stale.length > 0 ? Exit.Stale : Exit.Ok
}

function renderVerify(
  name: string,
  info: ContainerInfo,
  plan: LaunchPlan,
  boundMods: BoundMod[],
): string {
  const out = [
    '',
    `  container   ${name} (up ${duration(Date.now() - info.startedAt)})`,
    `  instance    ${plan.instance ?? plan.profile}`,
    '',
  ]
  if (boundMods.length === 0) {
    out.push('  no boundMods are bind-mounted into this container')
    return out.join('\n')
  }

  const paths = boundMods.map((mod) => shortenHome(mod.hostDir))
  const idWidth = Math.max(...boundMods.map((mod) => mod.packageId.length))
  const pathWidth = Math.max(...paths.map((p) => p.length))
  const stamps = boundMods.map((mod) =>
    mod.assembly === null ? 'no assemblies' : `${mod.assembly.path}  ${ago(mod.assembly.mtimeMs)}`,
  )
  const stampWidth = Math.max(...stamps.map((s) => s.length))

  for (const [i, mod] of boundMods.entries()) {
    const origin = mod.branch === null ? '' : `worktree ${mod.branch}`
    out.push(`  ${mod.packageId.padEnd(idWidth)}  ${paths[i]!.padEnd(pathWidth)} ${origin}`.trimEnd())
    out.push(`  ${' '.repeat(idWidth)}  ${stamps[i]!.padEnd(stampWidth)}   ${boundStatus(mod)}`)
  }
  return out.join('\n')
}

function shortenHome(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Tiered on purpose: the default tier can never reach a save. */
async function clean(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)

  const dir = profileDataDir(config, game, profile)
  const tier = args.cleanTier ?? 'staging'
  const saveSuffixes = config.games[game]!.saveExtensions.map((ext) => `.${ext.replace(/^\./, '')}`.toLowerCase())

  // The cheap tiers belong to one instance; --all takes the profile and every instance with it.
  if (tier !== 'all') {
    const target = join(instanceDir(args, config, game, profile), tier === 'logs' ? 'logs' : '.stage')
    await rm(target, { recursive: true, force: true })
    status(`removed ${target}`)
    return Exit.Ok
  }

  const saves = await countSaves(dir, saveSuffixes)
  if (!args.yes) {
    throw new GamecrateError(
      `clean --all would delete ${dir}, including ${saves} save file(s)`,
      Exit.Usage,
      'add --yes to confirm',
    )
  }
  await rm(dir, { recursive: true, force: true })
  status(`removed ${dir} (${saves} save file(s))`)
  return Exit.Ok
}

async function countSaves(dir: string, suffixes: string[]): Promise<number> {
  let count = 0
  const queue = [dir]
  while (queue.length > 0) {
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(join(current, entry.name))
      else if (suffixes.some((s) => entry.name.toLowerCase().endsWith(s))) count++
    }
  }
  return count
}

/** `cp -a --reflink=auto`: on btrfs the precious tier copies in constant time. */
async function clone(args: ParsedArgs, config: RootConfig): Promise<number> {
  const game = requireGame(args, config)
  const [src, dst] = args.rest
  if (src === undefined || dst === undefined) {
    throw new GamecrateError('clone needs a source and a destination profile', Exit.Usage)
  }

  const from = join(profileDataDir(config, game, src), 'game')
  const to = join(profileDataDir(config, game, dst), 'game')
  if (!existsSync(from)) throw new GamecrateError(`${from} does not exist`, Exit.Usage)
  if (existsSync(to) && !args.yes) {
    throw new GamecrateError(`${to} already exists`, Exit.Usage, 'add --yes to overwrite')
  }

  await mkdir(to, { recursive: true })
  const code = await spawnStatus(['cp', '-a', '--reflink=auto', `${from}/.`, to])
  if (code !== 0) throw new GamecrateError(`cp failed with exit ${code}`, Exit.Environment)
  status(`cloned ${from} -> ${to}`)
  return Exit.Ok
}

async function ps(args: ParsedArgs, config: RootConfig): Promise<number> {
  const runs = await listRuns(config.dataRoot)
  if (args.json) {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`)
    return Exit.Ok
  }
  if (runs.length === 0) {
    status('nothing running')
    return Exit.Ok
  }
  const rows = runs.map((entry) => [
    entry.game,
    entry.instance === undefined ? entry.profile : `${entry.profile}/${entry.instance}`,
    entry.mode ?? '',
    entry.pid === undefined ? '' : String(entry.pid),
    entry.container,
    entry.uptime ?? entry.status,
  ])
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  for (const row of rows) {
    process.stdout.write(`${row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()}\n`)
  }
  if (runs.some((entry) => entry.status === 'orphaned')) {
    warn('some locks have no container; run gamecrate stop to clear them')
  }
  return Exit.Ok
}

async function stop(
  args: ParsedArgs,
  config: RootConfig,
  defaults: ProjectDefaults,
): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)
  const file = join(instanceDir(args, config, game, profile), '.gamecrate', 'lock')

  const record = await readLock(file)
  if (record === undefined) {
    status(`${game} ${profile} is not running`)
    return Exit.Ok
  }

  const outcome = await stopRun(record, file)
  if (outcome === 'held') {
    warn(`pid ${record.pid} still holds ${file}; ${record.container} did not stop in time`)
    return Exit.Refused
  }
  // the orphan path stopped a container nobody was supervising, which is not the same as
  // ending a live run and should not read like one
  status(outcome === 'signalled' ? `stopped ${record.container}` : `cleared the stale lock for ${record.container}`)
  return Exit.Ok
}

async function attach(
  args: ParsedArgs,
  config: RootConfig,
  defaults: ProjectDefaults,
): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)
  return await follow(instanceDir(args, config, game, profile), true, `${game} ${profile}`)
}

/**
 * One follower for attach and logs -f; they differ only in where they start reading. A live
 * holder is waited on first, because `current` lags the lock by however long staging takes.
 */
async function follow(dir: string, fromStart: boolean, what: string): Promise<number> {
  const lock = await readLock(join(dir, '.gamecrate', 'lock'))
  const held = lock !== undefined && isRunning(lock.pid, lock.startedAt)
  const live = held && (await awaitRunLog(dir, lock))

  const file = currentLog(dir)
  if (!existsSync(file)) {
    throw new GamecrateError(`no captured output for ${what}`, Exit.Usage, file)
  }
  return await spawnStatus(tailArgv(file, fromStart, live ? lock.pid : undefined), true)
}

async function waitFor(
  args: ParsedArgs,
  config: RootConfig,
  defaults: ProjectDefaults,
): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)
  const dir = instanceDir(args, config, game, profile)

  const record = await awaitExit(dir)
  if (record === 'orphaned') {
    throw new GamecrateError(
      `${game} ${profile}: the lock holder is gone and recorded no exit`,
      Exit.Refused,
      `run: gamecrate stop ${game} ${profile}`,
    )
  }
  if (record === 'absent') {
    throw new GamecrateError(`no run recorded for ${game} ${profile}`, Exit.Usage, dir)
  }

  if (args.json) process.stdout.write(`${JSON.stringify(record)}\n`)
  else status(`${game} ${profile}: ${record.reason} (${record.code})`)
  return record.code
}

async function build(args: ParsedArgs, config: RootConfig): Promise<number> {
  const game = requireGame(args, config)
  await acquireImage(game, config.games[game]!, args.pull ?? 'always')
  status(`${config.games[game]!.image.ref} is ready`)
  return Exit.Ok
}

async function configEdit(args: ParsedArgs): Promise<number> {
  if (args.rest[0] !== 'edit') throw new GamecrateError('config takes one word: edit', Exit.Usage)

  const existing = await findGlobalConfig()
  const path = existing ?? join(globalConfigDir(), 'profiles.yml')
  await mkdir(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    await writeFile(
      path,
      '# gamecrate config. see https://github.com/RimWorks/gamecrate\n' +
        'plugins: []\n' +
        'games: {}\n',
    )
  }

  const editor = process.env.VISUAL ?? process.env.EDITOR
  if (editor === undefined) throw new GamecrateError('no $EDITOR or $VISUAL set', Exit.Usage, path)
  if ((await spawnStatus([...editor.split(' '), path], true)) !== 0) return Exit.Usage

  await loadConfig(path)
  status(`${path} is valid`)
  return Exit.Ok
}

/** Never silently chowns: it reports what it found and only acts under --yes. */
async function fixPerms(args: ParsedArgs, config: RootConfig): Promise<number> {
  const game = requireGame(args, config)
  const identity = resolveIdentity(false)
  const found: string[] = []
  for (const dir of await profileDirs(config, game, args.profile)) {
    if (!existsSync(dir)) continue
    found.push(...(await detectForeignOwnership(dir, identity.uid, 10_000)))
  }

  if (found.length === 0) {
    status(`${game}: every path is owned by uid ${identity.uid}`)
    return Exit.Ok
  }
  if (args.dryRun || !args.yes) {
    for (const path of found) process.stdout.write(`would chown ${identity.uid}:${identity.gid} ${path}\n`)
    status(`${found.length} foreign-owned path(s); re-run with --yes to chown them`)
    return Exit.Environment
  }
  // chown of a foreign-owned path needs root either way, so an empty directory whose parent
  // we own is recovered by removing it: the next launch recreates it as the caller.
  let fixed = 0
  const stuck: string[] = []
  for (const path of found) {
    const chowned = await chown(path, identity.uid, identity.gid).then(
      () => true,
      () => false,
    )
    if (chowned) {
      fixed += 1
      continue
    }
    if (await removeIfEmptyDir(path)) {
      status(`removed empty ${path}; it will be recreated on the next run`)
      fixed += 1
      continue
    }
    stuck.push(path)
  }

  if (fixed > 0) status(`fixed ${fixed} path(s) for ${identity.uid}:${identity.gid}`)
  if (stuck.length > 0) {
    for (const path of stuck) warn(`cannot chown ${path}`)
    throw new GamecrateError(
      `${stuck.length} path(s) still not owned by uid ${identity.uid}`,
      Exit.Environment,
      `sudo chown -R ${identity.uid}:${identity.gid} ${stuck.join(' ')}`,
    )
  }
  return Exit.Ok
}

/** Removing needs write on the parent, not ownership of the directory itself. */
async function removeIfEmptyDir(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isDirectory()) return false
  const entries = await readdir(path).catch((): string[] | null => null)
  if (entries === null || entries.length > 0) return false
  // fs.rm on a directory needs recursive:true; rmdir is the one that removes an empty dir.
  return rmdir(path).then(
    () => true,
    () => false,
  )
}

async function spawnStatus(argv: string[], interactive = false): Promise<number> {
  const proc = spawnArgv(argv, [interactive ? 'inherit' : 'ignore', 'inherit', 'inherit'])
  return exited(proc)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Prints a failure and returns its exit code. Shared, so --log and the bare path agree. */
function reportFatal(error: unknown): number {
  if (error instanceof GamecrateError) {
    process.stderr.write(`gamecrate: ${error.message}\n`)
    if (error.detail) process.stderr.write(`${error.detail}\n`)
    return error.code
  }
  process.stderr.write(`gamecrate: ${describe(error)}\n`)
  return Exit.GameFailed
}

try {
  process.exit(await main(process.argv.slice(2)))
} catch (error) {
  // Only reachable for failures before dispatch: arg parsing and config loading.
  process.exit(reportFatal(error))
}
