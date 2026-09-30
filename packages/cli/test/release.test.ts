import { afterEach, describe, expect, mock, test } from 'bun:test'

const realCp = { ...(await import('node:child_process')) }

type UnzipMode = 'ok' | 'missing' | 'fail'
let unzipMode: UnzipMode = 'ok'
let unzipCalls: string[][] = []
let unzipPayload: (dir: string) => void = () => {}
let unzipEntries: string[] = ['Mod/About/About.txt']

const cp = {
  ...realCp,
  spawnSync: (cmd: string, args?: unknown, opts?: Record<string, unknown>) => {
    if (cmd === 'unzip') {
      const argv = (args as string[]) ?? []
      unzipCalls.push(argv)
      if (argv[0] === '-v') return { status: unzipMode === 'missing' ? 1 : 0, stdout: '', stderr: '' }
      if (unzipMode === 'missing') return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn unzip ENOENT'), { code: 'ENOENT' }) }
      if (unzipMode === 'fail') return { status: 9, stdout: '', stderr: 'End-of-central-directory signature not found' }
      if (argv[0] === '-Z1') return { status: 0, stdout: `${unzipEntries.join('\n')}\n`, stderr: '' }
      if (argv[0] === '-Z') {
        const rows = unzipEntries.map((entry) => `-rw-r--r--  3.0 unx 12 tx stor 26-Sep-29 00:00 ${entry}`)
        return { status: 0, stdout: `Archive:  ${String(argv[1])}\n${rows.join('\n')}\n1 file\n`, stderr: '' }
      }
      unzipPayload(argv[4] as string)
      return { status: 0, stdout: '', stderr: '' }
    }
    return (realCp.spawnSync as (...a: unknown[]) => unknown)(cmd, args, { env: process.env, ...opts })
  },
}
await mock.module('node:child_process', () => ({ ...cp, default: cp }))

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FIXTURE_STEAM_BUILD, FIXTURE_VERSION, fixturePlugin } from './fixture-plugin'
import { Exit } from '../src/types'
import type { GameConfig, GamecrateError, ParsedArgs, ProfileConfig } from '../src/types'

const { buildIndex } = await import('../src/mods/modindex')
const { resolvePlan } = await import('../src/launch/resolve')
const { cachedSources, ensureRelease, prepareSources, releaseDir, soleReleaseDir, sourcesRoot } =
  await import('../src/mods/source')
const { parseRepo, pickAsset, readRelease, releaseToken, unzipInto, unzipPresent } =
  await import('../src/mods/release')
const { modsAdd, modsSync } = await import('../src/cli/mods')
const { parseArgs } = await import('../src/cli/args')
const { fixtureGame, pluginMap } = await import('./fixture-plugin')

const REPO = 'Owner/Mod'

const temps: string[] = []

afterEach(() => {
  unzipMode = 'ok'
  unzipCalls = []
  unzipPayload = () => {}
  unzipEntries = ['Mod/About/About.txt']
  delete process.env['GITHUB_TOKEN']
  delete process.env['GH_TOKEN']
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function modAt(dir: string, subdir: string, id: string): string {
  const at = join(dir, subdir, 'About')
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'About.txt'), `packageId ${id}\nname ${id}\n`)
  return join(dir, subdir)
}

/** A mod whose C# beats its DLL by a day, which is what `decideStale` fires on. */
function staleModAt(root: string, id: string): void {
  const dir = modAt(root, 'Mod', id)
  mkdirSync(join(dir, 'Source'), { recursive: true })
  mkdirSync(join(dir, 'Assemblies'), { recursive: true })
  const dll = join(dir, 'Assemblies', 'Mod.dll')
  const cs = join(dir, 'Source', 'Mod.cs')
  writeFileSync(dll, 'MZ')
  writeFileSync(cs, 'class Mod {}')
  utimesSync(dll, 1_700_000_000, 1_700_000_000)
  utimesSync(cs, 1_700_086_400, 1_700_086_400)
}

