#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { cp, lchown, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { buildPolicy, parseArgs, supervisedDir, wantsDetach, wantsReplace } from './cli/args'
import { requireGame } from './cli/game'
import { currentRefs, extractRefs } from './image/refs'
import { list } from './cli/list'
import { initCommand } from './cli/init'
import { globalConfigPath, modsAdd, modsRm, modsSync } from './cli/mods'
import { launchProfile, profileOf } from './cli/profile'
import { steamBuildCommand, steamLogin } from './cli/steam'
import { renderHelp } from './cli/help'
import { dashboardFor } from './cli/tty'
import { startSession } from './cli/session'
import type { Session } from './cli/session'
import { startBoard } from './cli/taskboard'
import type { Board } from './cli/taskboard'
import { complete, renderCandidates, renderCompletion } from './cli/complete'
import { captureOutput, currentLog, openRunLog, planWarnings, printPlan, reportProblems, status, tailArgv, warn } from './cli/output'
import {
  findGlobalConfig,
  globalConfigDir,
  loadConfig,
  loadProjectDefaults,
  profileDataDir,
  profileDirs,
  profileNames,
  resolveProfile,
} from './config/load'
import { resolveIdentity } from './docker/identity'
import { preflight } from './docker/preflight'
import { capture, exited, spawnArgv, runContainer, stopContainer, STOP_TIMEOUT_SECONDS, waitForMarker } from './docker/run'
import { buildRunSpec, containerName, refuseProtonHeaded, windowIcon, windowTitle } from './docker/spec'
import { adoptNewWindow } from './docker/window'
import { generateModsConfig, mergePrefs, writeModSettings } from './launch/generate'
import { createInterface } from 'node:readline/promises'
import { imageFor, imageLaunch, imageProblem, markerProblem, readImageFacts, withImageOverride } from './launch/image'
import { offerRebuild } from './launch/updates'
import { RUNTIME_BASE } from './image/base'
import type { ImageFacts } from './launch/image'
import type { ImageLaunch } from './docker/spec'
import type { BuildHooks } from './launch/prepare'
import {
  acquireImage,
  buildLocalMods,
  repoDigest,
  captureScreenshot,
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
import { notFetched, resolvePlan } from './launch/resolve'
import { listRuns } from './run/registry'
import { detectForeignOwnership, ensureProfileTree, stageMods } from './launch/stage'
import { buildIndex } from './mods/modindex'
import { cachedSources, prepareSources, sourcesRoot } from './mods/source'
import type { PreparedSources } from './mods/source'
import { releaseToken, unzipPresent } from './mods/release'
import { downloadRoot, removeDownloads, resolveSteamcmd, STEAMCMD_IMAGE } from './mods/steamcmd'
import { emit } from './channels'
import type { SteamcmdRunner } from './mods/steamcmd'
import { prepareWorkshop } from './mods/workshop'
import type { PreparedWorkshop } from './mods/workshop'
import { requirePlugin } from './plugin'
import type { GamePlugin } from './plugin'
import { ago, decideStale, duration, scanBuildTimes, staleReport } from './mods/staleness'
import { resolveWorktree } from './mods/worktree'
import { GamecrateError, Exit, NAME_PATTERN, reasonFor, STDOUT_LOG } from './types'
import type {
  BuildPolicy,
  DockerRunSpec,
  GameConfig,
  Identity,
  LaunchPlan,
  LaunchResult,
  ModEntry,
  ModSettingsFile,
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
  const supervised = supervisedDir(argv)
  try {
    return await command(argv, supervised)
  } catch (error) {
    if (supervised === undefined) throw error
    return await supervisorFailed(supervised, reportFatal(error))
  }
}

async function command(argv: string[], supervised: string | undefined): Promise<number> {
  if (argv[0] === '__complete') {
    const { config } = await loadConfig(undefined, await loadProjectDefaults())
    emit('data', renderCandidates(complete(argv.slice(1), config)))
    return Exit.Ok
  }

  const probe = probeArgs(argv)
  if (probe?.subcommand === 'version') {
    emit('data', `gamecrate ${VERSION}\n`)
    return Exit.Ok
  }
  if (probe?.subcommand === 'init' && probe.help !== true) return await initCommand(probe)

  const defaults = await loadProjectDefaults()
  const { config, plugins } = await loadConfig(undefined, defaults)
  const args = parseArgs(argv, { games: Object.keys(config.games), profiles: profileNames(config), defaults })

  if (args.help) {
    emit('data', renderHelp(helpTopic(args), config))
    return Exit.Ok
  }
  const launching = args.subcommand === 'run' || args.subcommand === 'shell'
  const sink =
    launching && (args.log !== undefined || args.quiet)
      ? captureOutput(args.log, {
          append: args.supervised,
          tee: !args.quiet,
          always: ['status'],
        })
      : undefined

  try {
    return await dispatch(argv, args, config, plugins, defaults)
  } catch (error) {
    const code = reportFatal(error)
    return supervised === undefined ? code : await supervisorFailed(supervised, code)
  } finally {
    sink?.close()
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
    case 'steam': {
      const ctx = { config, plugins, cwd: process.cwd(), configFile: await globalConfigPath() }
      if (args.subverb === 'login') return steamLogin(args, ctx)
      return steamBuildCommand(args, ctx)
    }
    case 'doctor':
      return doctor(config, plugins)
    case 'refs':
      return refs(args, config, defaults)
    case 'clean':
      return clean(args, config, defaults)
    case 'clone':
      return clone(args, config)
    case 'logs':
      return logs(args, config, defaults)
    case 'verify':
      return verify(args, config, plugins, defaults)
    case 'build':
      return build(args, config, defaults)
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
    case 'completion':
      return completion(args)
    case 'config':
      return configEdit()
    case 'fix-perms':
      return fixPerms(args, config)
    case 'run':
      return run(argv, args, config, plugins, defaults, false)
    default:
      throw new GamecrateError(`no such subcommand ${args.subcommand}`, Exit.Usage)
  }
}

function iconOption(plan: LaunchPlan, configFile: string): { icon?: string } {
  const icon = windowIcon(plan, dirname(configFile))
  return icon === undefined ? {} : { icon }
}

function helpTopic(args: ParsedArgs): string[] {
  if (args.subcommand === 'help') return args.rest
  if (args.subcommand !== 'run') {
    return args.subverb === undefined ? [args.subcommand] : [args.subcommand, args.subverb]
  }
  if (args.verbTyped) return ['run']
  return args.game === undefined ? [] : [args.game]
}

function help(args: ParsedArgs, config: RootConfig): number {
  emit('data', renderHelp(args.rest, config))
  return Exit.Ok
}

function completion(args: ParsedArgs): number {
  const shell = args.rest[0]
  if (shell !== 'bash' && shell !== 'zsh') {
    throw new GamecrateError('completion takes bash or zsh', Exit.Usage, 'gamecrate completion zsh')
  }
  emit('data', renderCompletion(shell))
  return Exit.Ok
}

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

async function run(
  argv: string[],
  args: ParsedArgs,
  config: RootConfig,
  plugins: Map<string, GamePlugin>,
  defaults: ProjectDefaults,
  asShell: boolean,
): Promise<number> {
  const game = requireGame(args, config)
  const profile = launchProfile(args, defaults, config.games[game]!)

  const gameConfig = gameForImage(args, config, defaults, game)
  config.games[game] = gameConfig
  const allowFetch = !args.dryRun && !args.printPlan
  const sources = await prepareSources(gameConfig, profile, args, config.dataRoot, allowFetch)
  try {
    const workshop = await prepareWorkshop(gameConfig, profile, args, config, allowFetch, requirePlugin(plugins, game), sources.dirs)
    return await resolved({ argv, args, config, plugins, asShell, game, profile, sources, workshop, allowFetch })
  } finally {
    await sources.release()
  }
}

function warnUnfetched(problems: Problem[], unfetched: string[]): Problem[] {
  const provisional = new Set(unfetched.map(notFetched))
  const fatal: Problem[] = []
  for (const problem of problems) {
    if (provisional.has(problem.message)) warn(`${problem.where}: ${problem.message}`)
    else fatal.push(problem)
  }
  return fatal
}

interface ResolveInputs {
  argv: string[]
  args: ParsedArgs
  config: RootConfig
  plugins: Map<string, GamePlugin>
  asShell: boolean
  game: string
  profile: string
  sources: PreparedSources
  workshop: PreparedWorkshop
  allowFetch: boolean
}

async function resolved(inputs: ResolveInputs): Promise<number> {
  const { argv, args, config, plugins, asShell, game, profile, sources, workshop, allowFetch } = inputs
  for (const warning of [...sources.warnings, ...workshop.warnings]) warn(warning)
  const index = await buildIndex(
    game,
    config.games[game]!,
    requirePlugin(plugins, game),
    sourcesRoot(config.dataRoot),
    config.dataRoot,
  )
  const { plan, problems } = await resolvePlan({ game, profile, root: config, plugins, args, index, sources: sources.dirs, unfetched: allowFetch ? undefined : workshop.unfetched })
  const fatal = warnUnfetched([...workshop.problems, ...problems], allowFetch ? [] : workshop.unfetched)
  if (fatal.length > 0) reportProblems(fatal)

  const identity = resolveIdentity(args.root)

  if (args.printPlan || args.dryRun) return await reportPlanOnly(plan, args, profile, identity, asShell)

  const environment = await preflight(plan, asShell)
  if (environment.length > 0) reportEnvironment(environment)

  await ensureProfileTree(plan)
  const profileSpec = resolveProfile(config.games[game]!, profile)
  if (wantsReplace(args, profileSpec)) await replacePrevious(plan)
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

async function reportPlanOnly(
  plan: LaunchPlan,
  args: ParsedArgs,
  profile: string,
  identity: Identity,
  asShell: boolean,
): Promise<number> {
  const environment = await preflight(plan, asShell)
  buildRunSpec(plan, [], identity)
  if (args.printPlan) printPlan(plan, args.json)
  for (const warning of planWarnings(plan)) warn(warning)
  if (environment.length > 0) reportEnvironment(environment)
  if (!args.printPlan) {
    const what = plan.instance === undefined ? profile : `${profile}/${plan.instance}`
    status(`${plan.game} ${what}: ${plan.mods.length} mods resolve cleanly`)
  }
  return Exit.Ok
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
  const profile = plan.profile
  const foreign = await detectForeignOwnership(plan.dataDirHost, identity.uid, 5)
  if (foreign.length > 0) {
    throw new GamecrateError(
      `${foreign.length} path(s) under ${plan.dataDirHost} are not owned by uid ${identity.uid}`,
      Exit.Environment,
      `${foreign.join('\n')}\nrun: gamecrate fix-perms ${profile}`,
    )
  }

  const runDir = openRunLog(plan.logsDirHost)
  plan.runDirHost = runDir
  const supervisorLog =
    args.supervised && args.log === undefined ? captureOutput(join(runDir, 'supervisor.log')) : undefined

  try {
    return await execute({ plan, args, config, identity, asShell, profileSpec, runDir, releaseSources })
  } finally {
    supervisorLog?.close()
  }
}

interface ExecuteInputs {
  plan: LaunchPlan
  args: ParsedArgs
  config: RootConfig
  identity: Identity
  asShell: boolean
  profileSpec: ProfileConfig
  runDir: string
  releaseSources: () => Promise<void>
}

async function buildOnBoard(plan: LaunchPlan, policy: BuildPolicy, drawable: boolean): Promise<void> {
  let board: Board | undefined
  const hooks: BuildHooks = {
    onPlan: (tasks) => {
      board = startBoard({
        title: `building ${plan.game} mods`,
        subtitle: tasks.length === 1 ? '1 project' : `${tasks.length} projects`,
        tasks,
      })
    },
    onCell: (id, patch) => board?.update(id, patch),
  }
  await buildLocalMods(plan, policy, currentRefs(plan.game), drawable ? hooks : undefined).finally(
    () => board?.close(),
  )
}

async function execute(inputs: ExecuteInputs): Promise<LaunchResult> {
  const { plan, args, config, identity, asShell, profileSpec, runDir, releaseSources } = inputs
  const wantsDashboard = dashboardFor({
    plain: args.plain,
    json: args.json,
    quiet: args.quiet,
    detach: args.detach,
    asShell,
    marker: plan.marker !== undefined,
    mode: plan.mode,
  })
  await buildOnBoard(plan, buildPolicy(args, profileSpec), wantsDashboard)
  // TODO(perf): drop when a clone is staged by copy, or behind a read-lock a resetting writer waits on
  await releaseSources()
  const { facts, imageStart } = await readyImage(plan, config, args, asShell)

  const modMounts = await stageMods(plan)
  await generateModsConfig(plan)
  await mergePrefs(plan)
  const settingsBlocks = [...(profileSpec.modSettings ?? []), ...recordSettings(plan)]
  for (const file of await writeModSettings(plan, settingsBlocks)) status(`wrote ${file}`)
  for (const warning of planWarnings(plan)) warn(warning)

  const spec = buildRunSpec(plan, modMounts, identity, imageStart)
  if (asShell) {
    spec.command = ['/bin/bash']
    spec.extraArgs = [...spec.extraArgs, '--interactive', '--tty']
  }
  await writeLaunchRecord(plan, spec.image)

  const trustExit = facts.launcher !== 'proton'

  try {
    return await dispatchRun(spec, plan, runDir, trustExit, asShell, wantsDashboard)
  } finally {
    await copyOutLogs(plan)
  }
}

async function readyImage(
  plan: LaunchPlan,
  config: RootConfig,
  args: ParsedArgs,
  asShell: boolean,
): Promise<{ facts: ImageFacts; imageStart: ImageLaunch | undefined }> {
  const game = plan.game
  const ref = config.games[game]!.image.ref
  try {
    await acquireImage(game, config.games[game]!, args.pull ?? 'missing')
  } catch (error) {
    const absent = imageProblem({ game, ref, mode: plan.mode, facts: await readImageFacts(ref) })
    if (absent === null) throw error
    throw new GamecrateError(absent.message, Exit.Environment, absent.suggestion)
  }
  let facts = await readImageFacts(ref)
  if (await rebuiltForUpdate(plan, config, args)) facts = await readImageFacts(ref)
  const problem = imageProblem({ game, ref, mode: plan.mode, facts })
  if (problem !== null) {
    throw new GamecrateError(problem.message, Exit.Environment, problem.suggestion)
  }
  const imageStart = asShell ? undefined : imageLaunch(facts)
  refuseProtonHeaded(game, plan.mode, imageStart)
  const needsMarker = asShell ? null : markerProblem({ game, facts, marker: plan.marker })
  if (needsMarker !== null) {
    throw new GamecrateError(needsMarker.message, Exit.Usage, needsMarker.suggestion)
  }
  return { facts, imageStart }
}

async function rebuiltForUpdate(plan: LaunchPlan, config: RootConfig, args: ParsedArgs): Promise<boolean> {
  const facts = await readImageFacts(config.games[plan.game]!.image.ref)
  let rebuilt = false
  await offerRebuild({
    game: plan.game,
    config,
    args,
    facts,
    cwd: process.cwd(),
    configFile: await globalConfigPath(),
    ask: async (question) => {
      if (args.yes) {
        rebuilt = true
        return true
      }
      if (process.stdin.isTTY !== true || args.json) {
        warn('no terminal to ask, so the launch keeps the current image')
        return false
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const said = (await rl.question(question)).trim().toLowerCase()
        rebuilt = said === 'y' || said === 'yes'
        return rebuilt
      } finally {
        rl.close()
      }
    },
  })
  return rebuilt
}

async function dispatchRun(
  spec: DockerRunSpec,
  plan: LaunchPlan,
  runDir: string,
  trustExit: boolean,
  asShell: boolean,
  wantsDashboard = false,
): Promise<LaunchResult> {
  if (plan.marker !== undefined && !asShell) return await runWithMarker(spec, plan, runDir, trustExit)
  if (plan.mode === 'screenshot' && !asShell) return await runWithScreenshot(spec, plan, runDir, trustExit)
  if (plan.mode !== 'headed' && !asShell) return await runBounded(spec, plan, runDir, trustExit)

  let windowClosed = false
  const window =
    asShell || plan.settings.display !== 'x11'
      ? null
      : await adoptNewWindow({
          executable: plan.gameConfig.executable,
          title: windowTitle(plan),
          ...iconOption(plan, await globalConfigPath()),
          stripDelete: plan.gameConfig.ignoresWmDelete === true,
          onClosed: () => {
            windowClosed = true
            void stopContainer(spec.name, STOP_TIMEOUT_SECONDS)
          },
        })
  let session: Session | undefined
  try {
    session = wantsDashboard ? openSession(spec, plan) : undefined
    const code = await runContainer(spec, {
      logDir: runDir,
      stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
      ...(session === undefined ? {} : { stdin: 'ignore' as const }),
    })
    session?.setPhase(`exited ${code}`)
    if (session !== undefined && code !== 0 && !windowClosed && !session.quitRequested) {
      await session.waitForQuit()
    }
    if (windowClosed) return { code: Exit.Ok, reason: 'window-closed' }
    return { code: normalize(code), reason: reasonFor(code) }
  } finally {
    session?.close()
    window?.stop()
  }
}

function modCounts(plan: LaunchPlan): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const mod of plan.mods) counts[mod.kind] = (counts[mod.kind] ?? 0) + 1
  return counts
}

