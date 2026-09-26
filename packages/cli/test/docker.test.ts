import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS } from '../src/config/builtin'
import { buildRunSpec, refuseProtonHeaded, toDockerArgs, windowTitle } from '../src/docker/spec'
import { resolveIdentity } from '../src/docker/identity'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { capture, waitForMarker } from '../src/docker/run'
import { isPeerClaim, newMatches, parseAtoms, parseWindowPid } from '../src/docker/window'
import { FIXTURE_STEAM_BUILD, FIXTURE_VERSION, fixturePlugin } from './fixture-plugin'
import { deadPid } from './pids'
import type { GameConfig, Identity, LaunchPlan, ModeName, Settings } from '../src/types'
import { GamecrateError, Exit } from '../src/types'

const identity: Identity = { uid: 1000, gid: 1000, home: '/tmp/home', user: 'runner' }

const settings: Settings = {
  width: 1920,
  height: 1080,
  devMode: true,
  runInBackground: true,
  resetModsConfigOnCrash: false,
  gpu: true,
  audio: false,
  input: false,
  network: 'none',
  display: 'wayland',
  memory: '8g',
  cpus: 6,
  pidsLimit: 1024,
}

const atlas: GameConfig = {
  gameFiles: { source: 'mount', host: '/fixtures/Atlas', container: '/game' },
  dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
  modsDir: { container: '/game/Mods' },
  logFile: { mode: 'arg', arg: '-logfile' },
  image: { ref: 'atlas-build:latest', acquire: 'build', context: '/fixtures/docker' },
  executable: './AtlasLinux',
  steamAppId: 294100,
  workshopRoot: '/fixtures/workshop/294100',
  scanRoots: [],
  manifest: { file: 'About/About.txt' },
  modsConfig: { file: 'Config/ModsConfig.txt' },
  prefs: { file: 'Config/Prefs.txt' },
  version: FIXTURE_VERSION,
  steamBuild: FIXTURE_STEAM_BUILD,
  saveExtensions: ['sav'],
  core: 'atlasco.atlas',
  dlc: [],
  modes: ['headed', 'headless', 'screenshot'],
  profiles: {},
}

const beacon: GameConfig = {
  gameFiles: { source: 'mount', host: '/fixtures/Beacon', container: '/opt/beacon' },
  dataDir: {
    container: '/data/Beacon Studios/Beacon',
    mode: 'env',
    env: { XDG_DATA_HOME: '/data' },
  },
  modsDir: { container: '/data/Beacon Studios/Beacon/SaveData/Mods', mask: ['/opt/beacon/Mods'] },
  logFile: { mode: 'copy-out', from: 'Logs/' },
  image: { ref: 'registry.example/beacon-play-base:latest', acquire: 'pull' },
  executable: './Beacon',
  steamAppId: 294100,
  workshopRoot: null,
  scanRoots: [],
  manifest: { file: 'About/About.txt' },
  modsConfig: { file: 'SaveData/Config/ModsConfig.txt' },
  prefs: { file: 'SaveData/Prefs.txt' },
  version: FIXTURE_VERSION,
  steamBuild: FIXTURE_STEAM_BUILD,
  saveExtensions: ['sav'],
  core: 'beaconco.beacon',
  dlc: [],
  modes: ['headed', 'headless', 'screenshot'],
  profiles: {},
}

function plan(
  game: string,
  gameConfig: GameConfig,
  overrides: Partial<Settings> = {},
  mode: ModeName = 'headless',
  instance?: string,
): LaunchPlan {
  const profileDir = `/fixtures/data/${game}/kitted`
  const dir = instance === undefined ? profileDir : `${profileDir}/instances/${instance}`
  return {
    game,
    gameConfig,
    plugin: fixturePlugin(),
    profile: 'kitted',
    settings: { ...settings, ...overrides },
    mods: [],
    warnOnStale: true,
    profileDir,
    ...(instance === undefined ? {} : { instance }),
    instanceDir: dir,
    dataDirHost: `${dir}/game`,
    configDirHost: `${profileDir}/config`,
    stageDirHost: `${dir}/.stage`,
    logsDirHost: `${dir}/logs/runs/1`,
    runDirHost: `${dir}/logs/runs/1`,
    mode,
    timeoutSeconds: 300,
    renderWaitSeconds: 20,
    warnings: [],
  }
}

/** Every value that follows an occurrence of `flag`. */
function valuesOf(args: string[], flag: string): string[] {
  const found: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === flag) found.push(args[i + 1] ?? '')
  return found
}

function mountFor(args: string[], target: string): string | undefined {
  return valuesOf(args, '--mount').find((m) =>
    m.split(',').some((field) => field === `dst=${target}` || field === `dst=${target}"`),
  )
}

