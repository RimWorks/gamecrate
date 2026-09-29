import { existsSync, readFileSync } from 'node:fs'
import { open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { forwardOutput, runTimestamp, status } from '../cli/output'
import type { TaskState } from '../cli/taskboard'
import { capture, exited, spawnArgv, stopContainer, STOP_TIMEOUT_SECONDS } from '../docker/run'
import { containerName, CONTAINER_LOG_DIR } from '../docker/spec'
import { GamecrateError, Exit } from '../types'
import type { BuildPolicy, GameConfig, LaunchPlan, PullPolicy, ResolvedMod } from '../types'

const DEFAULT_BUILD_CONCURRENCY = 3

async function inherit(argv: string[]): Promise<number> {
  const proc = spawnArgv(argv, ['ignore', 'pipe', 'pipe'])
  const [, , code] = await Promise.all([
    forwardOutput(proc.stdout!, 'game'),
    forwardOutput(proc.stderr!, 'gameError'),
    exited(proc),
  ])
  return code
}

/** Resolved image id, so `launches.jsonl` records what actually ran, not a floating tag. */
export async function imageDigest(ref: string): Promise<string | null> {
  const { code, stdout } = await capture(['docker', 'image', 'inspect', '--format', '{{.Id}}', ref])
  const id = stdout.trim()
  return code === 0 && id.length > 0 ? id : null
}

/**
 * The registry digest a local image was pulled at. `.Id` is the config digest and is a different
 * number, so comparing it against a recorded manifest digest never matches.
 */
export async function repoDigest(ref: string): Promise<string | null> {
  const format = '{{range .RepoDigests}}{{.}}{{break}}{{end}}'
  const { code, stdout } = await capture(['docker', 'image', 'inspect', '--format', format, ref])
  const at = stdout.trim().lastIndexOf('@')
  return code === 0 && at !== -1 ? stdout.trim().slice(at + 1) : null
}

/** One file out of an image, for a fact the host copy would answer wrongly. */
export async function readFromImage(ref: string, path: string): Promise<string | null> {
  const { code, stdout } = await capture(['docker', 'run', '--rm', '--entrypoint', 'cat', ref, path])
  return code === 0 ? stdout : null
}

/** One label off an image, or null when the image or the label is missing. */
export async function imageLabel(ref: string, label: string): Promise<string | null> {
  const format = `{{index .Config.Labels "${label}"}}`
  const { code, stdout } = await capture(['docker', 'image', 'inspect', '--format', format, ref])
  const value = stdout.trim()
  if (code !== 0 || value.length === 0 || value === '<no value>') return null
  return value
}

/**
 * Pulls or builds per policy. Shared by the `build` subcommand and `run`, so a launch can no
 * longer proceed against an image the user asked to refresh.
 */
export async function acquireImage(
  game: string,
  config: GameConfig,
  pull: PullPolicy,
): Promise<void> {
  const { image } = config
  const present = (await imageDigest(image.ref)) !== null

  if (image.acquire === 'build') return await buildImage(game, image, present, pull)

  if (pull === 'never') {
    if (present) return
    throw new GamecrateError(`--pull never but ${image.ref} is not present locally`, Exit.Environment)
  }
  if (pull === 'missing' && present) return

  if ((await inherit(['docker', 'pull', image.ref])) !== 0) {
    if (present) return
    throw new GamecrateError(`docker pull failed for ${image.ref}`, Exit.Environment)
  }
}

async function buildImage(
  game: string,
  image: GameConfig['image'],
  present: boolean,
  pull: PullPolicy,
): Promise<void> {
  if (image.context === undefined) {
    throw new GamecrateError(`${game} has image.acquire "build" but no context`, Exit.Config)
  }
  if (present && pull !== 'always') return
  if ((await inherit(['docker', 'build', '--tag', image.ref, image.context])) !== 0) {
    throw new GamecrateError(`docker build failed for ${image.ref}`, Exit.Environment)
  }
}

async function buildTarget(dir: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const slnx = entries.find((e) => e.endsWith('.slnx'))
  if (slnx) return join(dir, slnx)
  const csproj = entries.find((e) => e.endsWith('.csproj'))
  return csproj ? join(dir, csproj) : null
}

export interface BuildHooks {
  onPlan(tasks: readonly { id: string; label: string }[]): void
  onCell(id: string, patch: { state: TaskState; detail?: string }): void
}

/**
 * Builds local mods before launch. `always` builds every local mod; `auto` builds only the
 * ones resolution flagged stale; `never` skips.
 */
export async function buildLocalMods(
  plan: LaunchPlan,
  policy: BuildPolicy,
  refsNote?: string,
  hooks?: BuildHooks,
): Promise<void> {
  if (policy === 'never') return

  const wanted = plan.mods.filter(
    (m) => m.kind === 'local' && (policy === 'always' || m.stale === true),
  )
  if (wanted.length === 0) return

  const targets: { mod: ResolvedMod; target: string }[] = []
  for (const mod of wanted) {
    const target = await buildTarget(mod.hostDir)
    if (target !== null) targets.push({ mod, target })
  }
  if (targets.length === 0) return
  hooks?.onPlan(targets.map(({ mod }) => ({ id: mod.packageId, label: mod.packageId })))

  const failed: string[] = []
  const queue = [...targets]
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift()
      if (next === undefined) return
      const { mod, target } = next
      hooks?.onCell(mod.packageId, { state: 'running', detail: 'dotnet build' })
      const code = await inherit(['dotnet', 'build', target, '-v', 'quiet', '--nologo'])
      if (code !== 0) {
        failed.push(`${mod.packageId}  ${target}`)
        hooks?.onCell(mod.packageId, { state: 'failed', detail: `exit ${code}` })
        continue
      }
      hooks?.onCell(mod.packageId, { state: 'done', detail: '' })
      mod.stale = false
      delete mod.staleReport
    }
  }
  const lanes = Math.max(1, Math.min(plan.buildConcurrency ?? DEFAULT_BUILD_CONCURRENCY, targets.length))
  await Promise.all(Array.from({ length: lanes }, worker))
  if (failed.length === 0) return

  const what = failed.length === 1 ? failed[0]!.split('  ')[0] : `${failed.length} mods`
  throw new GamecrateError(
    `dotnet build failed for ${what}`,
    Exit.Environment,
    [...failed, refsNote].filter((part) => part !== undefined).join('\n'),
  )
}