function recordDir(plan: LaunchPlan): string | undefined {
  const records = plan.gameConfig.records
  if (records === undefined) return undefined
  const writers = new Set(records.mods.map((id) => id.toLowerCase()))
  if (!plan.mods.some((mod) => writers.has(mod.packageId.toLowerCase()))) return undefined
  return join(plan.configDirHost, records.dir)
}

function probeArgs(argv: string[]): ParsedArgs | undefined {
  try {
    return parseArgs(argv)
  } catch {
    return undefined
  }
}

function recordSettings(plan: LaunchPlan): ModSettingsFile[] {
  const enable = plan.gameConfig.records?.enable
  if (enable === undefined || recordDir(plan) === undefined) return []
  return [enable]
}

function openSession(spec: DockerRunSpec, plan: LaunchPlan): Session {
  const dir = recordDir(plan)
  const session = startSession({
    identity: {
      game: plan.game,
      profile: plan.profile,
      container: spec.name,
      mode: plan.mode,
      mods: modCounts(plan),
    },
    container: spec.name,
    onStop: () => void stopContainer(spec.name, STOP_TIMEOUT_SECONDS),
    ...(dir === undefined ? {} : { recordDir: dir }),
  })
  return session
}

function markerSources(plan: LaunchPlan, logDir: string): string[] {
  const sources = [join(logDir, STDOUT_LOG)]
  const { logFile } = plan.gameConfig
  if (logFile.mode === 'arg') sources.push(join(logDir, 'Player.log'))
  else sources.push(join(plan.dataDirHost, logFile.from))
  return sources
}

