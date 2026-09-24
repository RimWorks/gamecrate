import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ImageFacts } from '../launch/image'
import { imageLaunch, imageProblem, markerProblem, readImageFacts } from '../launch/image'
import type { LaunchPlan, Problem } from '../types'
import { GamecrateError } from '../types'
import { resolveIdentity } from './identity'
import { capture } from './run'
import { buildRunSpec, refuseProtonHeaded, waylandSocket, x11Session } from './spec'

const CDI_SPEC = '/etc/cdi/nvidia.yaml'

/** Every check the launch depends on, collected so one run reports all of them at once. */
export async function preflight(plan: LaunchPlan): Promise<Problem[]> {
  const problems: Problem[] = []
  const game = plan.gameConfig

  const dockerOk = await checkDocker(problems)
  if (dockerOk) {
    await checkImage(plan, problems)
  }

  if (plan.settings.gpu) checkCdi(problems)
  checkGameDir(plan, problems)
  checkBindSources(plan, problems)
  if (plan.mode === 'headed') checkDisplay(plan, problems)

  if (game.gameFiles.source === 'image' && game.image.acquire === 'build' && !game.image.context) {
    problems.push({
      where: `/games/${plan.game}/image/context`,
      message: 'image.acquire is "build" but no build context is configured',
    })
  }

  return problems
}

async function checkDocker(problems: Problem[]): Promise<boolean> {
  const result = await capture(['docker', 'version', '--format', '{{.Server.Version}}'])
  if (result.code === 0) return true

  problems.push({
    where: 'docker',
    message: `docker is not reachable: ${firstLine(result.stderr) || exitCode(result.code)}`,
    suggestion: 'start the docker daemon, or check that your user is in the docker group',
  })
  return false
}

/**
 * `docker image inspect` succeeds on an image whose layers are missing from the content
 * store, so presence is not runnability. Actually starting it is the only honest check.
 */
async function checkImageRunnable(
  ref: string,
  where: string,
  game: string,
  problems: Problem[],
): Promise<void> {
  const run = await capture(['docker', 'run', '--rm', '--entrypoint', '/bin/true', ref])
  if (run.code === 0) return

  const err = firstLine(run.stderr)
  const corrupt = /content store|failed to extract layer|not found/i.test(run.stderr)
  problems.push({
    where,
    message: corrupt
      ? `image ${ref} is present but unrunnable; its layers are missing from the content store`
      : `image ${ref} is present but failed to start: ${err || exitCode(run.code)}`,
    suggestion: corrupt
      ? `docker image rm ${ref} && docker builder prune -f, then gamecrate build ${game}`
      : undefined,
  })
}

async function checkImage(plan: LaunchPlan, problems: Problem[]): Promise<void> {
  const image = plan.gameConfig.image
  const where = `/games/${plan.game}/image/ref`

  const facts = await readImageFacts(image.ref)
  const problem = imageProblem({ game: plan.game, ref: image.ref, mode: plan.mode, facts })

  if (facts.present) {
    await checkImageRunnable(image.ref, where, plan.game, problems)
    if (problem) problems.push(problem)
    // same order execute() uses: a marker-first answer asks for a flag the person then has to
    // keep while they fix the mode, which is the real problem.
    const mode = protonHeadedProblem(plan, facts, where)
    if (mode) {
      problems.push(mode)
      return
    }
    // a missing marker is a precondition like any other, and finding it here beats finding it
    // after buildLocalMods has spent minutes compiling assemblies.
    const marker = markerProblem({ game: plan.game, facts, marker: plan.marker })
    if (marker) problems.push(marker)
    return
  }

  if (image.ref.trim() === '') {
    if (problem) problems.push(problem)
    return
  }

  if (image.acquire === 'build') {
    problems.push({
      where,
      message: `image ${image.ref} is not present locally`,
      suggestion: `gamecrate build ${plan.game}`,
    })
    return
  }

  const remote = await capture(['docker', 'manifest', 'inspect', image.ref])
  if (remote.code === 0) return

  const host = registryHost(image.ref)
  if (host && needsLogin(remote.stderr) && !hasStoredAuth(host)) {
    problems.push({
      where,
      message: `not authenticated to ${host}, so ${image.ref} cannot be pulled`,
      suggestion: `docker login ${host}, or gamecrate steam build ${plan.game} to make it locally`,
    })
    return
  }

  if (problem) {
    problems.push({
      ...problem,
      message: `${problem.message}: ${firstLine(remote.stderr) || exitCode(remote.code)}`,
    })
  }
}