describe('resolveIdentity', () => {
  test('root mode is uid 0 with a real home', () => {
    expect(resolveIdentity(true)).toEqual({ uid: 0, gid: 0, home: '/root', user: 'root' })
  })

  test('host mode names USER and HOME explicitly', () => {
    const id = resolveIdentity(false)
    expect(id.uid).toBe(process.getuid?.() ?? 0)
    expect(id.gid).toBe(process.getgid?.() ?? 0)
    expect(id.home).toBe('/tmp/home')
    expect(id.user.length).toBeGreaterThan(0)
  })
})

describe('buildRunSpec: invariants', () => {
  const args = toDockerArgs(buildRunSpec(plan('atlas', atlas), [], identity))

  test('always --rm --init with core dumps off', () => {
    expect(args).toContain('--rm')
    expect(args).toContain('--init')
    expect(valuesOf(args, '--ulimit')).toEqual(['core=0'])
  })

  test('deterministic name and labels', () => {
    expect(valuesOf(args, '--name')).toEqual(['gamecrate-atlas-kitted'])
    expect(valuesOf(args, '--label')).toEqual([
      'gamecrate.game=atlas',
      'gamecrate.profile=kitted',
    ])
  })

  // Two instances of one profile run side by side, so nothing here may collide.
  test('an instance gets its own container name, label and mounts', () => {
    const scoped = toDockerArgs(
      buildRunSpec(plan('atlas', atlas, {}, 'headless', 'wt-a'), [], identity),
    )
    expect(valuesOf(scoped, '--name')).toEqual(['gamecrate-atlas-kitted-wt-a'])
    expect(valuesOf(scoped, '--label')).toEqual([
      'gamecrate.game=atlas',
      'gamecrate.profile=kitted',
      'gamecrate.instance=wt-a',
    ])
    const mounts = valuesOf(scoped, '--mount').join(' ')
    expect(mounts).toContain('/fixtures/data/atlas/kitted/instances/wt-a/game')
    expect(mounts).not.toContain('src=/fixtures/data/atlas/kitted/game')
  })

  test('--user matches the resolved identity', () => {
    expect(valuesOf(args, '--user')).toEqual(['1000:1000'])
  })

  test('USER, LOGNAME and HOME are all set: neither image has a passwd entry', () => {
    const env = valuesOf(args, '--env')
    expect(env).toContain('HOME=/tmp/home')
    expect(env).toContain('USER=runner')
    expect(env).toContain('LOGNAME=runner')
  })

  test('--memory-swap equals --memory so the cap is real', () => {
    expect(valuesOf(args, '--memory')).toEqual(['8g'])
    expect(valuesOf(args, '--memory-swap')).toEqual(['8g'])
  })

  test('binds use --mount, never -v', () => {
    expect(args).not.toContain('-v')
    expect(args).not.toContain('--volume')
    expect(valuesOf(args, '--mount').length).toBeGreaterThan(0)
  })

  test('the run never pulls behind the tool', () => {
    expect(args).toContain('--pull=never')
  })

  test('headed: the executable becomes --entrypoint; the image is followed only by its args', () => {
    // The image ENTRYPOINT is ["/bin/bash"], which would run the ELF as a shell script.
    const headed = toDockerArgs(buildRunSpec(plan('atlas', atlas, {}, 'headed'), [], identity))
    const entry = headed.indexOf('--entrypoint')
    expect(entry).toBeGreaterThan(0)
    expect(headed[entry + 1]).toBe('run-headed')

    const at = headed.indexOf('atlas-build:latest')
    expect(at).toBeGreaterThan(0)
    expect(headed.slice(at + 1)).toEqual([
      './AtlasLinux',
      '-savedatafolder=/data',
      '-logfile',
      '/logs/Player.log',
    ])
  })

  test('offscreen: xvfb-run is the entrypoint and the game becomes its argument', () => {
    // Nothing else starts an X server, so running the binary directly dies at GLFW/Unity init.
    const entry = args.indexOf('--entrypoint')
    expect(args[entry + 1]).toBe('xvfb-run')

    const at = args.indexOf('atlas-build:latest')
    expect(args.slice(at + 1, at + 4)).toEqual([
      '-a',
      '--server-args=-screen 0 1920x1080x24',
      './AtlasLinux',
    ])
    // -a chooses the display, so we must not pin one.
    expect(args.join(' ')).not.toContain('DISPLAY=:99')
  })
})

