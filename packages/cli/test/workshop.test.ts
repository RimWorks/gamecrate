import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fixtureGame, fixturePlugin } from './fixture-plugin'
import { downloadRoot } from '../src/mods/steamcmd'
import { prepareWorkshop } from '../src/mods/workshop'
import type { GamePlugin } from '../src/plugin'
import type { GameConfig, ModEntry, ModManifest, ParsedArgs, ProfileConfig, RootConfig } from '../src/types'

const FAKE = fileURLToPath(new URL('./fixtures/fake-steamcmd-deps.sh', import.meta.url))

let tmp = ''
/** One entry per POST to steam, holding the ids that call asked about. Rounds are its length. */
let asked: string[][] = []

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-workshop-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['FAKE_FAIL_IDS']
  delete process.env['FAKE_MANIFEST_DIR']
  asked = []
})

/**
 * Steam answering about nothing, which leaves `checkDrift` with the items that are not on disk.
 * Every test runs through this, so none of them can reach the network.
 */
function stubSteam(): void {
  vi.stubGlobal('fetch', async (_url: unknown, init: { body: URLSearchParams }) => {
    asked.push([...init.body].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v))
    return new Response(JSON.stringify({ response: { publishedfiledetails: [] } }))
  })
}

/** `packageid <id>` and `dep <packageId> [url]`, one per line. `throw` is a broken manifest. */
function parseDepManifest(text: string): ModManifest | null {
  const manifest: ModManifest = {
    packageId: '',
    modDependencies: [],
    loadAfter: [],
    loadBefore: [],
    forceLoadAfter: [],
    forceLoadBefore: [],
    incompatibleWith: [],
  }
  for (const raw of text.split('\n')) {
    const [key, value, url] = raw.trim().split(/\s+/)
    if (key === 'throw') throw new Error('broken manifest')
    if (key === 'packageid' && value !== undefined) manifest.packageId = value
    if (key === 'dep' && value !== undefined) {
      manifest.modDependencies.push(url === undefined ? { packageId: value } : { packageId: value, steamWorkshopUrl: url })
    }
  }
  return manifest.packageId === '' ? null : manifest
}

function depPlugin(): GamePlugin {
  return { ...fixturePlugin(), parseManifest: parseDepManifest }
}

function itemUrl(id: string): string {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`
}

/** The form 251 of 323 real About files use, which `new URL` reads with hostname "url". */
function clientUrl(id: string): string {
  return `steam://url/CommunityFilePage/${id}`
}

/** A manifest naming `deps` by workshop url, the shape a real About file carries. */
function about(id: string, deps: string[] = []): string {
  return [`packageid mod.${id}`, ...deps.map((dep) => `dep mod.${dep} ${itemUrl(dep)}`)].join('\n')
}

interface World {
  game: GameConfig
  config: RootConfig
  root: string
  manifests: string
  /** lowercased packageId -> clone dir, the map prepareSources hands a launch. */
  sources?: Map<string, string>
}

/**
 * A data root of its own, wired to the fake steamcmd, with `bodies` laid out as the manifests
 * each id gets once it downloads.
 */
async function setup(mods: ModEntry[], bodies: Record<string, string> = {}, profile: Partial<ProfileConfig> = {}): Promise<World> {
  const root = await mkdtemp(join(tmp, 'w-'))
  const manifests = join(root, 'manifests')
  await mkdir(manifests, { recursive: true })
  for (const [id, body] of Object.entries(bodies)) await writeFile(join(manifests, `${id}.txt`), body)
  process.env['FAKE_MANIFEST_DIR'] = manifests

  const game = fixtureGame()
  game.profiles = { p: { mods, ...profile } }
  return {
    game,
    config: { dataRoot: root, games: { atlas: game }, steamcmd: { path: FAKE } },
    root,
    manifests,
  }
}

/** Where the fake writes, the pinned layout, and what a pre-seeded item goes into. */
function hostRoot(w: World): string {
  return downloadRoot(w.config.dataRoot, w.game)
}

async function seed(w: World, id: string, text: string): Promise<void> {
  const dir = join(hostRoot(w), id, 'About')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'About.txt'), text)
}

