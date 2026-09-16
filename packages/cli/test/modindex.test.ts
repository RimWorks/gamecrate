import { describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex, globMatch, resolveModRef } from '../src/mods/modindex'
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
    expect(globMatch('a\\b', 'a\\b')).toBe(true)
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