/**
 * Per-instance launch lock. Two concurrent runs would both `rm -rf` the same stage tree, so
 * the second is refused rather than allowed to race. Separate instances never meet here.
 */
export interface ProfileLock {
  release: () => Promise<void>
}

/**
 * Refuses when this profile and instance are already up, and clears a lock whose holder is
 * gone. Detach runs this before it forks, so a stale lock cannot strand the child.
 */
export async function clearLock(plan: LaunchPlan): Promise<void> {
  const path = lockPath(plan)
  const what = plan.instance === undefined ? plan.profile : `${plan.profile} (${plan.instance})`

  const name = containerName(plan)
  const up = await capture(['docker', 'ps', '--quiet', '--filter', `name=^${name}$`])
  if (up.stdout.trim().length > 0) {
    throw new GamecrateError(
      `${plan.game} ${what} is already running (container ${name})`,
      Exit.Refused,
      `stop it with: docker stop ${name}\nor relaunch with --replace`,
    )
  }

  const held = await readLock(path)
  if (held !== undefined && isRunning(held.pid, held.startedAt)) {
    throw new GamecrateError(
      `${plan.game} ${what} is already running (pid ${held.pid})`,
      Exit.Refused,
      `if that is wrong, delete ${path}\nor relaunch with --replace`,
    )
  }
  if (existsSync(path)) await unlink(path).catch(() => {})
}