function gameWith(library: GameConfig['library'], profiles: Record<string, ProfileConfig>): GameConfig {
  const host = temp('gc-game-')
  modAt(join(host, 'Data'), 'Core', 'Atlasco.Atlas')
  return {
    gameFiles: { source: 'mount', host, container: '/game' },
    dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
    modsDir: { container: '/game/Mods' },
    logFile: { mode: 'arg', arg: '-logfile' },
    image: { ref: 'atlas-build:latest' },
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
    core: 'Atlasco.Atlas',
    dlc: [],
    base: [],
    library,
    modes: ['headed', 'headless', 'screenshot'],
    profiles,
  }
}

function cliArgs(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    subcommand: 'run',
    verbTyped: false,
    quiet: false,
    plain: false,
    mods: [],
    without: [],
    only: [],
    dockerArgs: [],
    gameArgs: [],
    dryRun: false,
    printPlan: false,
    json: false,
    root: false,
    yes: false,
    help: false,
    worktree: [],
    use: [],
    noWorktree: false,
    noStaleCheck: false,
    replace: false,
    detach: false,
    noDetach: false,
    noReplace: false,
    follow: false,
    supervised: false,
    variant: [],
    branches: [],
    aliases: [],
    plugin: [],
    rest: [],
    ...over,
  } as ParsedArgs
}

function response(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(status === 204 ? null : text, { status, headers: init.headers ?? {} })
}

interface Call {
  url: string
  headers: Record<string, string>
}

function server(
  routes: (url: string) => Response,
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const seen = String(url)
    calls.push({ url: seen, headers: (init?.headers ?? {}) as Record<string, string> })
    return routes(seen)
  }) as unknown as typeof fetch
  return { impl, calls }
}

function releaseBody(tag: string, names: string[]): unknown {
  return { tag_name: tag, assets: names.map((name) => ({ name, url: `https://api.github.com/assets/${name}` })) }
}

/** Serves one release plus its assets, and counts how many asset downloads it handed out. */
function github(tag: string, names: string[]): { impl: typeof fetch; calls: Call[]; downloads: () => number } {
  const { impl, calls } = server((url) => {
    if (url.includes('/assets/')) return response('PK\u0003\u0004')
    return response(releaseBody(tag, names))
  })
  return { impl, calls, downloads: () => calls.filter((call) => call.url.includes('/assets/')).length }
}

async function caught(run: () => Promise<unknown>): Promise<GamecrateError> {
  try {
    await run()
  } catch (error) {
    return error as GamecrateError
  }
  throw new Error('expected a throw')
}

describe('parseRepo', () => {
  test('accepts owner/repo, and trims a github url or a .git suffix', () => {
    expect(parseRepo('Owner/Mod')).toBe('Owner/Mod')
    expect(parseRepo('https://github.com/Owner/Mod')).toBe('Owner/Mod')
    expect(parseRepo('https://github.com/Owner/Mod.git')).toBe('Owner/Mod')
    expect(parseRepo(' Owner/Mod/ ')).toBe('Owner/Mod')
  })

  test('refuses anything that is not one owner and one repo', async () => {
    for (const bad of ['Owner', 'Owner/Mod/extra', 'owner /mod', '']) {
      const error = await caught(async () => parseRepo(bad))
      expect(error.code).toBe(Exit.Config)
      expect(error.message).toContain('is not a GitHub repository')
    }
  })
})