async function runBounded(
  spec: DockerRunSpec,
  plan: LaunchPlan,
  logDir: string,
  trustExit: boolean,
): Promise<LaunchResult> {
  const container = runContainer(spec, { logDir, stopTimeoutSeconds: STOP_TIMEOUT_SECONDS })
  const winner = await Promise.race([
    container.then((code) => ({ kind: 'exit' as const, code })),
    sleep(plan.timeoutSeconds * 1000).then(() => ({ kind: 'timeout' as const })),
  ])
  if (winner.kind === 'exit') return exitResult(winner.code, trustExit)

  status(`no marker given; stopping after ${plan.timeoutSeconds}s`)
  await stopContainer(spec.name, STOP_TIMEOUT_SECONDS)
  await container
  return { code: Exit.Ok, reason: 'timeout' }
}

async function runWithScreenshot(
  spec: DockerRunSpec,
  plan: LaunchPlan,
  logDir: string,
  trustExit: boolean,
): Promise<LaunchResult> {
  const container = runContainer(spec, { logDir, stopTimeoutSeconds: STOP_TIMEOUT_SECONDS })
  const settled = sleep(plan.renderWaitSeconds * 1000).then(() => 'ready' as const)

  const winner = await Promise.race([
    container.then((code) => ({ kind: 'exit' as const, code })),
    settled.then(() => ({ kind: 'ready' as const })),
  ])
  if (winner.kind === 'exit') {
    status(`game exited before the ${plan.renderWaitSeconds}s render wait finished; no frame captured`)
    return exitResult(winner.code, trustExit)
  }

  const shot = await grabFrame(spec.name, plan)
  await stopContainer(spec.name, STOP_TIMEOUT_SECONDS)
  await container
  return { code: shot === null ? Exit.Environment : Exit.Ok, reason: 'stopped' }
}

