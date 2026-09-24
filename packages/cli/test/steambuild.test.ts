import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Exit, GamecrateError } from '../src/types'
import type { RootConfig, SteamVariant } from '../src/types'

const state = vi.hoisted(() => ({
  /** Every faked collaborator call, in order. */
  calls: [] as string[],
  labels: new Map<string, Record<string, string>>(),
  mutated: new Map<string, Record<string, string>>(),
  /** The local daemon: `docker build --label` writes here, `docker image inspect` reads it. */
  local: new Map<string, Record<string, string>>(),
  published: null as string | null,
  pushFails: (_ref: string): boolean => false,
  /** What the registry said. undefined is the no-detail case: crane printed nothing. */
  pushDetail: undefined as string | undefined,
  /** True when the host docker config uses a credential helper the crane container cannot run. */
  credsRefused: false,
  downloads: [] as string[],
  /** Every out tar craneAppend was asked for, so a test can prove each one is gone. */
  tars: [] as string[],
  /** The tag the last append wrote into the tar. docker load names the image after it. */
  appendTag: '',
  /** What docker load reports. The tar's own tag, unless a test says otherwise. */
  loadedAs: (): string => state.appendTag,
  gameDir: '',
}))

vi.mock('../src/image/crane', () => ({
  CRANE_IMAGE: 'fake/crane',
  checkRegistryAuthEarly: (ref: string) => {
    state.calls.push('creds')
    if (!state.credsRefused) return
    throw new GamecrateError(`no registry credentials for ${ref}`, Exit.Environment, 'set the env vars')
  },
  craneAppend: async (opts: { out: string; tag: string }) => {
    state.calls.push(`append ${opts.out}`)
    state.tars.push(opts.out)
    // crane refuses an append with no -t, so the fake refuses one too
    if (!opts.tag) {
      const detail = 'required flag(s) "new_tag" not set'
      throw new GamecrateError(`crane append for ${opts.out} failed`, Exit.Environment, detail)
    }
    state.appendTag = opts.tag
    // a real append leaves a game-sized tar behind, so the fake leaves one too
    await writeFile(opts.out, 'fake oci tar')
  },
  cranePush: (_tar: string, ref: string) => {
    state.calls.push('push')
    // the real one retries, then throws with the registry's own words in the detail
    if (state.pushFails(ref)) {
      return Promise.reject(new GamecrateError(`crane push refused ${ref}`, Exit.Environment, state.pushDetail))
    }
    return Promise.resolve()
  },
  craneMutateLabels: (ref: string, labels: Record<string, string>) => {
    state.calls.push('mutate')
    state.mutated.set(ref, labels)
    return Promise.resolve()
  },
  craneTag: () => {
    state.calls.push('tag')
    return Promise.resolve()
  },
  craneLabels: (ref: string) => Promise.resolve(state.labels.get(ref) ?? null),
}))

vi.mock('../src/mods/steamcmd', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mods/steamcmd')>()
  return {
    ...real,
    publishedBuildId: () => Promise.resolve(state.published),
    downloadApp: (_config: unknown, opts: { branch: string; depot?: string }) => {
      state.downloads.push(`${opts.branch}/${opts.depot ?? 'default'}`)
      return Promise.resolve({ dir: state.gameDir, warnings: [] })
    },
  }
})