describe('releaseToken', () => {
  test('prefers GITHUB_TOKEN, falls back to GH_TOKEN, ignores blanks', () => {
    expect(releaseToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' })).toBe('a')
    expect(releaseToken({ GH_TOKEN: 'b' })).toBe('b')
    expect(releaseToken({ GITHUB_TOKEN: '   ', GH_TOKEN: 'b' })).toBe('b')
    expect(releaseToken({})).toBeUndefined()
  })
})

describe('readRelease', () => {
  test('unpinned asks for latest, pinned asks for the tag', async () => {
    const latest = github('v2.0', ['Mod.zip'])
    expect((await readRelease({ repo: REPO }, latest.impl)).tag).toBe('v2.0')
    expect(latest.calls[0]?.url).toBe('https://api.github.com/repos/Owner/Mod/releases/latest')

    const pinned = github('v1.0', ['Mod.zip'])
    await readRelease({ repo: REPO, tag: 'v1.0' }, pinned.impl)
    expect(pinned.calls[0]?.url).toBe('https://api.github.com/repos/Owner/Mod/releases/tags/v1.0')
  })

  test('sends the token as a bearer when one is set, and nothing when it is not', async () => {
    const withToken = github('v1', ['Mod.zip'])
    await readRelease({ repo: REPO }, withToken.impl, { GITHUB_TOKEN: 'secret' })
    expect(withToken.calls[0]?.headers['authorization']).toBe('Bearer secret')

    const without = github('v1', ['Mod.zip'])
    await readRelease({ repo: REPO }, without.impl, {})
    expect(without.calls[0]?.headers['authorization']).toBeUndefined()
  })

  test('no such repo, or a private one with no token, names both causes', async () => {
    const { impl } = server(() => response({ message: 'Not Found' }, { status: 404 }))
    const error = await caught(async () => readRelease({ repo: REPO }, impl, {}))
    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toBe('github has no published release for Owner/Mod')
    expect(error.detail).toContain('set GITHUB_TOKEN if Owner/Mod is private')
  })

  test('no such release names the tag asked for', async () => {
    const { impl } = server(() => response({ message: 'Not Found' }, { status: 404 }))
    const error = await caught(async () => readRelease({ repo: REPO, tag: 'v9' }, impl, {}))
    expect(error.message).toBe('github has no release tagged v9 for Owner/Mod')
  })

  test('the unauthenticated rate limit points at GITHUB_TOKEN and says when it resets', async () => {
    const { impl } = server(() =>
      response({ message: 'API rate limit exceeded' }, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
      }))
    const error = await caught(async () => readRelease({ repo: REPO }, impl, {}))
    expect(error.code).toBe(Exit.Environment)
    expect(error.message).toBe('github rate-limited the release lookup for Owner/Mod')
    expect(error.detail).toContain('set GITHUB_TOKEN')
    expect(error.detail).toContain('2023-11-14T22:13:20.000Z')
  })

  test('a 403 that is not a rate limit is reported as itself', async () => {
    const { impl } = server(() => response({ message: 'Forbidden' }, { status: 403 }))
    const error = await caught(async () => readRelease({ repo: REPO }, impl, {}))
    expect(error.message).toBe('github answered 403 for Owner/Mod')
  })
})

describe('pickAsset', () => {
  const release = { tag: 'v1', assets: ['Mod.zip', 'Mod-src.zip', 'notes.txt'].map((name) => ({ name, url: name })) }

  test('one match wins, and *.zip is the default glob', () => {
    const one = { tag: 'v1', assets: [{ name: 'Mod.zip', url: 'u' }, { name: 'notes.txt', url: 'n' }] }
    expect(pickAsset(one, REPO).name).toBe('Mod.zip')
    expect(pickAsset(release, REPO, 'Mod-src.zip').name).toBe('Mod-src.zip')
  })

  test('zero matches lists every asset the release does publish', async () => {
    const error = await caught(async () => pickAsset(release, REPO, '*.tar.gz'))
    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toBe('no asset of Owner/Mod v1 matches "*.tar.gz"')
    expect(error.detail).toContain('Mod.zip')
    expect(error.detail).toContain('notes.txt')
  })

  test('a release with no assets at all says so instead of listing nothing', async () => {
    const error = await caught(async () => pickAsset({ tag: 'v1', assets: [] }, REPO))
    expect(error.detail).toContain('publishes no assets')
  })

  test('several matches lists only the matches and points at the asset key', async () => {
    const error = await caught(async () => pickAsset(release, REPO))
    expect(error.message).toBe('2 assets of Owner/Mod v1 match "*.zip"')
    expect(error.detail).toContain('narrow "asset"')
    expect(error.detail).toContain('Mod-src.zip')
    expect(error.detail).not.toContain('notes.txt')
  })
})