/** The steam client's own tree, laid out the way the client writes it, with an .acf beside it. */
async function seedClient(w: World, id: string, text: string): Promise<void> {
  const workshop = join(w.root, 'client', 'steamapps', 'workshop')
  w.game.workshopRoot = join(workshop, 'content', String(w.game.steamAppId))
  await mkdir(join(w.game.workshopRoot, id, 'About'), { recursive: true })
  await writeFile(join(w.game.workshopRoot, id, 'About', 'About.txt'), text)
  await writeFile(
    join(workshop, `appworkshop_${w.game.steamAppId}.acf`),
    `"AppWorkshop"\n{\n\t"WorkshopItemsInstalled"\n\t{\n\t\t"${id}"\n\t\t{\n\t\t\t"timeupdated"\t\t"1752434318"\n\t\t\t"manifest"\t\t"1025052661578487222"\n\t\t}\n\t}\n}\n`,
  )
}

function cliArgs(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    subcommand: 'run',
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
    supervised: false,
    follow: false,
    rest: [],
    ...over,
  }
}

async function prepare(w: World, args: Partial<ParsedArgs> = {}, allowFetch = true): ReturnType<typeof prepareWorkshop> {
  return await prepareWorkshop(w.game, 'p', cliArgs(args), w.config, allowFetch, depPlugin(), w.sources ?? new Map())
}

