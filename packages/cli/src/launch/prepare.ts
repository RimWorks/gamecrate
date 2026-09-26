import { existsSync, readFileSync } from 'node:fs'
import { open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { forwardOutput, status } from '../cli/output'
import { capture, exited, spawnArgv, stopContainer, STOP_TIMEOUT_SECONDS } from '../docker/run'
import { containerName, CONTAINER_LOG_DIR } from '../docker/spec'
import { GamecrateError, Exit } from '../types'
import type { BuildPolicy, GameConfig, LaunchPlan, PullPolicy } from '../types'

async function inherit(argv: string[]): Promise<number> {
  const proc = spawnArgv(argv, ['ignore', 'pipe', 'pipe'])
  const code = exited(proc)
  await Promise.all([
    forwardOutput(proc.stdout!, process.stdout),
    forwardOutput(proc.stderr!, process.stderr),
  ])
  return code
}

/** Resolved image id, so `launches.jsonl` records what actually ran, not a floating tag. */
export async function imageDigest(ref: string): Promise<string | null> {
  const { code, stdout } = await capture(['docker', 'image', 'inspect', '--format', '{{.Id}}', ref])
  const id = stdout.trim()
  return code === 0 && id.length > 0 ? id : null
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

/** A mod builds when it has a .csproj/.slnx and the policy asks for it. */
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

/**
 * Builds local mods before launch. `always` builds every local mod; `auto` builds only the
 * ones resolution flagged stale; `never` skips. A build failure stops the launch, shipping
 * the previous DLL after a failed compile is how you debug code that is not running.
 */
export async function buildLocalMods(
  plan: LaunchPlan,
  policy: BuildPolicy,
  refsNote?: string,
): Promise<void> {
  if (policy === 'never') return

  const wanted = plan.mods.filter(
    (m) => m.kind === 'local' && (policy === 'always' || m.stale === true),
  )
  if (wanted.length === 0) return

  // every mod is built before any failure is raised: stopping at the first leaves the state of
  // the rest unknown, and one unported mod then reads as the whole set being broken
  const failed: string[] = []
  for (const mod of wanted) {
    const target = await buildTarget(mod.hostDir)
    if (target === null) continue
    const code = await inherit(['dotnet', 'build', target, '-v', 'quiet', '--nologo'])
    if (code !== 0) {
      failed.push(`${mod.packageId}  ${target}`)
      continue
    }
    mod.stale = false
    // The launch warning is derived from this, so clearing it is what silences the warning.
    delete mod.staleReport
  }
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

  // A container outlives a launcher that was killed, which leaves the lock stale and the
  // game still up. Every teardown path here is keyed on the container name, so the second
  // run would stop the first run's container instead of its own.
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

/** Unlinks only while the lock still names the holder we expect. */
// residual: read and unlink are two syscalls, so a lock taken between them is still lost
async function unlinkHeld(path: string, pid: number, startedAt?: string): Promise<void> {
  const held = await readLock(path)
  if (held === undefined) return
  if (held.pid !== pid) return
  if (startedAt !== undefined && held.startedAt !== startedAt) return
  await unlink(path).catch(() => {})
}

/** The parent wrote this lock with the child's pid, so the child only has to drop it. */
// carries unlinkHeld's residual, and nothing avoids it: this has to ask whose lock it is
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
/** After its own docker stop the holder still has to write an exit record and unlink. */
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
 * Signals the supervisor, not the container. runContainer turns SIGTERM into a docker stop and
 * returns 130, so the run records itself as stopped rather than crashed. Only a run whose
 * supervisor is already gone gets the container stopped out from under it.
 */
export async function stopRun(record: LockRecord, lockFile: string): Promise<StopOutcome> {
  let signalled = false
  if (isRunning(record.pid, record.startedAt)) {
    try {
      process.kill(record.pid, 'SIGTERM')
      signalled = true
    } catch {
      // it exited between the liveness check and the signal
    }
  }

  if (!signalled) await stopContainer(record.container, STOP_TIMEOUT_SECONDS)

  const deadline = Date.now() + STOP_RELEASE_WAIT_MS
  while (existsSync(lockFile)) {
    const held = await readLock(lockFile)
    if (held === undefined) break
    // an orphan, and only ours to clear: another dead record is some other run's orphan
    if (!isRunning(held.pid, held.startedAt)) {
      await unlinkHeld(lockFile, record.pid, record.startedAt)
      break
    }
    // Out of budget with the holder still alive. Unlinking here deletes a lock it is about to
    // release, and then its own release deletes whatever the next launcher took in between.
    if (Date.now() >= deadline) return 'held'
    await sleep(RELEASE_POLL_MS)
  }
  // no unlink: every path out either released its own lock or already cleared what was ours,
  // and one here deleted whatever a new launcher took in the gap
  return signalled ? 'signalled' : 'orphaned'
}

/**
 * `--replace`: ends the run for this profile and instance only, so a parallel worktree run is
 * untouched. Goes through stopRun so the replaced run reports `stopped`; a raw docker stop
 * would land as 137 instead.
 */
export async function replacePrevious(plan: LaunchPlan): Promise<void> {
  const name = containerName(plan)
  const path = lockPath(plan)
  const up = await capture(['docker', 'ps', '--quiet', '--filter', `name=^${name}$`])
  const running = up.stdout.trim().length > 0
  const held = await readLock(path)
  if (!running && held === undefined && !existsSync(path)) return

  if (held !== undefined) {
    // the lock names what stopRun will act on; `name` is only what this launch would have called it
    status(`stopping ${held.container}`)
    await stopRun(held, path)
    return
  }

  // a container with no lock: nothing to signal, so the container itself is all there is
  if (running) {
    status(`stopping ${name}`)
    await stopContainer(name, STOP_TIMEOUT_SECONDS)
  }
}

// ponytail: node does not expose sysconf(_SC_CLK_TCK) and it is 100 on every mainstream
// linux, shell out to `getconf CLK_TCK` if one ever disagrees
const CLOCK_TICKS_PER_SECOND = 100
/** clock granularity, so a lock written in the same second as its process is not rejected. */
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
  // a process that began after the lock was written cannot be the one that wrote it
  return began === undefined || began <= written + START_TIME_SLACK_MS
}

/** Epoch ms the process began, or undefined wherever procfs is missing or unreadable. */
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
  const name = `${plan.game}.png`
  const target = `${CONTAINER_LOG_DIR}/${name}`
  // xvfb-run -a chooses the display number, so discover it from the socket rather than
  // assuming :99. There is exactly one X server in the container.
  const script =
    'D=":$(ls /tmp/.X11-unix 2>/dev/null | head -1 | tr -d X)";' +
    ' [ "$D" = ":" ] && { echo "no X socket in the container" >&2; exit 1; };' +
    // xvfb-run keeps the display's cookie in its own temp dir and exports XAUTHORITY only to
    // its child. docker exec is not that child, so without this every client is refused.
    ' X=$(ls -d /tmp/xvfb-run.*/Xauthority 2>/dev/null | head -1);' +
    ' [ -n "$X" ] && export XAUTHORITY="$X";' +
    // ImageMagick 6 calls it convert, 7 calls it magick. both runtime bases are ubuntu 24.04,
    // which ships 6, but someone can point gamecrate at a base with 7.
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