describe('unzipInto', () => {
  test('a missing unzip names the tool, not the archive', async () => {
    unzipMode = 'missing'
    const error = await caught(async () => unzipInto('/tmp/a.zip', '/tmp/out'))
    expect(error.code).toBe(Exit.Environment)
    expect(error.message).toBe('unzip is not on PATH')
    expect(unzipPresent()).toBe(false)
  })

  test('a corrupt archive reports what unzip said', async () => {
    unzipMode = 'fail'
    const error = await caught(async () => unzipInto('/tmp/a.zip', '/tmp/out'))
    expect(error.message).toBe('could not read /tmp/a.zip')
    expect(error.detail).toContain('End-of-central-directory')
  })

  test('a traversal entry refuses the archive before unzip runs', async () => {
    unzipEntries = ['Mod/About/About.txt', '../../.bashrc']
    const error = await caught(async () => unzipInto('/tmp/a.zip', '/tmp/out'))
    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toContain('../../.bashrc')
    expect(unzipCalls.some((argv) => argv[0] === '-q')).toBe(false)
  })
})

describe('ensureRelease', () => {
  test('a tag pin downloads once, then reuses the extraction with no api call', async () => {
    const data = temp('gc-data-')
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const first = github('v1.0', ['Mod.zip'])
    const dir = (await ensureRelease(data, { repo: REPO, tag: 'v1.0' }, 'fetch', first.impl)).dir
    expect(dir).toBe(releaseDir(data, REPO, 'v1.0'))
    expect(existsSync(join(dir, 'Mod', 'About', 'About.txt'))).toBe(true)

    const again = github('v1.0', ['Mod.zip'])
    expect((await ensureRelease(data, { repo: REPO, tag: 'v1.0' }, 'fetch', again.impl)).dir).toBe(dir)
    expect(again.calls).toEqual([])
  })

  test('force re-downloads a tag pin that is already on disk', async () => {
    const data = temp('gc-data-')
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const pin = { repo: REPO, tag: 'v1.0' }
    const first = github('v1.0', ['Mod.zip'])
    await ensureRelease(data, pin, 'fetch', first.impl)
    const forced = github('v1.0', ['Mod.zip'])
    await ensureRelease(data, pin, 'force', forced.impl)
    expect(forced.downloads()).toBe(1)
  })

  test('an unpinned release follows latest, so a new tag lands in a new directory', async () => {
    const data = temp('gc-data-')
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const one = github('v1.0', ['Mod.zip'])
    expect((await ensureRelease(data, { repo: REPO }, 'fetch', one.impl)).dir).toBe(releaseDir(data, REPO, 'v1.0'))

    const same = github('v1.0', ['Mod.zip'])
    await ensureRelease(data, { repo: REPO }, 'fetch', same.impl)
    expect(same.downloads()).toBe(0)

    const two = github('v2.0', ['Mod.zip'])
    expect((await ensureRelease(data, { repo: REPO }, 'fetch', two.impl)).dir).toBe(releaseDir(data, REPO, 'v2.0'))
    expect(two.downloads()).toBe(1)
  })

  test('use mode never reaches the network, and points at mods sync when nothing is cached', async () => {
    const data = temp('gc-data-')
    const { impl, calls } = server(() => response(releaseBody('v1.0', ['Mod.zip'])))
    const pinned = await caught(async () => ensureRelease(data, { repo: REPO, tag: 'v1.0' }, 'use', impl))
    expect(pinned.code).toBe(Exit.Resolution)
    expect(pinned.message).toBe('no extraction of Owner/Mod v1.0 on disk')
    expect(pinned.detail).toContain('gamecrate mods sync')

    const unpinned = await caught(async () => ensureRelease(data, { repo: REPO }, 'use', impl))
    expect(unpinned.message).toBe('no extraction of Owner/Mod on disk')
    expect(calls).toEqual([])
  })

  test('use mode takes the one cached extraction of an unpinned release', async () => {
    const data = temp('gc-data-')
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const one = github('v1.0', ['Mod.zip'])
    const dir = (await ensureRelease(data, { repo: REPO }, 'fetch', one.impl)).dir
    expect(soleReleaseDir(data, REPO)).toBe(dir)

    const { impl, calls } = server(() => response(releaseBody('v9', [])))
    expect((await ensureRelease(data, { repo: REPO }, 'use', impl)).dir).toBe(dir)
    expect(calls).toEqual([])
  })

  test('two cached extractions of an unpinned release are ambiguous, so use mode refuses', async () => {
    const data = temp('gc-data-')
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    for (const tag of ['v1.0', 'v2.0']) {
      const each = github(tag, ['Mod.zip'])
      await ensureRelease(data, { repo: REPO }, 'fetch', each.impl)
    }
    expect(soleReleaseDir(data, REPO)).toBeUndefined()
    const error = await caught(async () => ensureRelease(data, { repo: REPO }, 'use', github('v3', []).impl))
    expect(error.message).toBe('no extraction of Owner/Mod on disk')
  })

  test('a glob that matches nothing fails before anything is written', async () => {
    const data = temp('gc-data-')
    const { impl } = github('v1.0', ['Mod.tar.gz'])
    const error = await caught(async () =>
      ensureRelease(data, { repo: REPO, tag: 'v1.0', asset: '*.zip' }, 'fetch', impl))
    expect(error.message).toBe('no asset of Owner/Mod v1.0 matches "*.zip"')
    expect(existsSync(releaseDir(data, REPO, 'v1.0'))).toBe(false)
  })
})