describe('prepareWorkshop', () => {
  test('a flat profile downloads every form of workshop reference in one round', async () => {
    stubSteam()
    const w = await setup(
      ['workshop:111', { id: 'mod.b', workshop: 222 }, 'mod.c', 'path:/elsewhere', { match: 'mod.*' }],
      { '111': about('111'), '222': about('222'), '333': about('333') },
    )
    w.game.library = { 'mod.c': { workshop: 333 } }

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222', '333'])
    expect(out.unfetched).toEqual([])
    expect(out.warnings).toEqual([])
    expect(out.problems).toEqual([])
    expect(asked).toHaveLength(1)
    expect(existsSync(join(hostRoot(w), '222', 'About', 'About.txt'))).toBe(true)
  })

  test('a chain of three resolves in three rounds', async () => {
    stubSteam()
    const w = await setup(['workshop:111'], {
      '111': about('111', ['222']),
      '222': about('222', ['333']),
      '333': about('333'),
    })

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222', '333'])
    expect(out.problems).toEqual([])
    expect(out.unfetched).toEqual([])
    expect(asked).toEqual([['111'], ['222'], ['333']])
  })

  test('a path-pinned mod seeds the walk with its own workshop dependencies', async () => {
    stubSteam()
    const w = await setup([], { '222': about('222') })
    const local = join(w.root, 'local-mod', 'About')
    await mkdir(local, { recursive: true })
    await writeFile(join(local, 'About.txt'), about('local', ['222']))
    w.game.profiles['p']!.mods = [{ id: 'mod.local', path: join(w.root, 'local-mod') }]

    const out = await prepare(w)

    expect([...out.ids]).toEqual(['222'])
    expect(out.unfetched).toEqual([])
    expect(asked).toEqual([['222']])
  })

  test('a git-pinned mod seeds the walk from its clone directory', async () => {
    stubSteam()
    const w = await setup([], { '222': about('222') })
    const clone = join(w.root, 'clone', 'About')
    await mkdir(clone, { recursive: true })
    await writeFile(join(clone, 'About.txt'), about('local', ['222']))
    w.game.profiles['p']!.mods = ['mod.local']
    w.game.library = { 'mod.local': { git: 'https://example.com/a/b' } }
    w.sources = new Map([['mod.local', join(w.root, 'clone')]])

    const out = await prepare(w)

    expect([...out.ids]).toEqual(['222'])
    expect(out.unfetched).toEqual([])
  })

  test('a git pin with a subdir reads the manifest under it', async () => {
    stubSteam()
    const w = await setup([], { '222': about('222') })
    const nested = join(w.root, 'clone', 'Mods', 'X', 'About')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'About.txt'), about('local', ['222']))
    // a manifest at the clone root would be found by mistake if subdir were ignored
    await mkdir(join(w.root, 'clone', 'About'), { recursive: true })
    await writeFile(join(w.root, 'clone', 'About', 'About.txt'), about('wrong'))
    w.game.profiles['p']!.mods = ['mod.local']
    w.game.library = { 'mod.local': { git: 'https://example.com/a/b', subdir: 'Mods/X' } }
    w.sources = new Map([['mod.local', join(w.root, 'clone')]])

    const out = await prepare(w)

    expect([...out.ids]).toEqual(['222'])
  })

  test('a dependency named by the steam client url form is walked', async () => {
    stubSteam()
    const w = await setup(['workshop:111'], {
      '111': [`packageid mod.111`, `dep mod.222 ${clientUrl('222')}`].join('\n'),
      '222': about('222'),
    })

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222'])
    expect(out.unfetched).toEqual([])
  })

  test('a cycle terminates instead of spinning', { timeout: 10_000 }, async () => {
    stubSteam()
    const w = await setup(['workshop:111'], {
      '111': about('111', ['222']),
      '222': about('222', ['111']),
    })

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222'])
    expect(out.problems).toEqual([])
    expect(asked).toEqual([['111'], ['222']])
  })

  test('a chain longer than the cap stops and names what is left', { timeout: 10_000 }, async () => {
    stubSteam()
    const links = ['111', '222', '333', '444', '555', '666', '777']
    const bodies = Object.fromEntries(links.map((id, i) => [id, about(id, links[i + 1] === undefined ? [] : [links[i + 1] as string])]))
    const w = await setup(['workshop:111'], bodies)

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222', '333', '444', '555'])
    expect(out.problems).toHaveLength(1)
    expect(out.problems[0]?.message).toContain('666')
    expect(out.problems[0]?.message).toContain('5 rounds')
    expect(asked).toHaveLength(5)
  })

  test('a dependency with no usable workshop url is skipped', async () => {
    stubSteam()
    const w = await setup(['workshop:111'], {
      '111': ['packageid mod.111', 'dep mod.nourl', 'dep mod.junk not-a-url', `dep mod.elsewhere https://example.com/?id=999`].join('\n'),
    })

    const out = await prepare(w)

    expect([...out.ids]).toEqual(['111'])
    expect(out.problems).toEqual([])
    expect(out.warnings).toEqual([])
  })

  test('a manifest that throws is a problem, and the walk carries on', async () => {
    stubSteam()
    const w = await setup(['workshop:111', 'workshop:222'], {
      '111': 'throw',
      '222': about('222', ['333']),
      '333': about('333'),
    })

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222', '333'])
    expect(out.problems).toHaveLength(1)
    expect(out.problems[0]?.message).toBe('broken manifest')
  })

  test('allowFetch false asks steam nothing, runs nothing, and reports what is missing', async () => {
    stubSteam()
    const w = await setup(['workshop:111'], {})
    // resolveSteamcmd throws on a path that is not executable, so a spawn here could not be silent
    w.config.steamcmd = { path: join(tmp, 'no-such-steamcmd') }
    await seed(w, '111', about('111', ['222']))

    const out = await prepare(w, {}, false)

    expect([...out.ids].sort()).toEqual(['111', '222'])
    expect(out.unfetched).toEqual(['222'])
    expect(out.warnings).toEqual([])
    expect(asked).toEqual([])
  })

  test('a failed download is a warning and the rest still resolve', async () => {
    stubSteam()
    process.env['FAKE_FAIL_IDS'] = '222'
    const w = await setup(['workshop:111', 'workshop:222'], {
      '111': about('111'),
      '222': about('222'),
    })

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222'])
    expect(out.unfetched).toEqual(['222'])
    expect(out.warnings).toEqual(['could not download workshop item 222: Failure'])
    expect(out.problems).toEqual([])
  })

  test('no usable steamcmd is a warning, not a thrown launch', async () => {
    stubSteam()
    const w = await setup(['workshop:111'], {})
    w.config.steamcmd = { path: join(tmp, 'no-such-steamcmd') }

    const out = await prepare(w)

    expect([...out.ids]).toEqual(['111'])
    expect(out.unfetched).toEqual(['111'])
    expect(out.warnings).toEqual([`could not download workshop items: steamcmd.path is not an executable file: ${join(tmp, 'no-such-steamcmd')}`])
    expect(out.problems).toEqual([])
  })

  test('an item the steam client already holds downloads nothing and still leads to its dependency', async () => {
    stubSteam()
    const w = await setup(['workshop:111'], { '222': about('222') })
    await seedClient(w, '111', about('111', ['222']))

    const out = await prepare(w)

    expect([...out.ids].sort()).toEqual(['111', '222'])
    expect(out.unfetched).toEqual([])
    expect(out.problems).toEqual([])
    expect(existsSync(join(hostRoot(w), '111'))).toBe(false)
    expect(existsSync(join(hostRoot(w), '222', 'About', 'About.txt'))).toBe(true)
  })

  test('exclude and --without drop a workshop entry before it downloads', async () => {
    stubSteam()
    const w = await setup(['workshop:111', { id: 'mod.b', workshop: 222 }], { '111': about('111') }, { exclude: ['mod.b'] })

    const out = await prepare(w, { without: ['workshop:111'] })

    expect([...out.ids]).toEqual([])
    expect(asked).toEqual([])
  })
})