async function grabFrame(container: string, plan: LaunchPlan): Promise<string | null> {
  const path = await captureScreenshot(container, plan)
  if (path === null) warn('screenshot capture failed; the capture command printed the reason above')
  else status(`screenshot: ${path}`)
  return path
}
const MARKER_GRACE_MS = 1000

async function runWithMarker(
  spec: DockerRunSpec,
  plan: LaunchPlan,
  logDir: string,
  trustExit: boolean,
): Promise<LaunchResult> {
  const marker = plan.marker!
  const container = runContainer(spec, { logDir, stopTimeoutSeconds: STOP_TIMEOUT_SECONDS })
  let waited: boolean | undefined
  const seen = waitForMarker(markerSources(plan, logDir), marker, plan.timeoutSeconds).then(
    (hit) => {
      waited = hit
      return hit
    },
  )

  const winner = await Promise.race([
    container.then((code) => ({ kind: 'exit' as const, code })),
    seen.then((hit) => ({ kind: 'marker' as const, hit })),
  ])
  if (winner.kind === 'exit') {
    if (trustExit || winner.code === Exit.Interrupted) return exitResult(winner.code, trustExit)
    const hit = await Promise.race([seen, sleep(MARKER_GRACE_MS).then(() => false)])
    if (hit) {
      status(`marker seen: ${marker}`)
      return { code: Exit.Ok, reason: 'marker' }
    }
    status(`container exited before the marker "${marker}" appeared`)
    return waited === false
      ? { code: Exit.MarkerTimeout, reason: 'marker-timeout' }
      : { code: Exit.GameFailed, reason: 'exited' }
  }

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

function exitResult(code: number, trustExit: boolean): LaunchResult {
  if (trustExit || code === Exit.Interrupted) {
    return { code: normalize(code), reason: reasonFor(code) }
  }
  return { code: Exit.GameFailed, reason: 'exited' }
}

function normalize(code: number): number {
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : Exit.GameFailed
}

async function copyOutLogs(plan: LaunchPlan): Promise<void> {
  const spec = plan.gameConfig.logFile
  if (spec.mode !== 'copy-out') return
  const source = join(plan.dataDirHost, spec.from)
  if (!existsSync(source)) return
  const target = join(plan.runDirHost, basename(spec.from))
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
  const sources = cachedSources(config.games[game]!, profile, args, config.dataRoot)
  const workshop = await prepareWorkshop(config.games[game]!, profile, args, config, false, requirePlugin(plugins, game), sources)
  for (const warning of workshop.warnings) warn(warning)
  const index = await buildIndex(
    game,
    config.games[game]!,
    requirePlugin(plugins, game),
    sourcesRoot(config.dataRoot),
    config.dataRoot,
  )
  const { plan, problems } = await resolvePlan({ game, profile, root: config, plugins, args, index, sources, unfetched: workshop.unfetched })
  const fatal = warnUnfetched([...workshop.problems, ...problems], workshop.unfetched)
  if (fatal.length > 0) reportProblems(fatal)
  printPlan(plan, args.json)
  return Exit.Ok
}

function usesWorkshop(game: GameConfig): boolean {
  if (Object.values(game.library ?? {}).some((entry) => entry.workshop !== undefined)) return true
  const slots = [...(game.preCore ?? []), game.core, ...game.dlc, ...(game.base ?? [])]
  if (slots.some((ref) => ref.startsWith('workshop:'))) return true
  return Object.values(game.profiles).some((profile) => (profile.mods ?? []).some(isWorkshopEntry))
}

function isWorkshopEntry(entry: ModEntry): boolean {
  if (typeof entry === 'string') return entry.startsWith('workshop:')
  return 'workshop' in entry && entry.workshop !== undefined
}

function steamcmdSource(runner: SteamcmdRunner, config: RootConfig): string {
  if (runner.kind === 'docker') return `docker image ${STEAMCMD_IMAGE}`
  const where = config.steamcmd?.path === undefined ? 'on PATH' : 'steamcmd.path'
  return `${runner.argv[0]} (${where})`
}

function gameForImage(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults, game: string): GameConfig {
  const base = config.games[game]!
  const ref = args.image ?? imageFor(base, launchProfile(args, defaults, base))
  return withImageOverride(base, ref)
}

async function refs(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults): Promise<number> {
  const game = requireGame(args, config)
  const found = await extractRefs(game, gameForImage(args, config, defaults, game))
  if (args.json) {
    emit('data', `${JSON.stringify(found, null, 2)}\n`)
    return Exit.Ok
  }
  status(`${found.count} assemblies from ${found.source} at ${found.digest}`)
  status(`stable path: ${found.link}`)
  emit('data', `${found.dir}\n`)
  return Exit.Ok
}

async function doctor(config: RootConfig, plugins: Map<string, GamePlugin>): Promise<number> {
  let failed = false
  for (const game of Object.keys(config.games)) {
    const gameConfig = config.games[game]!
    const sources = cachedSources(gameConfig, 'modless', {}, config.dataRoot)
    const { plan, problems } = await resolvePlan({ game, profile: 'modless', root: config, plugins, sources })
    const all = [
      ...problems,
      ...(await preflight(plan)),
      ...steamcmdProblems(game, gameConfig, config),
      ...releaseProblems(game, gameConfig),
      ...(await baseDriftProblems(game, gameConfig)),
    ]
    if (!reportDoctor(game, all)) failed = true
  }
  return failed ? Exit.Environment : Exit.Ok
}

/** A release pin needs unzip on the host, so say so here instead of failing mid-launch. */
function releaseProblems(game: string, gameConfig: GameConfig): Problem[] {
  const pinned = Object.entries(gameConfig.library ?? {}).filter(([, entry]) => entry.release !== undefined)
  if (pinned.length === 0) return []
  status(`${game}: ${pinned.length} release-pinned mod(s)${releaseToken() === undefined ? ', no GITHUB_TOKEN set' : ''}`)
  if (unzipPresent()) return []
  return [
    {
      where: `/games/${game}/library`,
      message: `${pinned.length} mod(s) come from a GitHub release, and unzip is not on PATH`,
      suggestion: 'install unzip',
    },
  ]
}

async function baseDriftProblems(game: string, gameConfig: GameConfig): Promise<Problem[]> {
  const ref = gameConfig.image.ref
  if (ref.trim() === '') return []
  const facts = await readImageFacts(ref)
  if (!facts.present || facts.runtime === null) return []

  const base = RUNTIME_BASE[facts.launcher === 'proton' ? 'windows' : 'linux']
  const current = await repoDigest(base)
  if (current === null) return []
  if (facts.runtime.endsWith(current)) return []

  return [
    {
      where: `/games/${game}/image/ref`,
      message: `${ref} was built on an older ${base}`,
      suggestion: `gamecrate steam build --game ${game} to rebuild it on the base you have`,
    },
  ]
}

function steamcmdProblems(game: string, gameConfig: GameConfig, config: RootConfig): Problem[] {
  if (!usesWorkshop(gameConfig)) return []
  const problems: Problem[] = []
  try {
    status(`${game}: steamcmd ${steamcmdSource(resolveSteamcmd(config), config)}`)
  } catch (error) {
    problems.push({
      where: 'steamcmd',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof GamecrateError && error.detail !== undefined ? { suggestion: error.detail } : {}),
    })
  }
  const root = downloadRoot(config.dataRoot, gameConfig)
  status(`${game}: workshop downloads ${root}${existsSync(root) ? '' : ' (not created yet)'}`)
  return problems
}

