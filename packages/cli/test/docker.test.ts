import { describe, expect, test } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/config/builtin'
import { buildRunSpec, toDockerArgs, windowTitle } from '../src/docker/spec'
import { resolveIdentity } from '../src/docker/identity'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { capture, waitForMarker } from '../src/docker/run'
import { runtimeLayerRef } from '../src/launch/prepare'
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
    expect(headed[entry + 1]).toBe('./AtlasLinux')

    const at = headed.indexOf('atlas-build:latest')
    expect(at).toBeGreaterThan(0)
    expect(headed.slice(at + 1)).toEqual(['-savedatafolder=/data', '-logfile', '/logs/Player.log'])
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
        expect(mountFor(args, '/tmp/.X11-unix')).toBeDefined()
        expect(mountFor(args, '/tmp/xauth')).toContain('readonly')
        expect(valuesOf(args, '--hostname')).toEqual([hostname()])
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

describe('runtimeLayerRef', () => {
  test('a tagged ref keeps its tag', () => {
    expect(runtimeLayerRef('example/atlas:1.6')).toBe('example/atlas:1.6-gamecrate')
  })

  test('an untagged ref gets latest', () => {
    expect(runtimeLayerRef('example/atlas')).toBe('example/atlas:latest-gamecrate')
  })

  test('a registry port is not a tag', () => {
    expect(runtimeLayerRef('localhost:5000/atlas')).toBe('localhost:5000/atlas:latest-gamecrate')
    expect(runtimeLayerRef('localhost:5000/atlas:1.6')).toBe('localhost:5000/atlas:1.6-gamecrate')
  })

  test('a digest pin becomes a tag docker will accept', () => {
    const ref = 'ghcr.io/example/atlas@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect(runtimeLayerRef(ref)).toBe('ghcr.io/example/atlas:sha-0123456789ab-gamecrate')
  })

  test('a ref pinned by tag and digest keeps one tag, not two', () => {
    const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect(runtimeLayerRef(`ghcr.io/example/atlas:1.6@${digest}`)).toBe(
      'ghcr.io/example/atlas:sha-0123456789ab-gamecrate',
    )
    expect(runtimeLayerRef(`localhost:5000/atlas:1.6@${digest}`)).toBe('localhost:5000/atlas:sha-0123456789ab-gamecrate')
    expect(runtimeLayerRef(`localhost:5000/atlas@${digest}`)).toBe('localhost:5000/atlas:sha-0123456789ab-gamecrate')
  })

  // A tag is at most 128 chars of [A-Za-z0-9_.-] after the first alphanumeric.
  test('every derived tag is a legal docker tag', () => {
    const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const refs = [
      'example/atlas',
      'example/atlas:1.6',
      'localhost:5000/atlas:1.6',
      `ghcr.io/example/atlas@${digest}`,
      `ghcr.io/example/atlas:1.6@${digest}`,
      `localhost:5000/atlas:1.6@${digest}`,
    ]
    for (const ref of refs) {
      const derived = runtimeLayerRef(ref)
      const tag = derived.split(':').at(-1)!
      expect(tag).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      // Exactly one tag: a name:tag:tag ref is what docker build --tag rejects.
      expect(derived.slice(derived.lastIndexOf('/') + 1).split(':')).toHaveLength(2)
    }
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

  // Deliberately a spawned gamecrate rather than process.pid: the vitest worker only has
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