async function unlinkHeld(path: string, pid: number, startedAt?: string): Promise<void> {
  const held = await readLock(path)
  if (held === undefined) return
  if (held.pid !== pid) return
  if (startedAt !== undefined && held.startedAt !== startedAt) return
  await unlink(path).catch(() => {})
}

export function heldLock(plan: LaunchPlan): ProfileLock {
  const path = lockPath(plan)
  return {
    release: async () => {
      await unlinkHeld(path, process.pid)
    },
  }
}

export async function takeLock(plan: LaunchPlan): Promise<ProfileLock> {
  await clearLock(plan)
  await writeLock(plan, {
    pid: process.pid,
    container: containerName(plan),
    game: plan.game,
    profile: plan.profile,
    ...(plan.instance === undefined ? {} : { instance: plan.instance }),
    detached: false,
    mode: plan.mode,
  })
  return heldLock(plan)
}

/** Everything ps, stop, attach and wait need about a run, without reopening the container. */
export interface LockRecord {
  pid: number
  container: string
  game: string
  profile: string
  instance?: string
  detached: boolean
  mode?: string
  startedAt: string
}

export function lockPath(plan: LaunchPlan): string {
  return join(plan.instanceDir, '.gamecrate', 'lock')
}

export async function readLock(path: string): Promise<LockRecord | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as LockRecord
    return Number.isInteger(value?.pid) && value.pid > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** wx fails rather than truncating, which is what makes this a lock and not a note. */
export async function writeLock(
  plan: LaunchPlan,
  record: Omit<LockRecord, 'startedAt'>,
): Promise<void> {
  const path = lockPath(plan)
  const handle = await open(path, 'wx').catch(() => null)
  if (handle === null) {
    throw new GamecrateError(`could not take the launch lock at ${path}`, Exit.Environment)
  }
  await handle.writeFile(JSON.stringify({ ...record, startedAt: new Date().toISOString() }))
  await handle.close()
}

const RELEASE_POLL_MS = 100
const DRAIN_ALLOWANCE_MS = 10_000

/**
 * A signalled supervisor cannot finish before its own `docker stop --timeout` does, so the
 * budget is derived from that rather than guessed alongside it.
 */
export const STOP_RELEASE_WAIT_MS = STOP_TIMEOUT_SECONDS * 1000 + DRAIN_ALLOWANCE_MS

/**
 * What stopRun did, because "the supervisor took the signal" and "the lock was stale anyway"
 * are not the same answer and the caller has to say which one it is.
 */
export type StopOutcome = 'signalled' | 'orphaned' | 'held'

/**
 * Signals the supervisor, not the container. Only a run whose supervisor is already gone gets
 * the container stopped out from under it.
 */
export async function stopRun(record: LockRecord, lockFile: string): Promise<StopOutcome> {
  let signalled = false
  if (isRunning(record.pid, record.startedAt)) {
    try {
      process.kill(record.pid, 'SIGTERM')
      signalled = true
    } catch {
    }
  }

  if (!signalled) await stopContainer(record.container, STOP_TIMEOUT_SECONDS)

  const deadline = Date.now() + STOP_RELEASE_WAIT_MS
  while (existsSync(lockFile)) {
    const held = await readLock(lockFile)
    if (held === undefined) break
    if (!isRunning(held.pid, held.startedAt)) {
      await unlinkHeld(lockFile, record.pid, record.startedAt)
      break
    }
    if (Date.now() >= deadline) return 'held'
    await sleep(RELEASE_POLL_MS)
  }
  // no unlink: a new launcher may already hold this lock
  return signalled ? 'signalled' : 'orphaned'
}

/**
 * `--replace`: ends the run for this profile and instance only, so a parallel worktree run is
 * untouched.
 */