describe('buildRunSpec: mount modes', () => {
  test('atlas passes the data dir as an arg', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity)
    expect(spec.command).toContain('-savedatafolder=/data')
    expect(spec.env.XDG_DATA_HOME).toBe('/xdg/data')
    expect(mountFor(toDockerArgs(spec), '/data')).toBeDefined()
  })

  test('the XDG dirs point at a per-profile bind, not the tmpfs HOME', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity)
    expect(spec.env.XDG_CONFIG_HOME).toBe('/xdg/config')
    expect(spec.env.XDG_CACHE_HOME).toBe('/xdg/cache')
    expect(spec.env.XDG_DATA_HOME).toBe('/xdg/data')
    expect(mountFor(toDockerArgs(spec), '/xdg')).toBeDefined()
  })

  test('the XDG bind is shared by every instance of a profile', () => {
    const base = buildRunSpec(plan('atlas', atlas), [], identity)
    const forked = buildRunSpec(plan('atlas', atlas, {}, 'headless', 'wt-a'), [], identity)
    expect(forked.mounts.find((m) => m.target === '/xdg')?.source)
      .toBe(base.mounts.find((m) => m.target === '/xdg')?.source)
  })

  test('beacon keeps its own XDG_DATA_HOME', () => {
    const spec = buildRunSpec(plan('beacon', beacon), [], identity)
    expect(spec.env.XDG_DATA_HOME).toBe('/data')
    expect(spec.env.XDG_CONFIG_HOME).toBe('/xdg/config')
  })

  test('beacon passes the data dir as env and mounts the hardcoded suffix', () => {
    const spec = buildRunSpec(plan('beacon', beacon), [], identity)
    expect(spec.env.XDG_DATA_HOME).toBe('/data')
    expect(spec.command).toEqual([
      'xvfb-run',
      '-a',
      '--server-args=-screen 0 1920x1080x24',
      './Beacon',
    ])
    expect(mountFor(toDockerArgs(spec), '/data/Beacon Studios/Beacon')).toBe(
      'type=bind,src=/fixtures/data/beacon/kitted/game,dst=/data/Beacon Studios/Beacon',
    )
  })

  test('the data mount is rw while game files and staged mods are ro', () => {
    const args = toDockerArgs(buildRunSpec(plan('atlas', atlas), [], identity))
    expect(mountFor(args, '/data')).not.toContain('readonly')
    expect(mountFor(args, '/game')).toContain('readonly')
    expect(mountFor(args, '/game/Mods')).toContain('readonly')
  })

  test('nested per-mod binds are forced read-only', () => {
    const spec = buildRunSpec(
      plan('atlas', atlas),
      [{ type: 'bind', source: '/fixtures/mods/KittedCore', target: '/game/Mods/KittedCore' }],
      identity,
    )
    const mount = mountFor(toDockerArgs(spec), '/game/Mods/KittedCore')
    expect(mount).toContain('readonly')
  })

  test('atlas gets a rw log bind for -logfile', () => {
    const args = toDockerArgs(buildRunSpec(plan('atlas', atlas), [], identity))
    expect(mountFor(args, '/logs')).toBe(
      'type=bind,src=/fixtures/data/atlas/kitted/logs/runs/1,dst=/logs',
    )
  })

  test('beacon has no log bind: its engine writes under the data dir', () => {
    const args = toDockerArgs(buildRunSpec(plan('beacon', beacon), [], identity))
    expect(mountFor(args, '/logs')).toBeUndefined()
  })

  test('a source containing a comma is CSV-quoted', () => {
    const spec = buildRunSpec(
      plan('atlas', atlas),
      [{ type: 'bind', source: '/fixtures/a,b', target: '/game/Mods/Weird' }],
      identity,
    )
    expect(toDockerArgs(spec)).toContain(
      'type=bind,"src=/fixtures/a,b",dst=/game/Mods/Weird,readonly',
    )
  })
})