describe('prepareSources with a release pin', () => {
  test('maps the id at the extraction, and two ids on one release fetch once', async () => {
    const data = temp('gc-data-')
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const pin = { release: REPO, tag: 'v1.0' }
    const game = gameWith({ 'one.mod': pin, 'two.mod': pin }, { p: { mods: ['One.Mod', 'Two.Mod'] } })
    const { impl, downloads } = github('v1.0', ['Mod.zip'])
    const result = await prepareSources(game, 'p', cliArgs(), data, true, impl)
    try {
      expect(result.dirs.get('one.mod')).toBe(releaseDir(data, REPO, 'v1.0'))
      expect(result.dirs.get('two.mod')).toBe(result.dirs.get('one.mod'))
      expect(downloads()).toBe(1)
    } finally {
      await result.release()
    }
    expect(cachedSources(game, 'p', cliArgs(), data).get('one.mod')).toBe(releaseDir(data, REPO, 'v1.0'))
  })

  test('cachedSources stays off the network and skips an extraction that is not there', () => {
    const data = temp('gc-data-')
    const game = gameWith({ 'one.mod': { release: REPO, tag: 'v1.0' } }, { p: { mods: ['One.Mod'] } })
    expect(cachedSources(game, 'p', cliArgs(), data).has('one.mod')).toBe(false)
  })
})

describe('a release-sourced mod is never stale', () => {
  async function resolved(game: GameConfig, data: string): Promise<{ kind: string; stale: boolean }> {
    const index = await buildIndex('atlas', game, fixturePlugin('atlas'), sourcesRoot(data))
    const { plan, problems } = await resolvePlan({
      game: 'atlas',
      profile: 'p',
      root: { dataRoot: data, games: { atlas: game } },
      plugins: new Map([['atlas', fixturePlugin('atlas')]]),
      args: cliArgs(),
      index,
      sources: new Map(),
    })
    expect(problems).toEqual([])
    const mod = plan.mods.find((one) => one.packageId === 'Acme.Mod')
    expect(mod).toBeDefined()
    return { kind: mod!.kind, stale: mod!.stale === true }
  }

  test('source newer than the assembly reports stale from a clone, and never from a release', async () => {
    const data = temp('gc-data-')
    const clone = join(sourcesRoot(data), 'mod-aaaaaaaaaaaa', 'branch-main-bbbbbb')
    mkdirSync(clone, { recursive: true })
    staleModAt(clone, 'Acme.Mod')
    const cloned = await resolved(gameWith({}, { p: { mods: ['Acme.Mod'] } }), data)
    expect(cloned).toEqual({ kind: 'local', stale: true })

    rmSync(clone, { recursive: true, force: true })
    const extraction = releaseDir(data, REPO, 'v1.0')
    mkdirSync(extraction, { recursive: true })
    staleModAt(extraction, 'Acme.Mod')
    const released = await resolved(gameWith({ 'acme.mod': { release: REPO, tag: 'v1.0' } }, { p: { mods: ['Acme.Mod'] } }), data)
    expect(released).toEqual({ kind: 'release', stale: false })
  })
})

