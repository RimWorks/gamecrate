import { describe, expect, test } from 'vitest'
import { chmod, mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildIndex, globMatch, resolveModRef, workshopStamp } from '../src/mods/modindex'
import { downloadRoot } from '../src/mods/steamcmd'
import { fixturePlugin, FIXTURE_DEFAULTS, parseFixtureManifest } from './fixture-plugin'
import type { GameConfig, ScanRoot } from '../src/types'

const plugin = fixturePlugin()
const atlas: GameConfig = {
  ...(FIXTURE_DEFAULTS as GameConfig),
  gameFiles: { source: 'image', container: '/game' },
}

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dg-modindex-'))
}

async function mod(root: string, rel: string, packageId: string, extra = ''): Promise<string> {
  const dir = join(root, rel)
  await mkdir(join(dir, 'About'), { recursive: true })
  await writeFile(join(dir, 'About', 'About.txt'), `packageId ${packageId}\nname ${packageId}\n${extra}`)
  return dir
}

function scanRoot(path: string, maxDepth: number, exclude?: string[]): ScanRoot {
  return exclude ? { path, maxDepth, exclude } : { path, maxDepth }
}

function withRoots(base: GameConfig, roots: ScanRoot[], workshopRoot: string | null): GameConfig {
  return { ...base, scanRoots: roots, workshopRoot }
}

describe('globMatch', () => {
  test('** spans directories', () => {
    expect(globMatch('**/.retired/**', 'a/b/.retired/Mod')).toBe(true)
    expect(globMatch('**/.retired/**', 'a/b/retired/Mod')).toBe(false)
  })

  test('a leading segment anchors at the root', () => {
    expect(globMatch('old/**', 'old/KittedCore')).toBe(true)
    expect(globMatch('old/**', 'AtlasKitted/old/KittedCore')).toBe(false)
  })

  test('* does not cross a separator', () => {
    expect(globMatch('*/About', 'Mod/About')).toBe(true)
    expect(globMatch('*/About', 'a/Mod/About')).toBe(false)
  })

  test('? matches one character, never a separator', () => {
    expect(globMatch('a?c', 'abc')).toBe(true)
    expect(globMatch('a?c', 'a/c')).toBe(false)
  })

  test('a dot directory is matched like any other', () => {
    expect(globMatch('**/node_modules/**', '.claude/worktrees/x/node_modules/y')).toBe(true)
  })

  test('brackets and braces are literal, because mod folders are named that way', () => {
    expect(globMatch('[KV] Mod Manager', '[KV] Mod Manager')).toBe(true)
    expect(globMatch('**/[KV]*', 'mods/[KV] Mod Manager')).toBe(true)
    expect(globMatch('[1.5] X', '[1.5] X')).toBe(true)
    expect(globMatch('[ab]/About', 'a/About')).toBe(false)
    expect(globMatch('{A}', '{A}')).toBe(true)
    expect(globMatch('{bin,obj}/**', 'obj/Debug')).toBe(false)
    expect(globMatch(String.raw`a\b`, String.raw`a\b`)).toBe(true)
    expect(globMatch('Mod (Fork)', 'Mod (Fork)')).toBe(true)
    expect(globMatch('!x,y@z+w|v', '!x,y@z+w|v')).toBe(true)
  })
})

describe('plugin manifests', () => {
  test('a manifest with no packageId is not a mod, rather than a broken one', () => {
    expect(parseFixtureManifest('name hi\n')).toBeNull()
  })

  test('a malformed manifest throws instead of returning null', () => {
    expect(() => parseFixtureManifest('nope\n')).toThrow()
  })

  test('the manifest reports its own packageId, not a dependency', () => {
    const m = parseFixtureManifest('packageId real.mod\nmodDependencies [patchlib.patch]\n')
    expect(m?.packageId).toBe('real.mod')
    expect(m?.modDependencies.map((d) => d.packageId)).toEqual(['patchlib.patch'])
  })

  test('order declarations survive the round trip', () => {
    const m = parseFixtureManifest('packageId Lib.Bridge.Beacon\nforceLoadBefore [Atlasco.Beacon]\n')
    expect(m?.forceLoadBefore).toEqual(['Atlasco.Beacon'])
  })
})