describe('buildRunSpec: the "=" landmine', () => {
  test('a container data path containing "=" is rejected', () => {
    const broken: GameConfig = {
      ...atlas,
      dataDir: { container: '/data=x', mode: 'arg', arg: '-savedatafolder=/data=x' },
    }
    let thrown: unknown
    try {
      buildRunSpec(plan('atlas', broken), [], identity)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(GamecrateError)
    expect((thrown as GamecrateError).code).toBe(Exit.Config)
  })

  test('an arg that disagrees with the mount target is rejected', () => {
    const broken: GameConfig = {
      ...atlas,
      dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/elsewhere' },
    }
    expect(() => buildRunSpec(plan('atlas', broken), [], identity)).toThrow(GamecrateError)
  })

  test('a trailing slash is not a disagreement', () => {
    const ok: GameConfig = {
      ...atlas,
      dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data/' },
    }
    expect(buildRunSpec(plan('atlas', ok), [], identity).command).toContain(
      '-savedatafolder=/data/',
    )
  })

  test('an env-mode path containing "=" is fine: no argv split involved', () => {
    const weird: GameConfig = {
      ...beacon,
      dataDir: { container: '/data=x/Beacon', mode: 'env', env: { XDG_DATA_HOME: '/data=x' } },
    }
    expect(() => buildRunSpec(plan('beacon', weird), [], identity)).not.toThrow()
  })
})

describe('buildRunSpec: tmpfs', () => {
  test('mask entries become sized tmpfs owned by the resolved uid', () => {
    const args = toDockerArgs(buildRunSpec(plan('beacon', beacon), [], identity))
    expect(valuesOf(args, '--tmpfs')).toContain('/opt/beacon/Mods:rw,uid=1000,gid=1000,mode=755,size=1m')
  })

  test('masking is unconditional, independent of the uid mode', () => {
    const asRoot = toDockerArgs(
      buildRunSpec(plan('beacon', beacon), [], { uid: 0, gid: 0, home: '/root', user: 'root' }),
    )
    expect(valuesOf(asRoot, '--tmpfs').some((t) => t.startsWith('/opt/beacon/Mods:'))).toBe(true)
  })

  test('atlas has no mask: GetOrCreateModsFolder is its only mod root', () => {
    const args = toDockerArgs(buildRunSpec(plan('atlas', atlas), [], identity))
    expect(valuesOf(args, '--tmpfs').some((t) => t.includes('/Mods:'))).toBe(false)
  })

  test('every tmpfs is sized', () => {
    for (const game of [atlas, beacon]) {
      const args = toDockerArgs(buildRunSpec(plan('g', game), [], identity))
      const tmpfs = valuesOf(args, '--tmpfs')
      expect(tmpfs.length).toBeGreaterThan(0)
      for (const entry of tmpfs) expect(entry).toMatch(/,size=\d+[kmg]$/)
    }
  })

  test('XDG_RUNTIME_DIR is a private tmpfs owned by the resolved uid', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity)
    expect(spec.env.XDG_RUNTIME_DIR).toBe('/tmp/xdg')
    expect(valuesOf(toDockerArgs(spec), '--tmpfs')).toContain(
      '/tmp/xdg:rw,uid=1000,gid=1000,mode=700,size=64m',
    )
  })

  test('HOME is a tmpfs for the non-root uid and left alone for root', () => {
    const asUser = toDockerArgs(buildRunSpec(plan('atlas', atlas), [], identity))
    expect(valuesOf(asUser, '--tmpfs').some((t) => t.startsWith('/tmp/home:'))).toBe(true)

    const asRoot = toDockerArgs(
      buildRunSpec(plan('atlas', atlas), [], { uid: 0, gid: 0, home: '/root', user: 'root' }),
    )
    expect(valuesOf(asRoot, '--tmpfs').some((t) => t.startsWith('/root:'))).toBe(false)
  })
})