function reportDoctor(game: string, all: Problem[]): boolean {
  if (all.length === 0) {
    status(`${game}: ok`)
    return true
  }
  status(`${game}: ${all.length} problem(s)`)
  for (const problem of all) {
    emit('status', `  ${problem.where}\n    ${problem.message}\n`)
    if (problem.suggestion) emit('status', `      try: ${problem.suggestion}\n`)
  }
  return false
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
    .sort((a, b) => Number(a > b) - Number(a < b))
    .at(-1)
  if (latest === undefined) {
    throw new GamecrateError(`no runs recorded for ${game} ${profile}`, Exit.Usage, runs)
  }

  const runDir = join(runs, latest)
  const files = (await readdir(runDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => Number(a > b) - Number(a < b))

  if (args.json) {
    emit('data', `${JSON.stringify({ run: latest, dir: runDir, files }, null, 2)}\n`)
    return Exit.Ok
  }

  status(runDir)
  for (const name of files) {
    const text = await readFile(join(runDir, name), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line.length > 0) emit('data', `${name}: ${line}\n`)
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
  if (!info?.running) {
    throw new GamecrateError(
      `no container named ${name} is running`,
      Exit.Environment,
      'launch it first, or name the run with --instance or --worktree',
    )
  }

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
    emit('data', `${JSON.stringify(payload, null, 2)}\n`)
    return stale.length > 0 ? Exit.Stale : Exit.Ok
  }

  emit('data', `${renderVerify(name, info, plan, boundMods)}\n`)
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
    out.push(
      `  ${mod.packageId.padEnd(idWidth)}  ${paths[i]!.padEnd(pathWidth)} ${origin}`.trimEnd(),
      `  ${' '.repeat(idWidth)}  ${stamps[i]!.padEnd(stampWidth)}   ${boundStatus(mod)}`,
    )
  }
  return out.join('\n')
}