export async function replacePrevious(plan: LaunchPlan): Promise<void> {
  const name = containerName(plan)
  const path = lockPath(plan)
  const up = await capture(['docker', 'ps', '--quiet', '--filter', `name=^${name}$`])
  const running = up.stdout.trim().length > 0
  const held = await readLock(path)
  if (!running && held === undefined && !existsSync(path)) return

  if (held !== undefined) {
    status(`stopping ${held.container}`)
    await stopRun(held, path)
    return
  }

  if (running) {
    status(`stopping ${name}`)
    await stopContainer(name, STOP_TIMEOUT_SECONDS)
  }
}

// TODO(clktck): node has no sysconf(_SC_CLK_TCK); shell out to getconf CLK_TCK if a machine disagrees
const CLOCK_TICKS_PER_SECOND = 100
const START_TIME_SLACK_MS = 2000

/**
 * A pid alone is not proof. Detach leaves a long-lived process per run, so a recycled number
 * would refuse every future launch and give ps a ghost with an invented uptime.
 */
export function isRunning(pid: number, startedAt?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (startedAt === undefined) return true
  const written = Date.parse(startedAt)
  if (Number.isNaN(written)) return true
  const began = processStart(pid)
  return began === undefined || began <= written + START_TIME_SLACK_MS
}

function processStart(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm can hold spaces and parens, so fields are counted from after the last one
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // field 22 overall is starttime, in clock ticks since boot; state is field 3
    const ticks = Number(fields[19])
    const boot = bootTime()
    if (!Number.isFinite(ticks) || boot === undefined) return undefined
    return boot + (ticks / CLOCK_TICKS_PER_SECOND) * 1000
  } catch {
    return undefined
  }
}

function bootTime(): number | undefined {
  const line = readFileSync('/proc/stat', 'utf8')
    .split('\n')
    .find((each) => each.startsWith('btime '))
  const seconds = Number(line?.slice('btime '.length))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/**
 * Grabs one frame from inside the running container. The run dir is already bind-mounted at
 * CONTAINER_LOG_DIR, so the png lands next to that run's logs with no extra mount.
 */
export async function captureScreenshot(container: string, plan: LaunchPlan): Promise<string | null> {
  const name = `${plan.game}-${runTimestamp()}.png`
  const target = `${CONTAINER_LOG_DIR}/${name}`
  const script =
    'D=":$(ls /tmp/.X11-unix 2>/dev/null | head -1 | tr -d X)";' +
    ' [ "$D" = ":" ] && { echo "no X socket in the container" >&2; exit 1; };' +
    ' X=$(ls -d /tmp/xvfb-run.*/Xauthority 2>/dev/null | head -1);' +
    ' [ -n "$X" ] && export XAUTHORITY="$X";' +
    // ImageMagick 6 calls it convert, 7 calls it magick
    ' M=$(command -v magick || command -v convert);' +
    ' [ -z "$M" ] && { echo "no imagemagick in the container" >&2; exit 1; };' +
    ` import -display "$D" -window root ${target} 2>/dev/null` +
    ` || xwd -root -display "$D" | "$M" xwd:- ${target}`

  const code = await inherit(['docker', 'exec', container, 'sh', '-c', script])
  const host = join(plan.runDirHost, name)
  if (code !== 0 || !existsSync(host)) return null
  return host
}

export async function writeLaunchRecord(plan: LaunchPlan, image: string): Promise<void> {
  const digest = await imageDigest(image)
  const line = JSON.stringify({
    at: new Date().toISOString(),
    game: plan.game,
    profile: plan.profile,
    ...(plan.instance === undefined ? {} : { instance: plan.instance }),
    image,
    digest,
    mode: plan.mode,
    mods: plan.mods.map((m) => ({
      packageId: m.packageId,
      hostDir: m.hostDir,
      ...(m.worktree === undefined ? {} : { worktree: m.worktree }),
    })),
  })
  const path = join(plan.instanceDir, '.gamecrate', 'launches.jsonl')
  await writeFile(path, `${line}\n`, { flag: 'a' })
}
