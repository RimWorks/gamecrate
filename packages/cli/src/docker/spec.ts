import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type {
  DataDirSpec,
  DockerRunSpec,
  Identity,
  LaunchPlan,
  ModeName,
  Mount,
} from '../types'
import { expandHome, resolveProfile } from '../config/load'
import { GamecrateError, Exit } from '../types'
import { CONTAINER_OPEN_FIFO, OPEN_FIFO_FILE, OPEN_SHIM_FILE, wantsLinkOpener } from './openlinks'

/** Container-side XDG_RUNTIME_DIR. A sized tmpfs; display and audio sockets land inside it. */
export const CONTAINER_RUNTIME_DIR = '/tmp/xdg'

/** Where the run directory is bound, so `-logfile /logs/Player.log` lands beside stdout.log. */
export const CONTAINER_LOG_DIR = '/logs'

const OVERLAY_NAMESPACES = ['--pid=host']

const OVERLAY_SOCKET_DIR = '/tmp'

const X11_SOCKET_DIR = '/tmp/.X11-unix'

const CONTAINER_XAUTHORITY = '/tmp/xauth'

const CONTAINER_XDG_DIR = '/xdg'

const CONTAINER_XDG_OPEN = '/usr/local/bin/xdg-open'

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

function launchCommand(plan: LaunchPlan, executable: string, proton: boolean): string[] {
  const { gameConfig: game, settings } = plan
  if (proton) {
    return ['run-headless-windows', winPath(join(game.gameFiles.container, basename(executable)))]
  }
  if (plan.mode === 'headed') return [executable]
  return ['xvfb-run', '-a', `--server-args=-screen 0 ${settings.width}x${settings.height}x24`, executable]
}