describe('mods add --release', () => {
  function context(library: GameConfig['library'], impl: typeof fetch): {
    ctx: Parameters<typeof modsAdd>[1]
    globalPath: string
  } {
    const home = temp('gc-home-')
    const globalPath = join(home, 'profiles.yml')
    writeFileSync(globalPath, '')
    return {
      globalPath,
      ctx: {
        config: {
          dataRoot: temp('gc-data-'),
          games: { atlas: { ...fixtureGame(), library } },
        },
        plugins: pluginMap('atlas'),
        defaults: {},
        cwd: home,
        globalPath,
        fetch: impl,
      },
    }
  }

  function argv(...rest: string[]): ParsedArgs {
    return parseArgs(rest, { env: {}, games: ['atlas'] })
  }

  test('writes the repo, the tag and the asset glob, and keeps the subdir it found', async () => {
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const { impl } = github('v1.0', ['Mod.zip'])
    const { ctx, globalPath } = context({}, impl)
    const code = await modsAdd(
      argv('mods', 'add', '--game', 'atlas', '--release', REPO, '--tag', 'v1.0', '--asset', '*.zip', '--global'),
      ctx,
    )
    expect(code).toBe(Exit.Ok)
    const written = readFileSync(globalPath, 'utf8')
    expect(written).toContain(`release: ${REPO}`)
    expect(written).toContain('tag: v1.0')
    expect(written).toContain('asset: "*.zip"')
    expect(written).toContain('subdir: Mod')
  })

  test('an unpinned add records no tag, so the entry keeps following latest', async () => {
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const { impl } = github('v2.0', ['Mod.zip'])
    const { ctx, globalPath } = context({}, impl)
    await modsAdd(argv('mods', 'add', '--game', 'atlas', '--release', REPO, '--global'), ctx)
    const written = readFileSync(globalPath, 'utf8')
    expect(written).toContain(`release: ${REPO}`)
    expect(written).not.toContain('tag:')
  })

  test('a glob matching two assets refuses before writing anything', async () => {
    const { impl } = github('v1.0', ['Mod.zip', 'Mod-src.zip'])
    const { ctx, globalPath } = context({}, impl)
    const error = await caught(async () =>
      modsAdd(argv('mods', 'add', '--game', 'atlas', '--release', REPO, '--global'), ctx))
    expect(error.message).toBe('2 assets of Owner/Mod v1.0 match "*.zip"')
    expect(readFileSync(globalPath, 'utf8')).toBe('')
  })

  test('mods sync refetches a release pin, and names one that is not pinned at all', async () => {
    unzipPayload = (dir) => modAt(dir, 'Mod', 'Acme.Mod')
    const { impl, downloads } = github('v1.0', ['Mod.zip'])
    const { ctx } = context({ 'acme.mod': { release: REPO, tag: 'v1.0' } }, impl)
    expect(await modsSync(argv('mods', 'sync', '--game', 'atlas'), ctx)).toBe(Exit.Ok)
    expect(downloads()).toBe(1)
    expect(await modsSync(argv('mods', 'sync', '--game', 'atlas'), ctx)).toBe(Exit.Ok)
    expect(downloads()).toBe(2)

    const error = await caught(async () => modsSync(argv('mods', 'sync', '--game', 'atlas', 'nope.mod'), ctx))
    expect(error.message).toContain('not git-, release- or workshop-pinned')
  })
})