/** refuseProtonHeaded throws and preflight collects, so catching it keeps one copy of the text. */
function protonHeadedProblem(plan: LaunchPlan, facts: ImageFacts, where: string): Problem | null {
  try {
    refuseProtonHeaded(plan.game, plan.mode, imageLaunch(facts))
    return null
  } catch (error) {
    if (!(error instanceof GamecrateError)) throw error
    return { where, message: error.message, suggestion: error.detail }
  }
}

/** A headed run with no display server opens nothing and reports no error of its own. */
function checkDisplay(plan: LaunchPlan, problems: Problem[]): void {
  if (plan.settings.display === 'x11') {
    if (x11Session()) return
    problems.push({
      where: 'DISPLAY',
      message: 'DISPLAY is not set; a headed X11 launch would open nothing',
      suggestion: 'set settings.display to "wayland", or use --mode headless',
    })
    return
  }

  if (waylandSocket()) return
  problems.push({
    where: 'WAYLAND_DISPLAY',
    message: 'no wayland socket found; a headed launch would open a blank window',
    suggestion: 'run from a wayland session, or use --mode headless',
  })
}

/** Docker's own failure here is "could not select device driver", which names nothing useful. */
function checkCdi(problems: Problem[]): void {
  if (!existsSync(CDI_SPEC)) {
    problems.push({
      where: CDI_SPEC,
      message: 'no CDI spec, so --device nvidia.com/gpu=all cannot resolve',
      suggestion: 'sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml',
    })
    return
  }

  let text = ''
  try {
    text = readFileSync(CDI_SPEC, 'utf8')
  } catch (error) {
    problems.push({ where: CDI_SPEC, message: `CDI spec is unreadable: ${message(error)}` })
    return
  }

  if (!/^[ \t]*(?:-[ \t]*)?name:[ \t]*["']?all["']?[ \t]*$/m.test(text)) {
    problems.push({
      where: CDI_SPEC,
      message: 'CDI spec does not declare a device named "all"',
      suggestion: 'sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml',
    })
  }
}

function checkGameDir(plan: LaunchPlan, problems: Problem[]): void {
  const files = plan.gameConfig.gameFiles
  if (files.source !== 'mount') return

  const where = `/games/${plan.game}/gameFiles/host`
  if (!files.host) {
    problems.push({ where, message: 'gameFiles.source is "mount" but no host path is set' })
    return
  }
  if (!existsSync(files.host)) {
    problems.push({ where, message: `game directory does not exist: ${files.host}` })
    return
  }

  const executable = join(files.host, basename(plan.gameConfig.executable))
  if (!existsSync(executable)) {
    problems.push({
      where,
      message: `${files.host} does not contain ${basename(plan.gameConfig.executable)}`,
      suggestion: 'point gameFiles.host at the install directory, not its parent',
    })
  }
}

function checkBindSources(plan: LaunchPlan, problems: Problem[]): void {
  let mounts
  try {
    mounts = buildRunSpec(plan, [], resolveIdentity(false)).mounts
  } catch (error) {
    problems.push({
      where: `/games/${plan.game}`,
      message: error instanceof GamecrateError ? error.message : message(error),
      suggestion: error instanceof GamecrateError ? error.detail : undefined,
    })
    return
  }

  for (const mount of mounts) {
    if (mount.type !== 'bind' || !mount.source) continue
    if (existsSync(mount.source)) continue
    // The profile tree is the tool's own output; ensureProfileTree creates it before docker runs.
    if (mount.source.startsWith(plan.profileDir)) continue
    problems.push({
      where: mount.source,
      message: `bind source does not exist and would be mounted at ${mount.target}`,
    })
  }
}

function registryHost(ref: string): string | null {
  const first = ref.split('/')[0]
  if (!first || !ref.includes('/')) return null
  if (first === 'localhost' || first.includes('.') || first.includes(':')) return first
  return null
}

function needsLogin(stderr: string): boolean {
  return /unauthorized|authentication required|denied|forbidden/i.test(stderr)
}

function hasStoredAuth(host: string): boolean {
  const path = join(process.env.DOCKER_CONFIG ?? join(homedir(), '.docker'), 'config.json')
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      auths?: Record<string, unknown>
      credsStore?: string
      credHelpers?: Record<string, string>
    }
    if (config.credsStore || config.credHelpers?.[host]) return true
    return Object.keys(config.auths ?? {}).some((key) => key === host || key.includes(`//${host}`))
  } catch {
    return false
  }
}

function exitCode(code: number): string {
  return `exit ${code}`
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