function appendGameArgs(
  command: string[],
  mounts: Mount[],
  env: Record<string, string>,
  plan: LaunchPlan,
  proton: boolean,
): void {
  const { gameConfig: game } = plan
  if (game.dataDir.mode === 'arg') {
    const arg = validateDataDirArg(game.dataDir)
    const eq = arg.indexOf('=')
    command.push(proton ? `${arg.slice(0, eq + 1)}${winPath(arg.slice(eq + 1))}` : arg)
  } else Object.assign(env, game.dataDir.env)

  if (game.logFile.mode !== 'arg') return
  mounts.push({ type: 'bind', source: hostPath(plan.runDirHost), target: CONTAINER_LOG_DIR })
  const log = `${CONTAINER_LOG_DIR}/Player.log`
  command.push(game.logFile.arg, proton ? winPath(log) : log)
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

  const command = launchCommand(plan, executable, proton)
  // the wrappers read both: SCREEN sizes Xvfb, DESKTOP sizes the wine virtual desktop.
  if (proton) {
    Object.assign(env, {
      SCREEN: `${settings.width}x${settings.height}x24`,
      DESKTOP: `${settings.width}x${settings.height}`,
      // the wrapper would default this to $HOME/.proton, and HOME is a 64m tmpfs.
      STEAM_COMPAT_DATA_PATH: `${CONTAINER_XDG_DIR}/proton`,
    })
  }
  appendGameArgs(command, mounts, env, plan, proton)

  addScratch(mounts, env, plan, identity)
  addSteam(mounts, env, plan, identity)
  if (headed) addSession(mounts, env, plan)
  if (wantsLinkOpener(plan)) addLinkOpener(mounts, plan)

  const deviceCgroupRules: string[] = []
  if (settings.input) {
    mounts.push({ type: 'bind', source: '/dev/input', target: '/dev/input', readonly: true })
    deviceCgroupRules.push('c 13:* rmw')
  }

  const devices: string[] = []
  const gpu = settings.gpu ? gpuPassthrough() : { kind: 'software' as const, devices: [], groups: [] }
  devices.push(...gpu.devices)
  const groupAdd = gpu.groups
  Object.assign(env, glEnv(gpu.kind))

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
    groupAdd,
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
    extraArgs: [
      ...(headed && env['LD_PRELOAD'] !== undefined ? OVERLAY_NAMESPACES : []),
      ...(settings.dockerArgs ?? []),
    ],
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

/**
 * libsteam_api dlopens $HOME/.steam/sdk64/steamclient.so, and every link inside .steam is an
 * absolute host path, so the real steam root has to answer at that same path in the container.
 */
export function steamMounts(game: string, home: string, containerHome: string): Mount[] {
  const dot = join(home, '.steam')
  if (!existsSync(join(dot, 'steam'))) {
    throw new GamecrateError(
      `${game}: steam is on, but ${dot}/steam is not there`,
      Exit.Environment,
      'start the steam client once so it writes that directory, or relaunch with --no-steam',
    )
  }
  const root = realpathSync(join(dot, 'steam'))
  const mounts: Mount[] = [
    { type: 'bind', source: realpathSync(dot), target: join(containerHome, '.steam'), readonly: true },
    { type: 'bind', source: root, target: root, readonly: true },
    { type: 'bind', source: OVERLAY_SOCKET_DIR, target: OVERLAY_SOCKET_DIR },
  ]
  for (const library of steamLibraries(root)) {
    if (library === root) continue
    mounts.push({ type: 'bind', source: library, target: library, readonly: true })
  }
  return mounts
}

/**
 * Steam answers a workshop query with a path inside whichever library holds the download, so
 * every library has to answer at its own path or the game finds no folder for any item.
 */
export function steamLibraries(root: string): string[] {
  const file = join(root, 'steamapps', 'libraryfolders.vdf')
  if (!existsSync(file)) return []
  const out: string[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const hit = /^\s*"path"\s+"(.+)"\s*$/.exec(line)
    if (hit === null) continue
    const path = hit[1] as string
    if (existsSync(path) && !out.includes(realpathSync(path))) out.push(realpathSync(path))
  }
  return out
}

/**
 * The overlay loads through LD_PRELOAD, which the client sets when it starts a game itself.
 * Only the 64-bit copy: preloading the 32-bit one makes ld.so complain and loads nothing.
 */
export function steamOverlayEnv(root: string): Record<string, string> {
  const lib = join(root, 'ubuntu12_64', 'gameoverlayrenderer.so')
  if (!existsSync(lib)) return {}
  return { LD_PRELOAD: lib }
}

function addSteam(
  mounts: Mount[],
  env: Record<string, string>,
  plan: LaunchPlan,
  identity: Identity,
): void {
  if (!plan.steam) return
  mounts.push(...steamMounts(plan.game, homedir(), identity.home))
  Object.assign(env, steamOverlayEnv(realpathSync(join(homedir(), '.steam', 'steam'))))
}

function addStage(mounts: Mount[], plan: LaunchPlan, modMounts: Mount[]): void {
  const game = plan.gameConfig
  mounts.push({ type: 'bind', source: hostPath(plan.stageDirHost), target: game.modsDir.container, readonly: true })
  for (const mount of modMounts) {
    mounts.push(mount.type === 'bind' ? { ...mount, readonly: true } : mount)
  }
  mounts.push({ type: 'bind', source: hostPath(plan.dataDirHost), target: game.dataDir.container })
}

function addScratch(
  mounts: Mount[],
  env: Record<string, string>,
  plan: LaunchPlan,
  identity: Identity,
): void {
  const { uid, gid } = identity
  for (const target of plan.gameConfig.modsDir.mask ?? []) {
    mounts.push({ type: 'tmpfs', target, size: MASK_SIZE, uid, gid, mode: '755' })
  }
  if (uid !== 0) {
    mounts.push({ type: 'tmpfs', target: identity.home, size: HOME_SIZE, uid, gid, mode: '700' })
  }
  mounts.push({ type: 'tmpfs', target: CONTAINER_RUNTIME_DIR, size: RUNTIME_DIR_SIZE, uid, gid, mode: '700' })
  env.XDG_RUNTIME_DIR = CONTAINER_RUNTIME_DIR

  // HOME is a tmpfs, and .NET's GetFolderPath hands back "" for a missing directory
  mounts.push({ type: 'bind', source: hostPath(plan.configDirHost), target: CONTAINER_XDG_DIR })
  env.XDG_CONFIG_HOME = `${CONTAINER_XDG_DIR}/config`
  env.XDG_CACHE_HOME = `${CONTAINER_XDG_DIR}/cache`
  env.XDG_DATA_HOME ??= `${CONTAINER_XDG_DIR}/data`
}

function addSession(mounts: Mount[], env: Record<string, string>, plan: LaunchPlan): void {
  const { settings } = plan
  if (settings.display === 'x11') addX11(mounts, env)
  else addWayland(mounts, env)

  if (!settings.audio) return
  for (const socket of audioSockets()) {
    mounts.push({ type: 'bind', source: socket.source, target: `${CONTAINER_RUNTIME_DIR}/${socket.name}` })
  }
  env.PULSE_SERVER = `unix:${CONTAINER_RUNTIME_DIR}/pulse/native`
}

function addLinkOpener(mounts: Mount[], plan: LaunchPlan): void {
  const runDir = hostPath(plan.runDirHost)
  mounts.push(
    { type: 'bind', source: join(runDir, OPEN_SHIM_FILE), target: CONTAINER_XDG_OPEN, readonly: true },
    { type: 'bind', source: join(runDir, OPEN_FIFO_FILE), target: CONTAINER_OPEN_FIFO },
  )
}

function addX11(mounts: Mount[], env: Record<string, string>): void {
  const x11 = x11Session()
  if (!x11) return
  mounts.push({ type: 'bind', source: X11_SOCKET_DIR, target: X11_SOCKET_DIR })
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

/** The icon a profile names, made absolute against the config that named it. */
export function windowIcon(plan: LaunchPlan, configDir: string): string | undefined {
  const named = resolveProfile(plan.gameConfig, plan.profile).windowIcon
  if (named === undefined) return undefined
  const path = expandHome(named)
  return isAbsolute(path) ? path : resolve(configDir, path)
}

export function windowTitle(plan: LaunchPlan): string {
  const own = resolveProfile(plan.gameConfig, plan.profile).windowTitle
  const base = own ?? `${plan.game} ${plan.profile}`
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
  for (const group of spec.groupAdd ?? []) args.push('--group-add', group)
  for (const ulimit of spec.ulimits) args.push('--ulimit', ulimit)

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
  // RimWorld's image ENTRYPOINT is ["/bin/bash"], which would run the game's ELF as a shell script
  const [entrypoint, ...rest] = spec.command
  if (entrypoint !== undefined) args.push('--entrypoint', entrypoint)
  args.push(spec.image, ...rest)

  return args
}

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

function csvField(field: string): string {
  if (!field.includes(',') && !field.includes('"')) return field
  return `"${field.replaceAll('"', '""')}"`
}

function winPath(unix: string): string {
  return `Z:${unix.replaceAll('/', '\\')}`
}

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

function glEnv(kind: GpuKind): Record<string, string> {
  if (kind === 'software') return { LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' }

  const env: Record<string, string> = { LIBGL_ALWAYS_SOFTWARE: '0', GALLIUM_DRIVER: '' }
  if (kind === 'nvidia') {
    env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia'
    env.__NV_PRIME_RENDER_OFFLOAD = '1'
  }
  return env
}

export type GpuKind = 'nvidia' | 'dri' | 'software'

export interface GpuPlan {
  kind: GpuKind
  devices: string[]
  /** Groups the container user needs, when a render node is not world-writable. */
  groups: string[]
}

/**
 * NVIDIA comes in through the Container Device Interface. Everything else comes in as the
 * render nodes under /dev/dri, which is what Mesa wants for AMD and Intel.
 */
export function gpuPassthrough(nodes: string[] = driNodes(), nvidia = hasNvidia()): GpuPlan {
  if (nvidia) return { kind: 'nvidia', devices: ['nvidia.com/gpu=all'], groups: [] }
  if (nodes.length === 0) return { kind: 'software', devices: [], groups: [] }
  return { kind: 'dri', devices: nodes, groups: renderGroups(nodes) }
}

export function driNodes(root = '/dev/dri'): string[] {
  try {
    return readdirSync(root)
      .filter((name) => name.startsWith('renderD') || name.startsWith('card'))
      .sort((a, b) => Number(a > b) - Number(a < b))
      .map((name) => join(root, name))
  } catch {
    return []
  }
}

/** Only a node the caller cannot already open needs a group, so a 666 render node adds none. */
export function renderGroups(nodes: string[]): string[] {
  const groups = new Set<string>()
  for (const node of nodes) {
    try {
      const info = statSync(node)
      if ((info.mode & 0o006) === 0o006) continue
      groups.add(String(info.gid))
    } catch {
      continue
    }
  }
  return [...groups]
}

function hasNvidia(): boolean {
  return (
    existsSync('/dev/nvidiactl') ||
    existsSync('/etc/cdi/nvidia.yaml') ||
    existsSync('/usr/share/vulkan/icd.d/nvidia_icd.json')
  )
}

/**
 * The host X session a headed run joins. The cookie is looked up separately from the socket:
 * XWayland under a display manager keeps it in XDG_RUNTIME_DIR, not ~/.Xauthority.
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