describe('exclusions', () => {
  // A repo full of test fixtures used to fail the whole resolution on exit 4.
  test('an About stub with no packageId is skipped, not reported', async () => {
    const root = await fixture()
    try {
      await mod(root, 'Live', 'test.live')
      await mkdir(join(root, 'tests/fixtures/mod/About'), { recursive: true })
      await writeFile(join(root, 'tests/fixtures/mod/About/About.txt'), 'name stub\n')

      const index = await buildIndex('atlas', withRoots(atlas, [scanRoot(root, 6)], null), plugin)

      expect(index.byPackageId.has('test.live')).toBe(true)
      expect(index.problems).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('.retired and old are skipped', async () => {
    const root = await fixture()
    try {
      await mod(root, 'Live', 'test.live')
      await mod(root, '.retired/Dead', 'test.dead')
      await mod(root, 'old/Stale', 'test.stale')

      const cfg = withRoots(
        atlas,
        [scanRoot(root, 4, ['old/**', '**/.retired/**'])],
        null,
      )
      const index = await buildIndex('atlas', cfg, plugin)

      expect(index.byPackageId.has('test.live')).toBe(true)
      expect(index.byPackageId.has('test.dead')).toBe(false)
      expect(index.byPackageId.has('test.stale')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('maxDepth is honored', async () => {
    const root = await fixture()
    try {
      await mod(root, 'Shallow', 'test.shallow')
      await mod(root, 'a/b/c/Deep', 'test.deep')

      const index = await buildIndex('atlas', withRoots(atlas, [scanRoot(root, 2)], null), plugin)
      expect(index.byPackageId.has('test.shallow')).toBe(true)
      expect(index.byPackageId.has('test.deep')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('linked worktree shadowing', () => {
  test('a primary checkout beats a linked worktree declaring the same packageId', async () => {
    const root = await fixture()
    try {
      // Sorts first alphabetically, exactly like Beacon-runtime-package-sync.
      const wt = await mod(root, 'A-worktree/Mod', 'dup.mod')
      await mkdir(join(root, 'A-worktree'), { recursive: true })
      await writeFile(join(root, 'A-worktree', '.git'), 'gitdir: /somewhere/.git/worktrees/sync\n')

      const primary = await mod(root, 'B-primary/Mod', 'dup.mod')
      await mkdir(join(root, 'B-primary', '.git'), { recursive: true })

      const index = await buildIndex('atlas', withRoots(atlas, [scanRoot(root, 4)], null), plugin)
      const picked = resolveModRef(index, 'dup.mod', atlas)

      expect(picked).not.toBeNull()
      expect(picked!.dir).toBe(primary)
      expect(picked!.dir).not.toBe(wt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})

describe('workshop scanning', () => {
  test('numeric directories only, depth-exact', async () => {
    const root = await fixture()
    try {
      await mod(root, '123456', 'ws.numeric')
      await mod(root, 'not-a-number', 'ws.named')
      // A nested per-version About must not register as its own item.
      await mod(root, '123456/1.6', 'ws.phantom')

      const cfg = withRoots(atlas, [], root)
      const index = await buildIndex('atlas', cfg, plugin)

      expect(index.byPackageId.has('ws.numeric')).toBe(true)
      expect(index.byPackageId.has('ws.named')).toBe(false)
      expect(index.byPackageId.has('ws.phantom')).toBe(false)
      expect(index.byWorkshopId.get(123456)?.packageId).toBe('ws.numeric')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})

describe('resolveModRef addressing', () => {
  test('path:, workshop:<id> and bare packageId all resolve', async () => {
    const root = await fixture()
    try {
      const dir = await mod(root, 'Mod', 'test.addr')
      const ws = await fixture()
      await mod(ws, '987654', 'test.ws')

      const cfg = withRoots(atlas, [scanRoot(root, 3)], ws)
      const index = await buildIndex('atlas', cfg, plugin)

      expect(resolveModRef(index, 'test.addr', cfg)?.dir).toBe(dir)
      expect(resolveModRef(index, 'TEST.ADDR', cfg)?.packageId).toBe('test.addr')
      expect(resolveModRef(index, `path:${dir}`, cfg)?.packageId).toBe('test.addr')
      expect(resolveModRef(index, 'workshop:987654', cfg)?.packageId).toBe('test.ws')
      expect(resolveModRef(index, 'workshop:not-a-number', cfg)).toBeNull()
      expect(resolveModRef(index, 'does.not.exist', cfg)).toBeNull()

      await rm(ws, { recursive: true, force: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('manifest casing survives while matching is case-insensitive', async () => {
    const root = await fixture()
    try {
      await mod(root, 'Mod', 'Example.StickToYourSave')
      const cfg = withRoots(atlas, [scanRoot(root, 3)], null)
      const index = await buildIndex('atlas', cfg, plugin)

      expect(resolveModRef(index, 'example.sticktoyoursave', cfg)?.packageId).toBe(
        'Example.StickToYourSave',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('source cache scanning', () => {
  test('a bare id resolves a mod that only exists in the cache', async () => {
    const cache = await fixture()
    try {
      await mod(cache, 'beacon-abc123/branch-main-def456/Beacon', 'cached.beacon')

      const cfg = withRoots(atlas, [], null)
      const index = await buildIndex('atlas', cfg, plugin, cache)

      expect(index.byPackageId.has('cached.beacon')).toBe(true)
      expect(resolveModRef(index, 'cached.beacon', cfg)?.packageId).toBe('cached.beacon')
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  // Passes before the cache is ever scanned too. It guards against a future inversion of the
  // scan order, not against today's behaviour.
  test('a local checkout beats a cached clone for a bare id', async () => {
    const root = await fixture()
    const cache = await fixture()
    try {
      const local = await mod(root, 'Beacon', 'test.beacon')
      await mod(cache, 'beacon-abc123/branch-main-def456/Beacon', 'test.beacon')

      const cfg = withRoots(atlas, [scanRoot(root, 3)], null)
      const index = await buildIndex('atlas', cfg, plugin, cache)

      expect(resolveModRef(index, 'test.beacon', cfg)?.dir).toBe(local)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(cache, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------ the download tree

/** Where downloads land. `run` pins it, so it is one layout whatever steamcmd is used. */
function downloadTree(dataRoot: string): string {
  return downloadRoot(dataRoot, atlas)
}

/** Where steamcmd puts the acf for a tree: one level above `content/<appid>`. */
function acfFile(tree: string): string {
  return join(dirname(dirname(tree)), 'appworkshop_294100.acf')
}

/** The shape steam writes, with `timetouched` in the details block steamcmd keeps rewriting. */
function acfText(items: Record<string, string>, timetouched: string): string {
  const installed = Object.entries(items)
    .map(([id, manifest]) => `\t\t"${id}"\n\t\t{\n\t\t\t"timeupdated"\t\t"1752434318"\n\t\t\t"manifest"\t\t"${manifest}"\n\t\t}`)
    .join('\n')
  const details = Object.keys(items)
    .map((id) => `\t\t"${id}"\n\t\t{\n\t\t\t"timetouched"\t\t"${timetouched}"\n\t\t}`)
    .join('\n')
  return `"AppWorkshop"\n{\n\t"appid"\t\t"294100"\n\t"WorkshopItemsInstalled"\n\t{\n${installed}\n\t}\n\t"WorkshopItemDetails"\n\t{\n${details}\n\t}\n}\n`
}

/** Keeps the workshop cache inside the fixture, so no test reads the user's real one. */
async function privateCache(dataRoot: string): Promise<() => void> {
  const before = process.env['XDG_CACHE_HOME']
  process.env['XDG_CACHE_HOME'] = join(dataRoot, 'xdg')
  await mkdir(join(dataRoot, 'xdg'), { recursive: true })
  return () => {
    if (before === undefined) delete process.env['XDG_CACHE_HOME']
    else process.env['XDG_CACHE_HOME'] = before
  }
}

describe('two workshop roots', () => {
  test('the download root wins an id the steam root also holds', async () => {
    const data = await fixture()
    const ws = await fixture()
    const restore = await privateCache(data)
    try {
      const downloaded = await mod(downloadTree(data), '123456', 'ws.both')
      await mod(ws, '123456', 'ws.both')

      const cfg = withRoots(atlas, [], ws)
      const index = await buildIndex('atlas', cfg, plugin, undefined, data)

      expect(index.byWorkshopId.get(123456)?.dir).toBe(downloaded)
      expect(resolveModRef(index, 'ws.both', cfg)?.dir).toBe(downloaded)
      expect(index.byPackageId.get('ws.both')).toHaveLength(2)
      expect(index.problems).toEqual([])
    } finally {
      restore()
      await rm(data, { recursive: true, force: true })
      await rm(ws, { recursive: true, force: true })
    }
  })

  test('an item in only one root resolves either way', async () => {
    const data = await fixture()
    const ws = await fixture()
    const restore = await privateCache(data)
    try {
      const downloaded = await mod(downloadTree(data), '111', 'ws.downloaded')
      const subscribed = await mod(ws, '222', 'ws.subscribed')

      const cfg = withRoots(atlas, [], ws)
      const index = await buildIndex('atlas', cfg, plugin, undefined, data)

      expect(resolveModRef(index, 'ws.downloaded', cfg)?.dir).toBe(downloaded)
      expect(resolveModRef(index, 'ws.subscribed', cfg)?.dir).toBe(subscribed)
      expect(index.byWorkshopId.get(111)?.dir).toBe(downloaded)
      expect(index.byWorkshopId.get(222)?.dir).toBe(subscribed)
    } finally {
      restore()
      await rm(data, { recursive: true, force: true })
      await rm(ws, { recursive: true, force: true })
    }
  })

  test('a null workshopRoot still scans the download root', async () => {
    const data = await fixture()
    const restore = await privateCache(data)
    try {
      const downloaded = await mod(downloadTree(data), '333', 'ws.only')

      const cfg = withRoots(atlas, [], null)
      const index = await buildIndex('atlas', cfg, plugin, undefined, data)

      expect(resolveModRef(index, 'ws.only', cfg)?.dir).toBe(downloaded)
      expect(index.byWorkshopId.get(333)?.dir).toBe(downloaded)
    } finally {
      restore()
      await rm(data, { recursive: true, force: true })
    }
  })
})

describe('the workshop stamp', () => {
  test('a timetouched rewrite does not move it', async () => {
    const data = await fixture()
    try {
      const acf = acfFile(downloadTree(data))
      await mkdir(dirname(acf), { recursive: true })

      await writeFile(acf, acfText({ '818773962': '1025052661578487222' }, '1789944542'))
      const before = workshopStamp(withRoots(atlas, [], null), data)

      // the measured no-op run: timetouched moves, the installed manifest does not.
      await writeFile(acf, acfText({ '818773962': '1025052661578487222' }, '1789948957'))
      const after = workshopStamp(withRoots(atlas, [], null), data)

      expect(after).toBe(before)
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('the mtime moving on its own does not move it', async () => {
    const data = await fixture()
    try {
      const acf = acfFile(downloadTree(data))
      await mkdir(dirname(acf), { recursive: true })
      const text = acfText({ '818773962': '1025052661578487222' }, '1789944542')

      await writeFile(acf, text)
      const before = workshopStamp(withRoots(atlas, [], null), data)
      await utimes(acf, new Date(), new Date(Date.now() + 60_000))
      expect(workshopStamp(withRoots(atlas, [], null), data)).toBe(before)
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('a changed manifest id moves it', async () => {
    const data = await fixture()
    try {
      const acf = acfFile(downloadTree(data))
      await mkdir(dirname(acf), { recursive: true })

      await writeFile(acf, acfText({ '818773962': '1025052661578487222' }, '1789944542'))
      const before = workshopStamp(withRoots(atlas, [], null), data)

      await writeFile(acf, acfText({ '818773962': '7017455373945780161' }, '1789944542'))
      expect(workshopStamp(withRoots(atlas, [], null), data)).not.toBe(before)
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('a new item moves it, and item order does not', async () => {
    const data = await fixture()
    try {
      const acf = acfFile(downloadTree(data))
      await mkdir(dirname(acf), { recursive: true })

      await writeFile(acf, acfText({ '111': 'aaa', '222': 'bbb' }, '1789944542'))
      const before = workshopStamp(withRoots(atlas, [], null), data)

      await writeFile(acf, acfText({ '222': 'bbb', '111': 'aaa' }, '1789944542'))
      expect(workshopStamp(withRoots(atlas, [], null), data)).toBe(before)

      await writeFile(acf, acfText({ '111': 'aaa', '222': 'bbb', '333': 'ccc' }, '1789944542'))
      expect(workshopStamp(withRoots(atlas, [], null), data)).not.toBe(before)
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('a missing acf is a stable stamp, not a throw', async () => {
    const data = await fixture()
    try {
      const cfg = withRoots(atlas, [], null)
      const first = workshopStamp(cfg, data)
      expect(first).not.toBeNull()
      expect(workshopStamp(cfg, data)).toBe(first)

      // and an acf that parses to nothing reads the same as no acf at all
      const acf = acfFile(downloadTree(data))
      await mkdir(dirname(acf), { recursive: true })
      await writeFile(acf, '')
      expect(workshopStamp(cfg, data)).toBe(first)
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('a half-written acf refuses the cache instead of reading as empty', async () => {
    const data = await fixture()
    try {
      const cfg = withRoots(atlas, [], null)
      const empty = workshopStamp(cfg, data)

      const acf = acfFile(downloadTree(data))
      await mkdir(dirname(acf), { recursive: true })
      const full = acfText({ '818773962': '1025052661578487222' }, '1789944542')
      await writeFile(acf, full.slice(0, Math.floor(full.length / 2)))

      expect(workshopStamp(cfg, data)).toBeNull()
      expect(workshopStamp(cfg, data)).not.toBe(empty)
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('an unreadable download acf refuses the cache', async () => {
    const data = await fixture()
    try {
      const acf = acfFile(downloadTree(data))
      // a directory where the acf should be: readFileSync gives EISDIR, not ENOENT
      await mkdir(acf, { recursive: true })
      expect(workshopStamp(withRoots(atlas, [], null), data)).toBeNull()
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('an acf with an empty install block is the empty set, not a refusal', async () => {
    const data = await fixture()
    try {
      const cfg = withRoots(atlas, [], null)
      const empty = workshopStamp(cfg, data)
      expect(empty).not.toBeNull()

      // what a fresh download root looks like: valid keyvalues, nothing installed yet. refusing
      // the cache here would cost a full workshop rescan on every launch.
      const acf = acfFile(downloadTree(data))
      await mkdir(dirname(acf), { recursive: true })
      await writeFile(acf, acfText({}, '1789944542'))

      expect(workshopStamp(cfg, data)).toBe(empty)
      expect(workshopStamp(cfg, data)).toBe(empty)
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  test('the steam root keeps its mtime stamp, and an unreadable one refuses the cache', async () => {
    const data = await fixture()
    const ws = await fixture()
    try {
      // <ws>/../appworkshop_294100.acf is the steam side; it does not exist yet.
      expect(workshopStamp(withRoots(atlas, [], join(ws, 'content', '294100')), data)).toBeNull()

      const steamAcf = join(ws, 'appworkshop_294100.acf')
      await writeFile(steamAcf, acfText({ '818773962': '1025052661578487222' }, '1789944542'))
      const cfg = withRoots(atlas, [], join(ws, 'content', '294100'))
      const before = workshopStamp(cfg, data)
      expect(before).not.toBeNull()

      await utimes(steamAcf, new Date(), new Date(Date.now() + 60_000))
      expect(workshopStamp(cfg, data)).not.toBe(before)
    } finally {
      await rm(data, { recursive: true, force: true })
      await rm(ws, { recursive: true, force: true })
    }
  })
})

/**
 * An image-sourced game keeps Core and the DLC inside the image, so the index has to read
 * them out of it. No test combined the two before, and a launch could not resolve its core.
 */
describe('official mods from an image', () => {
  /** A payload file beats a heredoc: no quoting between the fake and what it prints. */
  async function fakeDocker(out: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dg-fakedocker-'))
    const payload = join(dir, 'payload.txt')
    await writeFile(payload, out)
    const bin = join(dir, 'docker')
    await writeFile(
      bin,
      ['#!/bin/sh', 'case "$*" in', '  *"image inspect"*) echo sha256:feedface ;;', // absolute: PATH is this dir alone, so cat is not on it
      `  *) /bin/cat ${payload} ;;`, 'esac', ''].join('\n'),
    )
    await chmod(bin, 0o755)
    return dir
  }

  const fromImage: GameConfig = {
    ...(FIXTURE_DEFAULTS as GameConfig),
    gameFiles: { source: 'image', container: '/game' },
    image: { ref: 'ghcr.io/me/atlas:1', acquire: 'pull' },
    core: 'test.core',
  }

  test('core is read out of the image when there is no host install', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'dg-cache-'))
    const bin = await fakeDocker('@@gamecrate@@ Core\npackageId test.core\nname Core\n')
    const path = process.env['PATH']
    const home = process.env['XDG_CACHE_HOME']
    process.env['PATH'] = bin
    process.env['XDG_CACHE_HOME'] = cache
    try {
      const index = await buildIndex('atlas', fromImage, plugin)
      expect(index.byPackageId.has('test.core')).toBe(true)
      const [record] = index.byPackageId.get('test.core')!
      expect(record!.kind).toBe('core')
      expect(record!.dir).toContain('sha256-feedface')
    } finally {
      process.env['PATH'] = path
      if (home === undefined) delete process.env['XDG_CACHE_HOME']
      else process.env['XDG_CACHE_HOME'] = home
      await rm(cache, { recursive: true, force: true })
      await rm(bin, { recursive: true, force: true })
    }
  })
})