function shortenHome(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

async function clean(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults): Promise<number> {
  const game = requireGame(args, config)
  const profile = profileOf(args, defaults)

  const dir = profileDataDir(config, game, profile)
  const tier = args.cleanTier ?? 'staging'
  const saveSuffixes = config.games[game]!.saveExtensions.map((ext) => `.${ext.replace(/^\./, '')}`.toLowerCase())

  const downloads = downloadRoot(config.dataRoot, config.games[game]!)
  if (tier === 'downloads') {
    status(await removeDownloads(downloads, config.games[game]!.steamAppId))
    return Exit.Ok
  }

  if (tier !== 'all') {
    const target = join(instanceDir(args, config, game, profile), tier === 'logs' ? 'logs' : '.stage')
    await rm(target, { recursive: true, force: true })
    status(`removed ${target}`)
    return Exit.Ok
  }

  const saves = await countSaves(dir, saveSuffixes)
  if (!args.yes) {
    throw new GamecrateError(
      `clean --all would delete ${dir}, including ${saves} save file(s), and ${game}'s workshop downloads`,
      Exit.Usage,
      'add --yes to confirm, or --downloads to drop only the downloads',
    )
  }
  await rm(dir, { recursive: true, force: true })
  status(`removed ${dir} (${saves} save file(s))`)
  status(await removeDownloads(downloads, config.games[game]!.steamAppId))
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

async function clone(args: ParsedArgs, config: RootConfig): Promise<number> {
  const game = requireGame(args, config)
  const [src, dst] = args.rest
  if (src === undefined || dst === undefined) {
    throw new GamecrateError('clone needs a source and a destination profile', Exit.Usage)
  }
  for (const name of [src, dst]) {
    if (!NAME_PATTERN.test(name)) throw new GamecrateError(`${name} is not a valid profile name`, Exit.Usage)
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
    emit('data', `${JSON.stringify(runs, null, 2)}\n`)
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
    emit('data', `${row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()}\n`)
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
      `run: gamecrate stop ${profile}`,
    )
  }
  if (record === 'absent') {
    throw new GamecrateError(`no run recorded for ${game} ${profile}`, Exit.Usage, dir)
  }

  if (args.json) emit('data', `${JSON.stringify(record)}\n`)
  else status(`${game} ${profile}: ${record.reason} (${record.code})`)
  return record.code
}

async function build(args: ParsedArgs, config: RootConfig, defaults: ProjectDefaults): Promise<number> {
  const game = requireGame(args, config)
  const gameConfig = gameForImage(args, config, defaults, game)
  await acquireImage(game, gameConfig, args.pull ?? 'always')
  status(`${gameConfig.image.ref} is ready`)
  return Exit.Ok
}

async function configEdit(): Promise<number> {
  const existing = await findGlobalConfig()
  const path = existing ?? join(globalConfigDir(), 'config.yml')
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

async function repairOwnership(
  found: string[],
  identity: Identity,
): Promise<{ fixed: number; stuck: string[] }> {
  let fixed = 0
  const stuck: string[] = []
  for (const path of found) {
    const chowned = await lchown(path, identity.uid, identity.gid).then(
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
  return { fixed, stuck }
}

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
    for (const path of found) emit('data', `would chown ${identity.uid}:${identity.gid} ${path}\n`)
    status(`${found.length} foreign-owned path(s); re-run with --yes to chown them`)
    return Exit.Environment
  }
  const { fixed, stuck } = await repairOwnership(found, identity)

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

async function removeIfEmptyDir(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) return false
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

function reportFatal(error: unknown): number {
  if (error instanceof GamecrateError) {
    emit('status', `gamecrate: ${error.message}\n`)
    if (error.detail) emit('status', `${error.detail}\n`)
    return error.code
  }
  emit('status', `gamecrate: ${describe(error)}\n`)
  return Exit.GameFailed
}

try {
  process.exit(await main(process.argv.slice(2)))
} catch (error) {
  process.exit(reportFatal(error))
}