vi.mock('../src/docker/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/docker/run')>()
  return {
    ...real,
    capture: (argv: string[]) => {
      state.calls.push(argv.slice(0, 2).join(' '))
      // the tar carries the tag the append gave it, and that is the name docker prints
      if (argv[1] === 'load') {
        return Promise.resolve({ code: 0, stdout: `Loaded image: ${state.loadedAs()}\n`, stderr: '' })
      }
      if (argv[1] === 'build') {
        const labels: Record<string, string> = {}
        for (let i = 0; i < argv.length; i += 1) {
          if (argv[i] !== '--label') continue
          const [key, value] = argv[i + 1]!.split(/=(.*)/s)
          labels[key!] = value!
        }
        state.local.set(argv[argv.indexOf('-t') + 1]!, labels)
        return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      }
      if (argv[1] === 'tag') {
        state.local.set(argv[3]!, state.local.get(argv[2]!) ?? {})
        return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      }
      if (argv[1] === 'image') {
        const found = state.local.get(argv.at(-1)!)
        if (found === undefined) return Promise.resolve({ code: 1, stdout: '', stderr: 'No such image' })
        return Promise.resolve({ code: 0, stdout: `${JSON.stringify(found)}\n`, stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    },
  }
})

import { RUNTIME_BASE } from '../src/image/base'
import { steamBuild } from '../src/image/build'
import type { CellResult, SteamBuildOptions } from '../src/image/build'

const VARIANTS: SteamVariant[] = [
  { name: 'linux', base: 'xvfb', include: [] },
  { name: 'windows', base: 'proton', include: [], depot: 'windows', executable: 'RimWorldWin64.exe' },
  { name: 'linux-ref', base: 'none', include: ['Version.txt'] },
]

const IMAGE = 'ghcr.io/rimworks/rimworld-game'
let tmp = ''
let config: RootConfig

const ONE = {
  game: 'rimworld',
  steamAppId: 294100,
  versionFile: 'Version.txt',
  gamePath: '/game',
  executable: './RimWorldLinux',
  branches: [{ name: 'public' }],
  variants: VARIANTS,
  image: IMAGE,
}
const TWO = { ...ONE, branches: [{ name: 'public' }, { name: '1.5' }] }

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-steambuild-'))
  state.gameDir = join(tmp, 'game')
  await mkdir(state.gameDir, { recursive: true })
  await writeFile(join(state.gameDir, 'Version.txt'), '1.6.4871 rev598\n')
  config = { dataRoot: join(tmp, 'data'), games: {} } as RootConfig
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

let opts: SteamBuildOptions

beforeEach(() => {
  state.calls.length = 0
  state.downloads.length = 0
  state.tars.length = 0
  state.appendTag = ''
  state.loadedAs = () => state.appendTag
  state.credsRefused = false
  state.labels.clear()
  state.mutated.clear()
  state.local.clear()
  state.published = '9999'
  state.pushFails = () => false
  state.pushDetail = undefined
  opts = { config, push: true, load: false, platform: 'linux/amd64', force: false }
})

function byVariant(results: CellResult[], variant: string): CellResult {
  const row = results.find((r) => r.variant === variant)
  if (row === undefined) throw new Error(`no row for ${variant}: ${results.map((r) => r.variant).join(', ')}`)
  return row
}

async function fails(run: Promise<unknown>): Promise<GamecrateError> {
  return run.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: GamecrateError) => error,
  )
}