describe('buildRunSpec: devices and display', () => {
  test('GPU goes through CDI and no vulkan ICD is bound', () => {
    const args = toDockerArgs(buildRunSpec(plan('atlas', atlas), [], identity))
    expect(valuesOf(args, '--device')).toEqual(['nvidia.com/gpu=all'])
    expect(args.some((a) => a.includes('icd.d') || a.includes('nvidia_icd'))).toBe(false)
    expect(args.some((a) => a.startsWith('VK_ICD_FILENAMES'))).toBe(false)
  })

  test('no GPU means no device and software GL', () => {
    const spec = buildRunSpec(plan('atlas', atlas, { gpu: false }), [], identity)
    expect(spec.devices).toEqual([])
    expect(spec.env.LIBGL_ALWAYS_SOFTWARE).toBe('1')
    expect(spec.env.GALLIUM_DRIVER).toBe('llvmpipe')
  })

  test('GL env is stated, never inherited from the image bake', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity)
    expect(spec.env.LIBGL_ALWAYS_SOFTWARE).toBe('0')
    expect(spec.env.GALLIUM_DRIVER).toBe('')
  })

  test('input passthrough is opt-in and carries its cgroup rule', () => {
    const off = buildRunSpec(plan('beacon', beacon), [], identity)
    expect(off.deviceCgroupRules).toEqual([])

    const on = toDockerArgs(buildRunSpec(plan('beacon', beacon, { input: true }), [], identity))
    expect(mountFor(on, '/dev/input')).toContain('readonly')
    expect(valuesOf(on, '--device-cgroup-rule')).toEqual(['c 13:* rmw'])
  })

  test('a headed launch mounts the wayland socket into XDG_RUNTIME_DIR', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'gamecrate-runtime-'))
    writeFileSync(join(runtime, 'wayland-9'), '')
    const previous = { xdg: process.env.XDG_RUNTIME_DIR, wl: process.env.WAYLAND_DISPLAY }
    process.env.XDG_RUNTIME_DIR = runtime
    process.env.WAYLAND_DISPLAY = 'wayland-9'
    try {
      for (const [name, game] of [
        ['atlas', atlas],
        ['beacon', beacon],
      ] as const) {
        const spec = buildRunSpec(plan(name, game, {}, 'headed'), [], identity)
        expect(spec.env.WAYLAND_DISPLAY).toBe('wayland-9')
        expect(spec.env.XDG_RUNTIME_DIR).toBe('/tmp/xdg')
        expect(mountFor(toDockerArgs(spec), '/tmp/xdg/wayland-9')).toBeDefined()
      }
    } finally {
      process.env.XDG_RUNTIME_DIR = previous.xdg
      process.env.WAYLAND_DISPLAY = previous.wl
    }
  })

  test('a headed x11 launch binds the socket, the cookie and the host hostname', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-x11-'))
    const cookie = join(dir, 'xauth')
    writeFileSync(cookie, '')
    const previous = { display: process.env.DISPLAY, xauth: process.env.XAUTHORITY }
    process.env.DISPLAY = ':1'
    process.env.XAUTHORITY = cookie
    try {
      for (const [name, game] of [
        ['atlas', atlas],
        ['beacon', beacon],
      ] as const) {
        const spec = buildRunSpec(plan(name, game, { display: 'x11' }, 'headed'), [], identity)
        expect(spec.env.DISPLAY).toBe(':1')
        expect(spec.env.XAUTHORITY).toBe('/tmp/xauth')
        expect(spec.env.WAYLAND_DISPLAY).toBeUndefined()
        expect(spec.hostname).toBe(hostname())

        const args = toDockerArgs(spec)
        expect(mountFor(args, '/tmp/xauth')).toContain('readonly')
        expect(valuesOf(args, '--hostname')).toEqual([hostname()])

        // the nested server gets its own socket dir. a writable bind of the host's is how a
        // nested display lands on the real one and takes the desktop's X down with it.
        expect(valuesOf(args, '--tmpfs').some((t) => t.startsWith('/tmp/.X11-unix:'))).toBe(true)
        expect(mountFor(args, '/tmp/.X11-unix')).toBeUndefined()
        expect(mountFor(args, '/run/host-x11')).toContain('readonly')
      }
    } finally {
      process.env.DISPLAY = previous.display
      process.env.XAUTHORITY = previous.xauth
    }
  })

  // A caption is only renameable on X11, and only headed opens a window at all.
  test('an offscreen run reaches for no display server and names no hostname', () => {
    const spec = buildRunSpec(plan('atlas', atlas, { display: 'x11' }), [], identity)
    expect(spec.env.DISPLAY).toBeUndefined()
    expect(spec.hostname).toBeUndefined()
    expect(mountFor(toDockerArgs(spec), '/tmp/.X11-unix')).toBeUndefined()
  })

  test('audio sockets are existence-conditional', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'gamecrate-runtime-'))
    writeFileSync(join(runtime, 'wayland-9'), '')
    writeFileSync(join(runtime, 'pipewire-0'), '')
    const previous = { xdg: process.env.XDG_RUNTIME_DIR, wl: process.env.WAYLAND_DISPLAY }
    process.env.XDG_RUNTIME_DIR = runtime
    process.env.WAYLAND_DISPLAY = 'wayland-9'
    try {
      const args = toDockerArgs(
        buildRunSpec(plan('beacon', beacon, { audio: true }, 'headed'), [], identity),
      )
      expect(mountFor(args, '/tmp/xdg/pipewire-0')).toBeDefined()
      expect(mountFor(args, '/tmp/xdg/pulse/native')).toBeUndefined()
    } finally {
      process.env.XDG_RUNTIME_DIR = previous.xdg
      process.env.WAYLAND_DISPLAY = previous.wl
    }
  })

  // The whole point of retitling: two worktrees of one profile must read differently.
  test('the window title carries the profile, and the instance when there is one', () => {
    expect(windowTitle(plan('atlas', atlas))).toBe('atlas kitted')
    expect(windowTitle(plan('atlas', atlas, {}, 'headed', 'wt-a'))).toBe(
      'atlas kitted / wt-a',
    )
  })

  test('extra docker args land before the image', () => {
    const args = toDockerArgs(
      buildRunSpec(plan('atlas', atlas, { dockerArgs: ['--cap-drop', 'ALL'] }), [], identity),
    )
    expect(args.indexOf('--cap-drop')).toBeLessThan(args.indexOf('atlas-build:latest'))
  })

  // A miss here silently strips the wrong protocol, or none, and the close button stays dead.
  test('WM_PROTOCOLS parses out of xprop, and reads empty when the property is missing', () => {
    expect(parseAtoms('WM_PROTOCOLS(ATOM): protocols  WM_DELETE_WINDOW, WM_TAKE_FOCUS\n')).toEqual([
      'WM_DELETE_WINDOW',
      'WM_TAKE_FOCUS',
    ])
    expect(parseAtoms('WM_PROTOCOLS(ATOM): protocols  WM_DELETE_WINDOW\n')).toEqual([
      'WM_DELETE_WINDOW',
    ])
    expect(parseAtoms('WM_PROTOCOLS:  not found.\n')).toEqual([])
    expect(parseAtoms('')).toEqual([])
  })

  test('game args are appended after the engine flags', () => {
    const spec = buildRunSpec(plan('atlas', atlas, { gameArgs: ['-quicktest'] }), [], identity)
    expect(spec.command.at(-1)).toBe('-quicktest')
  })
})

