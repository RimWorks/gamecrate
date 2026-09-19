import { existsSync, readFileSync } from 'node:fs'
import { open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { forwardOutput, status } from '../cli/output'
import { capture, exited, spawnArgv, stopContainer } from '../docker/run'
import { containerName, CONTAINER_LOG_DIR } from '../docker/spec'
import { GamecrateError, Exit } from '../types'
import type { BuildPolicy, GameConfig, LaunchPlan, PullPolicy } from '../types'

async function inherit(argv: string[], stdin?: Uint8Array): Promise<number> {
  const proc = spawnArgv(argv, [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'])
  const code = exited(proc)
  if (stdin !== undefined) {
    // A child that never reads, or never started, must surface as its exit code, not a throw.
    proc.stdin!.on('error', () => {})
    proc.stdin!.end(stdin)
  }
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

/** One label off an image, or null when the image or the label is missing. */
async function imageLabel(ref: string, label: string): Promise<string | null> {
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

  if (image.acquire === 'build') {
    if (image.context === undefined) {
      throw new GamecrateError(`${game} has image.acquire "build" but no context`, Exit.Config)
    }
    if (present && pull !== 'always') return
    if ((await inherit(['docker', 'build', '--tag', image.ref, image.context])) !== 0) {
      throw new GamecrateError(`docker build failed for ${image.ref}`, Exit.Environment)
    }
    return
  }

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

/**
 * Packages headless and screenshot modes need. Neither game's published image ships them,
 * and they live in two repos with different publish flows, so gamecrate adds them itself
 * rather than making a third game mean editing a third repo.
 */
const RUNTIME_PACKAGES = ['xorg-server-xvfb', 'xorg-xwd', 'imagemagick', 'mesa', 'ttf-dejavu']
const RUNTIME_SUFFIX = '-gamecrate'
const BASE_LABEL = 'gamecrate.base'

/**
 * Tag for the derived image, keeping the registry path readable. A tag only exists after the
 * last `/`: before it a colon is a registry port, and an `@` means a digest no suffix can ride.
 */
export function runtimeLayerRef(ref: string): string {
  const at = ref.indexOf('@')
  const head = at > 0 ? ref.slice(0, at) : ref
  const colon = head.lastIndexOf(':')
  const tagged = colon > head.lastIndexOf('/')
  const name = tagged ? head.slice(0, colon) : head
  if (at > 0) {
    // `name:tag@sha256:...` is legal, and the tag has to go: two tags is not a ref docker takes.
    const digest = ref.slice(at + 1)
    const hex = digest.slice(digest.indexOf(':') + 1)
    return `${name}:sha-${hex.slice(0, 12)}${RUNTIME_SUFFIX}`
  }
  return `${name}:${tagged ? head.slice(colon + 1) : 'latest'}${RUNTIME_SUFFIX}`
}

/**
 * Builds (once) a thin layer over the adapter's image carrying an X server and imagemagick.
 * Detects the package manager so a debian-based game image works the same as an Arch one.
 */
export async function ensureRuntimeLayer(ref: string): Promise<string> {
  const derived = runtimeLayerRef(ref)
  const base = await imageDigest(ref)

  // Keyed on the base image id, not just presence: this layer used to be built once and kept
  // forever, so a rebuilt base left it months stale with none of the base's newer binaries.
  if (base !== null && (await imageLabel(derived, BASE_LABEL)) === base) return derived

  const pacman = `pacman -Syu --noconfirm --needed ${RUNTIME_PACKAGES.join(' ')} && pacman -Scc --noconfirm`
  const apt =
    'apt-get update && apt-get install -y --no-install-recommends' +
    ' xvfb x11-apps imagemagick libgl1-mesa-dri fonts-dejavu && rm -rf /var/lib/apt/lists/*'
  // One line per RUN: shell continuations inside a heredoc-fed Dockerfile are a quoting trap.
  const install =
    `if command -v pacman >/dev/null 2>&1; then ${pacman};` +
    ` elif command -v apt-get >/dev/null 2>&1; then ${apt};` +
    ' else echo "no supported package manager in the base image" >&2; exit 1; fi'

  const dockerfile = [
    `FROM ${ref}`,
    'USER root',
    `RUN ${install}`,
    'RUN command -v xvfb-run && command -v Xvfb',
    `LABEL ${BASE_LABEL}=${base}`,
  ].join('\n')

  const code = await inherit(
    ['docker', 'build', '--tag', derived, '-f', '-', '.'],
    new TextEncoder().encode(dockerfile),
  )
  if (code !== 0) {
    throw new GamecrateError(
      `could not build the offscreen runtime layer ${derived}`,
      Exit.Environment,
      'headless and screenshot modes need an X server in the image',
    )
  }
  return derived
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
 * ones resolution flagged stale; `never` skips. A build failure stops the launch — shipping
 * the previous DLL after a failed compile is how you debug code that is not running.
 */
export async function buildLocalMods(plan: LaunchPlan, policy: BuildPolicy): Promise<void> {
  if (policy === 'never') return

  const wanted = plan.mods.filter(
    (m) => m.kind === 'local' && (policy === 'always' || m.stale === true),
  )
  if (wanted.length === 0) return

  for (const mod of wanted) {
    const target = await buildTarget(mod.hostDir)
    if (target === null) continue
    const code = await inherit(['dotnet', 'build', target, '-v', 'quiet', '--nologo'])
    if (code !== 0) {
      throw new GamecrateError(
        `dotnet build failed for ${mod.packageId}`,
        Exit.Environment,
        target,
      )
    }
    mod.stale = false
    // The launch warning is derived from this, so clearing it is what silences the warning.
    delete mod.staleReport
  }
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

/** The supervisor's lock was written by the parent that forked it; it only has to drop it. */
export function heldLock(plan: LaunchPlan): ProfileLock {
  const path = lockPath(plan)
  return {
    release: async () => {
      await unlink(path).catch(() => {})
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

/** How long to let the holder notice its container died and drop the lock on its own. */
const RELEASE_WAIT_MS = 10_000
const RELEASE_POLL_MS = 100
const REPLACE_STOP_TIMEOUT_SECONDS = 10

/**
 * `--replace`: stops the container for this profile and instance only, so a parallel worktree
 * run is untouched. Waits for the holder to release before forcing, because its own release
 * would otherwise unlink the lock we are about to take.
 */
export async function replacePrevious(plan: LaunchPlan): Promise<void> {
  const name = containerName(plan)
  const path = lockPath(plan)
  const up = await capture(['docker', 'ps', '--quiet', '--filter', `name=^${name}$`])
  const running = up.stdout.trim().length > 0
  if (!running && !existsSync(path)) return

  if (running) {
    status(`stopping ${name}`)
    await stopContainer(name, REPLACE_STOP_TIMEOUT_SECONDS)
  }

  const deadline = Date.now() + RELEASE_WAIT_MS
  while (existsSync(path) && Date.now() < deadline) {
    const held = await readLock(path)
    if (held === undefined || !isRunning(held.pid, held.startedAt)) break
    await sleep(RELEASE_POLL_MS)
  }
  await unlink(path).catch(() => {})
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
    ` import -display "$D" -window root ${target} 2>/dev/null` +
    ` || xwd -root -display "$D" | magick xwd:- ${target}`

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