describe('steamBuild', () => {
  test('a push failure on one cell leaves the others built', async () => {
    state.pushFails = (ref) => ref.includes('windows')
    const results = await steamBuild(ONE, opts)
    expect(results.map((r) => r.status)).toEqual(['built', 'failed', 'built'])
    expect(results.find((r) => r.status === 'failed')?.variant).toBe('windows')
    expect(byVariant(results, 'windows').reason).toContain('refused')
  })

  test('the gate skips an up-to-date cell and builds a missing one', async () => {
    state.labels.set(`${IMAGE}:latest`, { 'steam.buildid': '9999' })
    const results = await steamBuild(ONE, opts)
    expect(byVariant(results, 'linux').status).toBe('skipped')
    expect(byVariant(results, 'linux').reason).toBe('up-to-date')
    expect(byVariant(results, 'windows').status).toBe('built')
    expect(state.downloads).toEqual(['public/windows', 'public/default'])
  })

  test('--variant and --beta each narrow one axis', async () => {
    const results = await steamBuild(TWO, { ...opts, onlyBranches: ['1.5'], onlyVariants: ['linux'] })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ branch: '1.5', variant: 'linux' })
  })

  test('narrowing to one variant does not promote it to the bare latest tag', async () => {
    const results = await steamBuild(ONE, { ...opts, onlyVariants: ['linux-ref'] })
    expect(byVariant(results, 'linux-ref').tags).toEqual(['1.6.4871-linux-ref', 'latest-linux-ref'])
  })

  test('crane tag runs only after a successful push', async () => {
    await steamBuild(ONE, opts)
    expect(state.calls.indexOf('push')).toBeLessThan(state.calls.indexOf('tag'))

    state.calls.length = 0
    state.pushFails = () => true
    await steamBuild(ONE, opts)
    expect(state.calls).not.toContain('tag')
    expect(state.calls).not.toContain('mutate')
  })

  test('two variants on one depot share a single download per branch', async () => {
    const results = await steamBuild(TWO, opts)
    expect(results).toHaveLength(6)
    expect(state.downloads).toEqual([
      'public/default',
      'public/windows',
      '1.5/default',
      '1.5/windows',
    ])
  })

  test('an unknown variant refuses the run and lists the declared names', async () => {
    const error = await fails(steamBuild(ONE, { ...opts, onlyVariants: ['macos'] }))
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('macos')
    expect(error.detail).toBe('declared variants: linux, windows, linux-ref')
  })

  test('an unknown branch says branches, not branchs', async () => {
    const error = await fails(steamBuild(TWO, { ...opts, onlyBranches: ['mybeta'] }))
    expect(error.code).toBe(Exit.Usage)
    expect(error.message).toContain('mybeta')
    expect(error.detail).toBe('declared branches: public, 1.5')
  })

  test('the default --load run skips a base: none variant and loads the rest', async () => {
    const results = await steamBuild(ONE, { ...opts, push: false, load: true })
    expect(results.map((r) => `${r.variant} ${r.status}`)).toEqual([
      'linux built',
      'windows built',
      'linux-ref skipped',
    ])
    const ref = byVariant(results, 'linux-ref')
    expect(ref.reason).toBe('reference-only, use --push')
    expect(ref.tags).toEqual([])
    // nothing appended for it either: a tar it cannot load is a game-sized write for no one
    expect(state.calls.filter((c) => c.startsWith('append'))).toHaveLength(2)
    expect(state.calls.filter((c) => c === 'docker load')).toHaveLength(2)
    expect(state.calls.filter((c) => c === 'docker build')).toHaveLength(2)
    expect(state.local.has(`${IMAGE}:1.6.4871-linux-ref`)).toBe(false)
  })

  test('--push --load still pushes a base: none variant, and never loads it', async () => {
    const results = await steamBuild(ONE, { ...opts, push: true, load: true, onlyVariants: ['linux-ref'] })
    expect(byVariant(results, 'linux-ref').status).toBe('built')
    expect(state.calls).toContain('push')
    expect(state.calls).toContain('mutate')
    expect(state.calls).not.toContain('docker load')
    expect(state.calls).not.toContain('docker build')
  })

  test('--load labels the versioned tag, tags the rest off it, and never touches a registry', async () => {
    const results = await steamBuild(ONE, { ...opts, push: false, load: true, onlyVariants: ['linux'] })
    expect(byVariant(results, 'linux').status).toBe('built')
    expect(state.calls.filter((c) => c === 'docker build')).toHaveLength(1)
    // the tar already carries the versioned tag, so only the three moving tags are tagged
    expect(state.calls.filter((c) => c === 'docker tag')).toHaveLength(3)
    expect(state.calls.indexOf('docker build')).toBeLessThan(state.calls.lastIndexOf('docker tag'))
    expect(state.calls).not.toContain('push')
    // the same six a --push cell mutates on, so the two paths cannot drift
    expect(state.local.get(`${IMAGE}:1.6.4871`)).toEqual({
      'steam.buildid': '9999',
      'gamecrate.variant': 'linux',
      'gamecrate.branch': 'public',
      'gamecrate.executable': './RimWorldLinux',
      'gamecrate.launcher': 'direct',
      'gamecrate.runtime': RUNTIME_BASE.xvfb,
    })
    expect(state.local.get(`${IMAGE}:latest`)).toEqual(state.local.get(`${IMAGE}:1.6.4871`))
  })

  test('the append is tagged with the versioned ref, so docker load names the image', async () => {
    await steamBuild(ONE, { ...opts, push: false, load: true, onlyVariants: ['linux'] })
    expect(state.appendTag).toBe(`${IMAGE}:1.6.4871`)
  })

  test('a load that names a different image fails the cell', async () => {
    // the tar carries its own name now, so a mismatch is the only way to catch a wrong tag
    state.loadedAs = () => `${IMAGE}:something-else`
    const results = await steamBuild(ONE, { ...opts, push: false, load: true, onlyVariants: ['linux'] })
    expect(byVariant(results, 'linux').status).toBe('failed')
    expect(byVariant(results, 'linux').reason).toContain('docker load failed')
    expect(state.calls).not.toContain('docker build')
  })

  test('a --load cell with no local image builds, and one with an unlabelled image builds too', async () => {
    const load = { ...opts, push: false, load: true, onlyVariants: ['linux'] }
    expect(byVariant(await steamBuild(ONE, load), 'linux').reason).toBe('no-image')

    state.local.clear()
    // a base image's own labels come through, so present and unlabelled is a real state
    state.local.set(`${IMAGE}:latest`, { 'org.opencontainers.image.version': '24.04' })
    const results = await steamBuild(ONE, load)
    expect(byVariant(results, 'linux').status).toBe('built')
    expect(byVariant(results, 'linux').reason).toBe('no-label')
  })

  test('every cell deletes its own tar, built or failed', async () => {
    state.pushFails = (ref) => ref.includes('windows')
    const results = await steamBuild(ONE, opts)
    expect(results.map((r) => r.status)).toEqual(['built', 'failed', 'built'])
    expect(state.tars).toHaveLength(3)
    expect(state.tars.filter((tar) => existsSync(tar))).toEqual([])
  })

  test('a failed cell reports the registry text, not only that the push failed', async () => {
    state.pushFails = (ref) => ref.includes('windows')
    state.pushDetail = 'UNAUTHORIZED: authentication required\nDENIED: requested access to the resource is denied'
    const reason = byVariant(await steamBuild(ONE, opts), 'windows').reason
    expect(reason).toContain('crane push refused')
    expect(reason).toContain('UNAUTHORIZED: authentication required')
    // the table is one line per row
    expect(reason).not.toContain('\n')
  })

  test('a failure with no detail reads cleanly, with no trailing colon', async () => {
    state.pushFails = (ref) => ref.includes('windows')
    expect(byVariant(await steamBuild(ONE, opts), 'windows').reason).toBe(`crane push refused ${IMAGE}:1.6.4871-windows`)
  })

  test('a cell failing on a missing branch password names the variable to set', async () => {
    const branches = [{ name: 'unstable', password: true }]
    const reason = byVariant(await steamBuild({ ...ONE, branches }, opts), 'linux').reason
    expect(reason).toContain('branch "unstable" needs a password')
    expect(reason).toContain('STEAM_BRANCH_PASSWORD_UNSTABLE')
  })

  test('a credential-helper config refuses the push run before anything downloads', async () => {
    state.credsRefused = true
    const error = await fails(steamBuild(ONE, opts))
    expect(error.code).toBe(Exit.Environment)
    expect(error.message).toContain(IMAGE)
    expect(state.downloads).toEqual([])
    expect(state.calls).toEqual(['creds'])
  })

  test('a --load run never asks for registry credentials', async () => {
    await steamBuild(ONE, { ...opts, push: false, load: true, onlyVariants: ['linux'] })
    expect(state.calls).not.toContain('creds')
  })

  test('a second --load run reads back its own labels and skips', async () => {
    const load = { ...opts, push: false, load: true, onlyVariants: ['linux'] }
    await steamBuild(ONE, load)
    state.calls.length = 0
    const results = await steamBuild(ONE, load)
    expect(byVariant(results, 'linux').status).toBe('skipped')
    expect(byVariant(results, 'linux').reason).toBe('up-to-date')
    expect(state.calls.filter((c) => c.startsWith('append'))).toHaveLength(0)
  })

  test('the labels carry the buildid, the runtime and the launcher', async () => {
    await steamBuild(ONE, opts)
    expect(state.mutated.get(`${IMAGE}:1.6.4871-windows`)).toMatchObject({
      'steam.buildid': '9999',
      'gamecrate.variant': 'windows',
      'gamecrate.branch': 'public',
      'gamecrate.executable': 'RimWorldWin64.exe',
      'gamecrate.launcher': 'proton',
    })
    expect(state.mutated.get(`${IMAGE}:1.6.4871-linux-ref`)).not.toHaveProperty('gamecrate.runtime')
  })
})