describe('buildRunSpec: what the image says', () => {
  test('an unlabelled image falls back to the configured executable', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity)
    expect(spec.command).toContain(atlas.executable)
    expect(spec.command[0]).toBe('xvfb-run')
    expect(spec.command).toContain('-savedatafolder=/data')
    expect(spec.command).toContain('/logs/Player.log')
    expect(spec.env.SCREEN).toBeUndefined()
  })

  test('a proton image runs under the windows wrapper with a Z: path', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity, {
      launcher: 'proton',
      executable: 'RimWorldWin64.exe',
    })
    expect(spec.command[0]).toBe('run-headless-windows')
    expect(spec.command[1]).toBe(String.raw`Z:\game\RimWorldWin64.exe`)
    expect(spec.command).not.toContain('xvfb-run')
    expect(spec.env.SCREEN).toBe('1920x1080x24')
    expect(spec.env.DESKTOP).toBe('1920x1080')
  })

  // wine reads a bare unix path as a windows one, and --rm then takes the save with it.
  test('a proton image converts every path it hands the game, not just the executable', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity, { launcher: 'proton' })
    expect(spec.command).toContain(String.raw`-savedatafolder=Z:\data`)
    expect(spec.command).toContain(String.raw`Z:\logs\Player.log`)
    expect(spec.command).not.toContain('-savedatafolder=/data')
    expect(spec.command).not.toContain('/logs/Player.log')
  })

  test('the wine prefix lands on a bind, not on the HOME tmpfs', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity, { launcher: 'proton' })
    const prefix = spec.env.STEAM_COMPAT_DATA_PATH ?? ''
    expect(prefix).toBe('/xdg/proton')
    expect(prefix.startsWith(identity.home)).toBe(false)
    expect(spec.mounts).toContainEqual(
      expect.objectContaining({ type: 'bind', target: '/xdg' }),
    )
  })

  test('WINEPATH is never defaulted: the ffmpeg it pointed at is gone', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity, { launcher: 'proton' })
    expect(spec.env.WINEPATH).toBeUndefined()
  })

  test('a direct image still gets xvfb-run, with the label executable', () => {
    const spec = buildRunSpec(plan('atlas', atlas), [], identity, {
      launcher: 'direct',
      executable: './RimWorldLinux',
    })
    expect(spec.command.slice(0, 2)).toEqual(['xvfb-run', '-a'])
    expect(spec.command).toContain('./RimWorldLinux')
    expect(spec.command).toContain('-savedatafolder=/data')
  })

  test('a proton image refuses a headed launch instead of opening nothing', () => {
    expect(() =>
      buildRunSpec(plan('atlas', atlas, {}, 'headed'), [], identity, { launcher: 'proton' }),
    ).toThrow(GamecrateError)
    expect(() => refuseProtonHeaded('atlas', 'headed', { launcher: 'proton' })).toThrow(
      expect.objectContaining({ code: Exit.Config }),
    )
  })

  // `gamecrate shell` passes no ImageLaunch, so the refusal must not fire: bash starts no game.
  test('a shell run against a proton image is not refused', () => {
    expect(() => refuseProtonHeaded('atlas', 'headed', undefined)).not.toThrow()
    expect(() => buildRunSpec(plan('atlas', atlas, {}, 'headed'), [], identity)).not.toThrow()
  })

  test('a proton image offscreen is not refused', () => {
    expect(() => refuseProtonHeaded('atlas', 'headless', { launcher: 'proton' })).not.toThrow()
    expect(() => refuseProtonHeaded('atlas', 'headed', { launcher: 'direct' })).not.toThrow()
  })
})

