import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config/builtin'
import { FIXTURE_STEAM_BUILD, FIXTURE_VERSION, fixturePlugin } from './fixture-plugin'
import type { GameConfig, LaunchPlan, ModeName } from '../src/types'

const REF = 'ghcr.io/rimworks/atlas-game:foreign'

const state = vi.hoisted(() => ({
  present: true,
  labels: {} as Record<string, string>,
}))

vi.mock('../src/docker/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/docker/run')>()
  const ok = { code: 0, stdout: '', stderr: '' }
  const gone = { code: 1, stdout: '', stderr: 'No such image\n' }
  return {
    ...real,
    capture: (argv: string[]) => {
      // presence: `docker image inspect --format {{.Id}}`. the label reads pass their own format.
      if (argv.includes('{{.Id}}')) {
        return Promise.resolve(state.present ? { ...ok, stdout: 'sha256:abc\n' } : gone)
      }
      const label = argv.find((arg) => arg.startsWith('{{index .Config.Labels'))
      if (label !== undefined) {
        if (!state.present) return Promise.resolve(gone)
        const name = label.match(/"([^"]+)"/)?.[1] ?? ''
        return Promise.resolve({ ...ok, stdout: `${state.labels[name] ?? '<no value>'}\n` })
      }
      // manifest inspect, for an absent image that would have to be pulled.
      if (argv[1] === 'manifest') return Promise.resolve(gone)
      return Promise.resolve(ok)
    },
  }
})

const { preflight } = await import('../src/docker/preflight')

const atlas: GameConfig = {
  gameFiles: { source: 'image', container: '/game' },
  dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
  modsDir: { container: '/game/Mods' },
  logFile: { mode: 'arg', arg: '-logfile' },
  image: { ref: REF, acquire: 'pull' },
  executable: './AtlasLinux',
  steamAppId: 294100,
  workshopRoot: null,
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

function plan(mode: ModeName, marker?: string): LaunchPlan {
  const profileDir = '/fixtures/data/atlas/modless'
  return {
    game: 'atlas',
    gameConfig: atlas,
    plugin: fixturePlugin(),
    profile: 'modless',
    settings: { ...DEFAULT_SETTINGS, gpu: false, display: 'wayland' },
    mods: [],
    warnOnStale: true,
    profileDir,
    instanceDir: profileDir,
    dataDirHost: `${profileDir}/game`,
    configDirHost: `${profileDir}/config`,
    stageDirHost: `${profileDir}/.stage`,
    logsDirHost: `${profileDir}/logs/runs/1`,
    runDirHost: `${profileDir}/logs/runs/1`,
    mode,
    timeoutSeconds: 300,
    renderWaitSeconds: 20,
    warnings: [],
    ...(marker === undefined ? {} : { marker }),
  }
}

/** Restores the image state afterwards, so one test's absent image cannot leak into the next. */
async function withImage(
  image: { present?: boolean; labels?: Record<string, string> },
  run: () => Promise<void>,
): Promise<void> {
  const previous = { present: state.present, labels: state.labels }
  state.present = image.present ?? true
  state.labels = image.labels ?? {}
  try {
    await run()
  } finally {
    state.present = previous.present
    state.labels = previous.labels
  }
}

const BUILT = { 'gamecrate.runtime': 'sha256:base', 'gamecrate.executable': './AtlasLinux' }
const PROTON = { ...BUILT, 'gamecrate.launcher': 'proton' }

describe('preflight image preconditions', () => {
  test('a headless launch on an image gamecrate did not build is a problem', async () => {
    const problems = await preflight(plan('headless'))
    expect(problems.some((p) => p.message.includes('gamecrate.runtime'))).toBe(true)
  })

  test('the same image is fine headed, and no host executable check runs for it', async () => {
    const problems = await preflight(plan('headed'))
    expect(problems.some((p) => p.message.includes('gamecrate.runtime'))).toBe(false)
    expect(problems.some((p) => p.message.includes('AtlasLinux'))).toBe(false)
  })

  test('an image that is neither local nor pullable points at steam build', async () => {
    await withImage({ present: false }, async () => {
      const problems = await preflight(plan('headed'))
      expect(problems.some((p) => p.suggestion === 'gamecrate steam build atlas')).toBe(true)
    })
  })

  test('an absent image is reported once, not once per branch', async () => {
    await withImage({ present: false }, async () => {
      const problems = await preflight(plan('headless'))
      const named = problems.filter((p) => p.message.includes(REF))
      expect(named).toHaveLength(1)
      expect(named[0]!.message).toContain('could not be pulled')
    })
  })

  test('an empty image.ref points at steam build', async () => {
    const empty = plan('headed')
    empty.gameConfig = { ...atlas, image: { ref: '', acquire: 'pull' } }
    const problems = await preflight(empty)
    expect(problems.some((p) => p.message.includes('no image.ref configured'))).toBe(true)
  })

  test('an image gamecrate built has nothing to say in any mode', async () => {
    await withImage({ labels: BUILT }, async () => {
      for (const mode of ['headed', 'headless', 'screenshot'] as ModeName[]) {
        const problems = await preflight(plan(mode))
        expect(problems.filter((p) => p.message.includes(REF))).toEqual([])
      }
    })
  })
})

// the late throw in execute() lands after buildLocalMods has compiled assemblies, so doctor has
// to name a missing marker before a person waits through a build to hear about a flag.
describe('preflight reports the proton marker refusal', () => {
  test('a proton image with no --marker is a problem doctor can report', async () => {
    await withImage({ labels: PROTON }, async () => {
      const problems = await preflight(plan('headless'))
      const marker = problems.find((p) => p.message.includes('proton'))
      expect(marker).toBeDefined()
      expect(marker!.suggestion).toContain('--marker')
    })
  })

  test('a proton image with a marker is fine', async () => {
    await withImage({ labels: PROTON }, async () => {
      const problems = await preflight(plan('headless', 'world loaded'))
      expect(problems.some((p) => p.message.includes('proton'))).toBe(false)
    })
  })

  test('headed does not excuse it, because the exit code is lost either way', async () => {
    await withImage({ labels: PROTON }, async () => {
      const problems = await preflight(plan('headed'))
      expect(problems.some((p) => p.message.includes('proton'))).toBe(true)
    })
  })

  test('a direct-launcher image with no marker is not a problem', async () => {
    await withImage({ labels: { ...BUILT, 'gamecrate.launcher': 'direct' } }, async () => {
      const problems = await preflight(plan('headless'))
      expect(problems.some((p) => p.message.includes('proton'))).toBe(false)
    })
  })

  test('an absent image is not called a proton image', async () => {
    await withImage({ present: false }, async () => {
      const problems = await preflight(plan('headless'))
      expect(problems.some((p) => p.message.includes('proton'))).toBe(false)
    })
  })
})
