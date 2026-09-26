import { existsSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'
import type {
  DataDirSpec,
  DockerRunSpec,
  Identity,
  LaunchPlan,
  ModeName,
  Mount,
} from '../types'
import { GamecrateError, Exit } from '../types'

/** Container-side XDG_RUNTIME_DIR. A sized tmpfs; display and audio sockets land inside it. */
export const CONTAINER_RUNTIME_DIR = '/tmp/xdg'

/** Where the run directory is bound, so `-logfile /logs/Player.log` lands beside stdout.log. */
export const CONTAINER_LOG_DIR = '/logs'

/** X11's well-known socket directory. The path is the same on both sides or DISPLAY lies. */
const X11_SOCKET_DIR = '/tmp/.X11-unix'
const HOST_X11_DIR = '/run/host-x11'

/** Outside XDG_RUNTIME_DIR on purpose: that is a tmpfs, and a bind under it races the tmpfs. */
const CONTAINER_XAUTHORITY = '/tmp/xauth'

/** Persistent XDG root. Outside HOME because HOME is a tmpfs and a bind under it races. */
const CONTAINER_XDG_DIR = '/xdg'

const RUNTIME_DIR_SIZE = '64m'
const HOME_SIZE = '64m'
const MASK_SIZE = '1m'

/** What the image says about starting itself. Absent means fall back to config. */
export interface ImageLaunch {
  launcher?: 'direct' | 'proton'
  executable?: string
}

/**
 * Explorer detaches under wine, so a proton image has no headed path at all. run() calls this
 * before the marker gate, so the mode is the first thing a person reads.
 */
export function refuseProtonHeaded(game: string, mode: ModeName, image?: ImageLaunch): void {
  if (image?.launcher !== 'proton' || mode !== 'headed') return
  throw new GamecrateError(
    `${game}: a proton image only runs offscreen`,
    Exit.Config,
    'relaunch with --mode headless, or use a variant whose gamecrate.launcher is "direct"',
  )
}

export function buildRunSpec(
  plan: LaunchPlan,
  modMounts: Mount[],
  identity: Identity,
  image?: ImageLaunch,
): DockerRunSpec {
  const { gameConfig: game, settings } = plan
  const headed = plan.mode === 'headed'

  const mounts: Mount[] = []
  const env: Record<string, string> = {
    HOME: identity.home,
    USER: identity.user,
    LOGNAME: identity.user,
  }

  addGameFiles(mounts, plan)
  addStage(mounts, plan, modMounts)

  const proton = image?.launcher === 'proton'
  const executable = image?.executable ?? game.executable

  refuseProtonHeaded(plan.game, plan.mode, image)

  // xvfb-run -a picks a free display itself, which removes both the hardcoded :99 and the
  // startup race the old launch.sh papered over with `sleep 2`.
  const command = proton
    ? ['run-headless-windows', winPath(join(game.gameFiles.container, basename(executable)))]
    : headed
      ? ['run-headed', executable]
      : [
          'xvfb-run',
          '-a',
          `--server-args=-screen 0 ${settings.width}x${settings.height}x24`,
          executable,
        ]

  if (headed) env.SCREEN = `${settings.width}x${settings.height}x24`

  // the wrappers read both: SCREEN sizes Xvfb, DESKTOP sizes the wine virtual desktop.
  if (proton) {
    Object.assign(env, {
      SCREEN: `${settings.width}x${settings.height}x24`,
      DESKTOP: `${settings.width}x${settings.height}`,
      // the wrapper would default this to $HOME/.proton, and HOME is a 64m tmpfs.
      STEAM_COMPAT_DATA_PATH: `${CONTAINER_XDG_DIR}/proton`,
    })
  }

  if (game.dataDir.mode === 'arg') {
    const arg = validateDataDirArg(game.dataDir)
    const eq = arg.indexOf('=')
    command.push(proton ? `${arg.slice(0, eq + 1)}${winPath(arg.slice(eq + 1))}` : arg)
  } else Object.assign(env, game.dataDir.env)

  if (game.logFile.mode === 'arg') {
    mounts.push({ type: 'bind', source: hostPath(plan.runDirHost), target: CONTAINER_LOG_DIR })
    const log = `${CONTAINER_LOG_DIR}/Player.log`
    command.push(game.logFile.arg, proton ? winPath(log) : log)
  }

  addScratch(mounts, env, plan, identity)
  if (headed) addSession(mounts, env, plan, identity)

  const deviceCgroupRules: string[] = []
  if (settings.input) {
    mounts.push({ type: 'bind', source: '/dev/input', target: '/dev/input', readonly: true })
    deviceCgroupRules.push('c 13:* rmw')
  }

  const devices: string[] = []
  if (settings.gpu) devices.push('nvidia.com/gpu=all')
  Object.assign(env, glEnv(settings.gpu))

  command.push(...(settings.gameArgs ?? []))

  return {
    image: game.image.ref,
    name: containerName(plan),
    labels: {
      'gamecrate.game': plan.game,
      'gamecrate.profile': plan.profile,
      ...(plan.instance === undefined ? {} : { 'gamecrate.instance': plan.instance }),
    },
    identity,
    env,
    mounts,
    devices,
    deviceCgroupRules,
    network: settings.network,
    memory: settings.memory,
    memorySwap: settings.memory,
    cpus: settings.cpus,
    pidsLimit: settings.pidsLimit,
    ulimits: ['core=0'],
    workdir: game.gameFiles.container,
    // An X client whose WM_CLIENT_MACHINE is foreign gets ` <@name>` stapled to its caption.
    ...(headed && settings.display === 'x11' ? { hostname: hostname() } : {}),
    command,
    extraArgs: [...(settings.dockerArgs ?? [])],
  }
}

function addGameFiles(mounts: Mount[], plan: LaunchPlan): void {
  const { gameFiles } = plan.gameConfig
  if (gameFiles.source !== 'mount') return
  if (!gameFiles.host) {
    throw new GamecrateError(
      `gameFiles.source is "mount" but no host path is set for ${plan.game}`,
      Exit.Config,
    )
  }
  mounts.push({ type: 'bind', source: hostPath(gameFiles.host), target: gameFiles.container, readonly: true })
}

function addStage(mounts: Mount[], plan: LaunchPlan, modMounts: Mount[]): void {
  const game = plan.gameConfig
  mounts.push({ type: 'bind', source: hostPath(plan.stageDirHost), target: game.modsDir.container, readonly: true })
  // Nested per-mod binds sit inside the staged tree; the game never writes to a mod source.
  for (const mount of modMounts) {
    mounts.push(mount.type === 'bind' ? { ...mount, readonly: true } : mount)
  }
  // Read-write on purpose: both engines Create() subdirectories at boot and a ro mount fails there.
  mounts.push({ type: 'bind', source: hostPath(plan.dataDirHost), target: game.dataDir.container })
}

/** The tmpfs set and the XDG roots that hang off it. */
function addScratch(
  mounts: Mount[],
  env: Record<string, string>,
  plan: LaunchPlan,
  identity: Identity,
): void {
  const { uid, gid } = identity
  // Unconditional, independent of the uid mode: a game may read mods from both roots.
  for (const target of plan.gameConfig.modsDir.mask ?? []) {
    mounts.push({ type: 'tmpfs', target, size: MASK_SIZE, uid, gid, mode: '755' })
  }
  if (uid !== 0) {
    mounts.push({ type: 'tmpfs', target: identity.home, size: HOME_SIZE, uid, gid, mode: '700' })
  }
  mounts.push({ type: 'tmpfs', target: CONTAINER_RUNTIME_DIR, size: RUNTIME_DIR_SIZE, uid, gid, mode: '700' })
  env.XDG_RUNTIME_DIR = CONTAINER_RUNTIME_DIR

  // HOME is a tmpfs, so $HOME/.config and $HOME/.local/share are empty every run and .NET's
  // GetFolderPath hands back "" for a missing directory. Point XDG at a per-profile bind
  // instead. A game that already sets XDG_DATA_HOME to its save dir never gets
  // overwritten.
  mounts.push({ type: 'bind', source: hostPath(plan.configDirHost), target: CONTAINER_XDG_DIR })
  env.XDG_CONFIG_HOME = `${CONTAINER_XDG_DIR}/config`
  env.XDG_CACHE_HOME = `${CONTAINER_XDG_DIR}/cache`
  env.XDG_DATA_HOME ??= `${CONTAINER_XDG_DIR}/data`
}

/**
 * Display and audio for a headed run. Offscreen modes get their X server from xvfb-run, so
 * DISPLAY is set by it, not by us.
 */
function addSession(mounts: Mount[], env: Record<string, string>, plan: LaunchPlan, identity: Identity): void {
  const { settings } = plan
  if (settings.display === 'x11') addX11(mounts, env, identity)
  else addWayland(mounts, env)

  if (!settings.audio) return
  for (const socket of audioSockets()) {
    mounts.push({ type: 'bind', source: socket.source, target: `${CONTAINER_RUNTIME_DIR}/${socket.name}` })
  }
  env.PULSE_SERVER = `unix:${CONTAINER_RUNTIME_DIR}/pulse/native`
}

function addX11(mounts: Mount[], env: Record<string, string>, identity: Identity): void {
  const x11 = x11Session()
  if (!x11) return
  // the nested server needs its own socket dir. sharing the host's read-write is how a nested
  // display number lands on top of the real one and takes the desktop's X down with it.
  mounts.push(
    { type: 'tmpfs', target: X11_SOCKET_DIR, uid: identity.uid, gid: identity.gid, mode: '1777' },
    { type: 'bind', source: X11_SOCKET_DIR, target: HOST_X11_DIR, readonly: true },
  )
  env.HOST_X11_DIR = HOST_X11_DIR
  env.DISPLAY = x11.display
  env.XDG_SESSION_TYPE = 'x11'
  env.SDL_VIDEODRIVER = 'x11'
  env.QT_QPA_PLATFORM = 'xcb'
  if (!x11.xauthority) return
  mounts.push({ type: 'bind', source: x11.xauthority, target: CONTAINER_XAUTHORITY, readonly: true })
  env.XAUTHORITY = CONTAINER_XAUTHORITY
}

function addWayland(mounts: Mount[], env: Record<string, string>): void {
  const wayland = waylandSocket()
  if (!wayland) return
  mounts.push({ type: 'bind', source: wayland.source, target: `${CONTAINER_RUNTIME_DIR}/${wayland.name}` })
  env.WAYLAND_DISPLAY = wayland.name
  env.XDG_SESSION_TYPE = 'wayland'
  env.SDL_VIDEODRIVER = 'wayland'
  env.QT_QPA_PLATFORM = 'wayland'
}

/** Instances of one profile run side by side, so the name has to carry which one this is. */
export function containerName(plan: LaunchPlan): string {
  const base = `gamecrate-${plan.game}-${plan.profile}`
  return plan.instance === undefined ? base : `${base}-${plan.instance}`
}

/** What the window is renamed to, so a taskbar full of worktrees is readable. */
export function windowTitle(plan: LaunchPlan): string {
  const base = `${plan.game} ${plan.profile}`
  return plan.instance === undefined ? base : `${base} / ${plan.instance}`
}

export function toDockerArgs(spec: DockerRunSpec): string[] {
  const args = ['run', '--rm', '--init', '--name', spec.name]
  if (spec.hostname !== undefined) args.push('--hostname', spec.hostname)

  for (const [key, value] of Object.entries(spec.labels)) args.push('--label', `${key}=${value}`)
  args.push('--user', `${spec.identity.uid}:${spec.identity.gid}`)
  for (const [key, value] of Object.entries(spec.env)) args.push('--env', `${key}=${value}`)
  for (const mount of spec.mounts) args.push(...mountArgs(mount))
  for (const device of spec.devices) args.push('--device', device)
  for (const rule of spec.deviceCgroupRules) args.push('--device-cgroup-rule', rule)
  for (const ulimit of spec.ulimits) args.push('--ulimit', ulimit)

  // `--pull=never`: acquisition is an earlier explicit step, so the run must never fetch a
  // different digest.
  args.push(
    '--network', spec.network,
    '--memory', spec.memory,
    '--memory-swap', spec.memorySwap,
    '--cpus', String(spec.cpus),
    '--pids-limit', String(spec.pidsLimit),
    '--workdir', spec.workdir,
    ...spec.extraArgs,
    '--pull=never',
  )
  // The image's own ENTRYPOINT is not ours to trust: RimWorld's is ["/bin/bash"], which
  // would run the game's ELF as a shell script. State it explicitly every time.
  const [entrypoint, ...rest] = spec.command
  if (entrypoint !== undefined) args.push('--entrypoint', entrypoint)
  args.push(spec.image, ...rest)

  return args
}

/**
 * `--mount` for binds so a missing source errors instead of being created root-owned;
 * `--tmpfs` for tmpfs because `--mount type=tmpfs` has no uid=/gid= options.
 */
function mountArgs(mount: Mount): string[] {
  if (mount.type === 'tmpfs') {
    const opts = ['rw']
    if (mount.uid !== undefined) opts.push(`uid=${mount.uid}`)
    if (mount.gid !== undefined) opts.push(`gid=${mount.gid}`)
    if (mount.mode) opts.push(`mode=${mount.mode}`)
    opts.push(`size=${mount.size ?? RUNTIME_DIR_SIZE}`)
    return ['--tmpfs', `${mount.target}:${opts.join(',')}`]
  }

  if (!mount.source) {
    throw new GamecrateError(`bind mount at ${mount.target} has no source`, Exit.Config)
  }
  const fields = [`type=bind`, `src=${mount.source}`, `dst=${mount.target}`]
  if (mount.readonly) fields.push('readonly')
  return ['--mount', fields.map(csvField).join(',')]
}

/** Docker parses the option string as CSV, so a comma in a path has to be quoted. */
function csvField(field: string): string {
  if (!field.includes(',') && !field.includes('"')) return field
  return `"${field.replaceAll('"', '""')}"`
}

/** Z: is the unix root inside wine, so /logs/Player.log reaches the game as Z:\logs\Player.log. */
function winPath(unix: string): string {
  return `Z:${unix.replaceAll('/', '\\')}`
}

/**
 * RimWorld's TryGetCommandLineArg splits argv on `=` and requires exactly two parts. A path
 * with `=` falls back to an ephemeral in-container path and `--rm` takes the save with it (L10).
 */
function validateDataDirArg(dataDir: Extract<DataDirSpec, { mode: 'arg' }>): string {
  if (dataDir.container.includes('=')) {
    throw new GamecrateError(
      `container data path contains "=": ${dataDir.container}`,
      Exit.Config,
      'RimWorld silently ignores -savedatafolder when the argv element does not split into exactly two parts, and the save is lost with --rm.',
    )
  }

  const parts = dataDir.arg.split('=')
  if (parts.length !== 2) {
    throw new GamecrateError(
      `dataDir.arg must contain exactly one "=": ${dataDir.arg}`,
      Exit.Config,
    )
  }

  if (trimSlash(parts[1] ?? '') !== trimSlash(dataDir.container)) {
    throw new GamecrateError(
      `dataDir.arg points at ${parts[1]} but the mount target is ${dataDir.container}`,
      Exit.Config,
      'The engine would write to a path that is not the mounted data directory.',
    )
  }

  return dataDir.arg
}

function trimSlash(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

/** The image bakes llvmpipe, so the tool states the whole GL story rather than inheriting it. */
function glEnv(gpu: boolean): Record<string, string> {
  if (!gpu) return { LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' }

  const env: Record<string, string> = { LIBGL_ALWAYS_SOFTWARE: '0', GALLIUM_DRIVER: '' }
  if (hasNvidia()) {
    env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia'
    env.__NV_PRIME_RENDER_OFFLOAD = '1'
  }
  return env
}

/** Gated on the detected vendor, not on the game: this class of host also carries radeon_icd. */
function hasNvidia(): boolean {
  return (
    existsSync('/dev/nvidiactl') ||
    existsSync('/etc/cdi/nvidia.yaml') ||
    existsSync('/usr/share/vulkan/icd.d/nvidia_icd.json')
  )
}

/**
 * The host X session a headed run joins. The cookie is looked up separately from the socket
 * because XWayland under a display manager keeps it in XDG_RUNTIME_DIR, not ~/.Xauthority.
 * Whether the socket directory is really there is checkBindSources' job, as with every bind.
 */
export function x11Session(): { display: string; xauthority: string | null } | null {
  const display = process.env.DISPLAY
  if (!display) return null

  const cookie = process.env.XAUTHORITY ?? join(homedir(), '.Xauthority')
  return { display, xauthority: existsSync(cookie) ? cookie : null }
}

export function waylandSocket(): { source: string; name: string } | null {
  const display = process.env.WAYLAND_DISPLAY
  const runtime = process.env.XDG_RUNTIME_DIR
  if (!display) return null

  let source: string | null = null
  if (display.startsWith('/')) source = display
  else if (runtime) source = join(runtime, display)
  if (!source || !existsSync(source)) return null
  return { source, name: basename(source) }
}

function audioSockets(): { source: string; name: string }[] {
  const runtime = process.env.XDG_RUNTIME_DIR
  if (!runtime) return []

  const found: { source: string; name: string }[] = []
  for (const name of ['pipewire-0', 'pulse/native']) {
    const source = join(runtime, name)
    if (existsSync(source)) found.push({ source, name })
  }
  return found
}

function hostPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