// index.ts exits the process at import, so nothing can call execute() or runWithMarker. The
// wiring is pinned by reading the source, the way image.test.ts already pins the check order.
describe('run wires the launch path', () => {
  const source = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '../src/index.ts'),
    'utf8',
  )

  test('a shell run hands buildRunSpec no image launch, and runs bash', () => {
    expect(source).toContain('const imageStart = asShell ? undefined : imageLaunch(facts)')
    expect(source).toContain('buildRunSpec(plan, modMounts, identity, imageStart)')
    expect(source).toContain("spec.command = ['/bin/bash']")
    expect(source).not.toContain('buildRunSpec(plan, modMounts, identity, imageLaunch(facts))')
  })

  test('a shell run skips the marker gate', () => {
    expect(source).toContain('asShell ? null : markerProblem(')
  })

  test('the mode refusal reads before the marker gate', () => {
    const mode = source.indexOf('refuseProtonHeaded(game,')
    const marker = source.indexOf('markerProblem({')
    expect(mode).toBeGreaterThan(-1)
    expect(marker).toBeGreaterThan(mode)
  })

  // Swapped arms are a silent bug: CI reads 6 as "the game died" and 1 as "it timed out".
  const arms = /waited === false \? \{ code: (Exit\.\w+).+?: \{ code: (Exit\.\w+)/.exec(
    source.slice(source.indexOf('container exited before the marker')).replace(/\s+/g, ' '),
  )

  test('a marker watch that ran its full timeout is MarkerTimeout', () => {
    expect(arms?.[1]).toBe('Exit.MarkerTimeout')
  })

  test('a container that stopped while the watch was still polling is GameFailed', () => {
    expect(arms?.[2]).toBe('Exit.GameFailed')
  })
})

describe('waitForMarker', () => {
  test('finds a marker that arrives after the watch starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-log-'))
    const log = join(dir, 'stdout.log')
    writeFileSync(log, 'booting\n')
    setTimeout(() => writeFileSync(log, 'booting\nDSD: ready\n'), 300)
    expect(await waitForMarker([log], 'DSD: ready', 5)).toBe(true)
  })

  test('returns false when the marker never appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-log-'))
    const log = join(dir, 'stdout.log')
    writeFileSync(log, 'booting\n')
    expect(await waitForMarker([log], 'never happens', 0.4)).toBe(false)
  })

  test('matches a marker that only ever reaches the game log, never stdout', async () => {
    // Atlas routes Verse.Log to -logfile, so a stdout-only watch can never see this.
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-log-'))
    const stdout = join(dir, 'stdout.log')
    const player = join(dir, 'Player.log')
    writeFileSync(stdout, 'Unity boot noise\n')
    writeFileSync(player, 'loading\n')
    setTimeout(() => writeFileSync(player, 'loading\n[Bridge.Coex] bridge-active\n'), 300)
    expect(await waitForMarker([stdout, player], '[Bridge.Coex] bridge-active', 5)).toBe(true)
  })

  test('watches a directory of logs, which is what copy-out games need', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-log-'))
    const logs = join(dir, 'Logs')
    mkdirSync(logs, { recursive: true })
    setTimeout(() => writeFileSync(join(logs, 'Player.log'), 'Bridge v1.2 loaded\n'), 300)
    expect(await waitForMarker([logs], 'Bridge v1.2', 5)).toBe(true)
  })

  test('finds a marker split across two appends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-log-'))
    const log = join(dir, 'stdout.log')
    // Both writes land after the watch starts, the way a live log actually grows.
    setTimeout(() => appendFileSync(log, 'DSD: re'), 250)
    setTimeout(() => appendFileSync(log, 'ady\n'), 600)
    expect(await waitForMarker([log], 'DSD: ready', 5)).toBe(true)
  })

  test('ignores what a log already held before the watch started', async () => {
    // Logs/Player-prev.log carries the previous run's marker; matching it is a false pass.
    const dir = mkdtempSync(join(tmpdir(), 'gamecrate-log-'))
    const stale = join(dir, 'Player-prev.log')
    writeFileSync(stale, 'Bridge v1.2 loaded from the LAST run\n')
    utimesSync(stale, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    expect(await waitForMarker([dir], 'Bridge v1.2', 1)).toBe(false)
  })
})

describe('entrypoint', () => {
  test('is always stated, because the image ENTRYPOINT may be a shell', () => {
    const argv = toDockerArgs({
      image: 'img', name: 'n', labels: {}, env: {}, mounts: [], devices: [],
      deviceCgroupRules: [], network: 'none', memory: '1g', memorySwap: '1g',
      cpus: 1, pidsLimit: 8, ulimits: [], workdir: '/game', extraArgs: [],
      identity: { uid: 1000, gid: 1000, home: '/tmp/home', user: 'a' },
      command: ['./AtlasLinux', '-savedatafolder=/data'],
    })
    const at = argv.indexOf('--entrypoint')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe('./AtlasLinux')
    // The executable must not also appear after the image name.
    expect(argv.slice(argv.indexOf('img'))).toEqual(['img', '-savedatafolder=/data'])
  })
})

describe('network default', () => {
  test('the shipped default is bridge', () => {
    expect(DEFAULT_SETTINGS.network).toBe('bridge')
  })

  test('whatever the setting says reaches --network', () => {
    const argv = toDockerArgs(
      buildRunSpec(plan('atlas', atlas, { network: 'bridge' }), [], identity),
    )
    const at = argv.indexOf('--network')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe('bridge')
  })
})

describe('capture', () => {
  test('both streams arrive whole, stderr past the pipe buffer included, with the real exit code', async () => {
    const script = [
      String.raw`process.stdout.write("  out \n\n")`,
      // the exit waits on the write callback, so the child cannot leave stderr buffered.
      'process.stderr.write("e".repeat(400000), () => process.exit(3))',
    ].join(';')
    const result = await capture([process.execPath, '-e', script])
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('  out \n\n')
    expect(result.stderr).toBe('e'.repeat(400_000))
  })

  test('a missing binary is exit 127 with the spawn error as stderr', async () => {
    const result = await capture(['gamecrate-no-such-binary-9f2c'])
    expect(result.code).toBe(127)
    expect(result.stdout).toBe('')
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

describe('window claims', () => {
  test('xprop output becomes a pid', () => {
    expect(parseWindowPid('_NET_WM_PID(CARDINAL) = 12345\n')).toBe(12345)
  })

  test('a window with no pid property is unclaimed', () => {
    expect(parseWindowPid('_NET_WM_PID:  not found.\n')).toBeUndefined()
    expect(parseWindowPid('')).toBeUndefined()
  })

  // Deliberately a spawned gamecrate rather than process.pid: the test runner only has
  // 'gamecrate' in its cmdline because this checkout sits under a directory of that name, so
  // this test would quietly lose its teeth from a checkout named anything else. The precondition
  // is asserted because everything after it reads false when the child is not a gamecrate, so a
  // construction that failed would pass rather than go red.
  test('a pid does not count as a peer claim against itself', async () => {
    const child = fakeSupervisor()
    try {
      await waitFor(() => readCmdline(child.pid!).includes('gamecrate'))
      expect(readCmdline(child.pid!)).toContain('gamecrate')
      expect(isPeerClaim(child.pid!, child.pid!)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a live process we can signal but is not a gamecrate is not a peer claim', () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      expect(isPeerClaim(child.pid!, process.pid)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a live gamecrate supervisor that is not us is a peer claim', async () => {
    const child = fakeSupervisor()
    try {
      await waitFor(() => readCmdline(child.pid!).includes('gamecrate'))
      expect(isPeerClaim(child.pid!, process.pid)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a dead pid is not a peer claim', () => {
    expect(isPeerClaim(deadPid(), process.pid)).toBe(false)
  })
})

describe('window candidates', () => {
  const seen = new Set(['0x01'])
  const windows = [
    { id: '0x01', wmClass: 'rimworldlinux.RimWorldLinux' },
    { id: '0x02', wmClass: 'rimworldlinux.RimWorldLinux' },
    { id: '0x03', wmClass: 'firefox.firefox' },
    { id: '0x04', wmClass: 'rimworldlinux.RimWorldLinux' },
  ]

  test('every new window of this game is a candidate, in order', () => {
    const got = newMatches(windows, seen, '/game/RimWorldLinux')
    expect(got.map((w) => w.id)).toEqual(['0x02', '0x04'])
  })

  test('a window that was already up is not a candidate', () => {
    const all = new Set(['0x01', '0x02', '0x04'])
    expect(newMatches(windows, all, '/game/RimWorldLinux')).toEqual([])
  })
})

/** argv0 rather than `exec -a`: dash has no such builtin, and /bin/sh is dash on debian. */
function fakeSupervisor(): ChildProcess {
  return spawn('sleep', ['30'], { stdio: 'ignore', argv0: 'gamecrate --supervised' })
}

function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return ''
  }
}

async function waitFor(ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
}
