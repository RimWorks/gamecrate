import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { fixturePlugin } from './fixture-plugin'
import { Exit } from '../src/types'
import type { GameConfig, GamecrateError, LaunchPlan, ParsedArgs, Problem, ProfileConfig } from '../src/types'
import { buildIndex } from '../src/mods/modindex'
import { resolvePlan } from '../src/launch/resolve'
import { cachedSources, cloneDir, defaultBranch, ensureClone, gitRefOf, isMoving, lockDir, normalizeUrl, prepareSources, sourcesRoot, unlinkOrphan } from '../src/mods/source'

const ROOT = '/data/gamecrate'
const MAIN = { kind: 'branch', value: 'main' } as const

function segments(dir: string): string[] {
  return dir.split(sep)
}

describe('normalizeUrl', () => {
  test('strips a trailing .git', () => {
    expect(normalizeUrl('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo')
  })

  test('strips a trailing slash, and a slash in front of .git', () => {
    expect(normalizeUrl('https://github.com/owner/repo/')).toBe('https://github.com/owner/repo')
    expect(normalizeUrl('https://github.com/owner/repo.git/')).toBe('https://github.com/owner/repo')
  })

  test('folds scheme and host case', () => {
    expect(normalizeUrl('HTTPS://GitHub.COM/owner/repo')).toBe('https://github.com/owner/repo')
  })

  test('leaves the path case alone', () => {
    expect(normalizeUrl('HTTPS://GitHub.COM/Owner/Repo.git')).toBe('https://github.com/Owner/Repo')
  })

  test('handles a file:// url', () => {
    expect(normalizeUrl('file:///tmp/GC-Fixture.git/')).toBe('file:///tmp/GC-Fixture')
  })

  test('handles an ssh url, path case intact', () => {
    expect(normalizeUrl('git@github.com:Owner/Repo.git')).toBe('git@github.com:Owner/Repo')
  })

  test('folds the scheme when the host is empty', () => {
    expect(normalizeUrl('FILE:///tmp/X')).toBe(normalizeUrl('file:///tmp/X'))
    expect(normalizeUrl('FILE:///tmp/X')).toBe('file:///tmp/X')
  })

  test('folds the host of an scp-style ssh url, user and path intact', () => {
    expect(normalizeUrl('git@GitHub.com:A/B.git')).toBe(normalizeUrl('git@github.com:A/B'))
    expect(normalizeUrl('git@GitHub.com:A/B.git')).toBe('git@github.com:A/B')
  })

  test('leaves a plain path alone', () => {
    expect(normalizeUrl('/tmp/GC-Fixture/')).toBe('/tmp/GC-Fixture')
  })

  test('folds an ssh:// url without touching the user', () => {
    expect(normalizeUrl('SSH://Git@Host/A/B.git')).toBe('ssh://Git@host/A/B')
  })

  test('leaves the user case alone in both host forms', () => {
    expect(normalizeUrl('ssh://Git@host/a/b')).not.toBe(normalizeUrl('ssh://git@host/a/b'))
    expect(normalizeUrl('Git@host:a/b')).not.toBe(normalizeUrl('git@host:a/b'))
  })

  test('strips a trailing /.git/ whatever the order', () => {
    expect(normalizeUrl('https://github.com/owner/repo/.git/')).toBe('https://github.com/owner/repo')
    expect(normalizeUrl('https://github.com/owner/repo/.git')).toBe('https://github.com/owner/repo')
  })

  test('strips every trailing slash and .git combination, and nothing else', () => {
    for (const [url, want] of [
      ['repo.git.git', 'repo'],
      ['repo/.git/.git/', 'repo'],
      ['repo/.git', 'repo'],
      ['repo.git/', 'repo'],
      ['repo/', 'repo'],
      ['gitrepo', 'gitrepo'],
      ['repo.gitx', 'repo.gitx'],
    ] as const) {
      expect(normalizeUrl(url)).toBe(want)
    }
  })

  // a long interior run of slashes used to backtrack exponentially
  test('a long interior run of slashes is left alone and does not backtrack', () => {
    // 28 slashes: the old regex took ~1.9s there, so a regression trips the guard below. more
    // slashes and it never returns at all, and vitest cannot interrupt a sync regex.
    const url = `https://h/o${'/'.repeat(28)}repo`
    const start = Date.now()
    expect(normalizeUrl(url)).toBe(url)
    expect(normalizeUrl(`${url}.git/`)).toBe(url)
    expect(Date.now() - start).toBeLessThan(1000)
  }, 5000)
})

describe('cloneDir', () => {
  test('always sits under sourcesRoot', () => {
    for (const url of [
      'https://github.com/owner/repo.git',
      'file:///tmp/gc-fixture',
      'git@github.com:owner/repo.git',
    ]) {
      expect(cloneDir(ROOT, url, MAIN).startsWith(sourcesRoot(ROOT) + sep)).toBe(true)
    }
  })

  test('two urls differing only by .git share a directory', () => {
    expect(cloneDir(ROOT, 'https://github.com/owner/repo.git', MAIN))
      .toBe(cloneDir(ROOT, 'https://github.com/owner/repo', MAIN))
  })

  test('same ref value under a different kind gives a different directory', () => {
    const url = 'https://github.com/owner/repo'
    expect(cloneDir(ROOT, url, { kind: 'branch', value: 'main' }))
      .not.toBe(cloneDir(ROOT, url, { kind: 'tag', value: 'main' }))
  })

  test('feat/a and feat-a do not collide', () => {
    const url = 'https://github.com/owner/repo'
    expect(cloneDir(ROOT, url, { kind: 'branch', value: 'feat/a' }))
      .not.toBe(cloneDir(ROOT, url, { kind: 'branch', value: 'feat-a' }))
  })

  test('a traversing url stays under sourcesRoot with no .. segment', () => {
    const dir = cloneDir(ROOT, 'https://evil.example/../../../../etc', MAIN)
    expect(dir.startsWith(sourcesRoot(ROOT) + sep)).toBe(true)
    expect(segments(dir)).not.toContain('..')
    expect(dir).not.toContain('..')
  })

  test('a traversing ref stays under sourcesRoot with no .. segment', () => {
    const dir = cloneDir(ROOT, 'https://github.com/owner/repo', { kind: 'branch', value: '../../../../etc' })
    expect(dir.startsWith(sourcesRoot(ROOT) + sep)).toBe(true)
    expect(segments(dir)).not.toContain('..')
    expect(dir).not.toContain('..')
  })

  test('two spellings of one ssh url share a directory', () => {
    expect(cloneDir(ROOT, 'git@GitHub.com:owner/repo.git', MAIN))
      .toBe(cloneDir(ROOT, 'git@github.com:owner/repo', MAIN))
  })

  test('two spellings of one file url share a directory', () => {
    expect(cloneDir(ROOT, 'FILE:///tmp/gc-fixture/', MAIN))
      .toBe(cloneDir(ROOT, 'file:///tmp/gc-fixture', MAIN))
  })

  test('two urls with the same repo name but different owners do not collide', () => {
    expect(cloneDir(ROOT, 'https://h/a/repo', MAIN)).not.toBe(cloneDir(ROOT, 'https://h/b/repo', MAIN))
  })

  test('an ssh:// url shares a directory with its case variants, not its user variants', () => {
    expect(cloneDir(ROOT, 'SSH://git@Host/o/r.git', MAIN)).toBe(cloneDir(ROOT, 'ssh://git@host/o/r', MAIN))
    expect(cloneDir(ROOT, 'ssh://Git@host/o/r', MAIN)).not.toBe(cloneDir(ROOT, 'ssh://git@host/o/r', MAIN))
  })

  test('a repo url ending in /.git/ shares a directory with the plain one', () => {
    expect(cloneDir(ROOT, 'https://h/o/repo/.git/', MAIN)).toBe(cloneDir(ROOT, 'https://h/o/repo', MAIN))
  })

  test('a file:// url keeps the repo name in the directory', () => {
    const dir = cloneDir(ROOT, 'file:///tmp/gc-fixture', MAIN)
    expect(dir.startsWith(sourcesRoot(ROOT) + sep)).toBe(true)
    expect(dir).toContain('gc-fixture-')
  })
})

const temps: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

// a real repo: commit "one" tagged v1, then commit "two" on main. no network, no mocks
function fixture(): { url: string; dir: string } {
  const dir = temp('gc-remote-')
  const run = (...argv: string[]): void => {
    execFileSync('git', argv, { cwd: dir, stdio: 'pipe' })
  }
  run('init', '-b', 'main')
  // a throwaway repo must not inherit the global hooksPath, its commit-msg hook blocks on a ui.
  run('config', 'core.hooksPath', '/dev/null')
  run('config', 'user.email', 'test@example.invalid')
  run('config', 'user.name', 'gamecrate test')
  writeFileSync(join(dir, 'f.txt'), 'one')
  run('add', 'f.txt')
  run('commit', '-m', 'one')
  run('tag', 'v1')
  writeFileSync(join(dir, 'f.txt'), 'two')
  run('add', 'f.txt')
  run('commit', '-m', 'two')
  return { url: `file://${dir}`, dir }
}

function commit(dir: string, body: string): void {
  writeFileSync(join(dir, 'f.txt'), body)
  execFileSync('git', ['add', 'f.txt'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', body], { cwd: dir, stdio: 'pipe' })
}

function read(dir: string): string {
  return readFileSync(join(dir, 'f.txt'), 'utf8')
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

describe('isMoving', () => {
  test('only a branch moves', () => {
    expect(isMoving({ kind: 'branch', value: 'main' })).toBe(true)
    expect(isMoving({ kind: 'tag', value: 'v1' })).toBe(false)
    expect(isMoving({ kind: 'commit', value: 'abc1234' })).toBe(false)
  })
})

describe('gitRefOf', () => {
  test('reads the one field that is set, branch first', () => {
    expect(gitRefOf({ branch: 'main' })).toEqual({ kind: 'branch', value: 'main' })
    expect(gitRefOf({ tag: 'v1' })).toEqual({ kind: 'tag', value: 'v1' })
    expect(gitRefOf({ commit: 'abc1234' })).toEqual({ kind: 'commit', value: 'abc1234' })
    expect(gitRefOf({})).toBeUndefined()
  })
})

describe('defaultBranch', () => {
  test('reads main off the fixture', () => {
    const remote = fixture()
    expect(defaultBranch(remote.url)).toEqual({ kind: 'branch', value: 'main' })
  })

  test('throws naming the url when the remote is not there', () => {
    const gone = `file://${join(tmpdir(), 'gc-not-a-repo-12345')}`
    expect(() => defaultBranch(gone)).toThrow(/gc-not-a-repo-12345/)
  })
})

describe('ensureClone', () => {
  test('a branch pin lands detached on the branch tip', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const res = await ensureClone(root, { url: remote.url }, { kind: 'branch', value: 'main' }, 'fetch')
    expect(res.warning).toBeUndefined()
    expect(read(res.dir)).toBe('two')
    // a bare clone also lands on main at two, only the detached checkout leaves HEAD off a branch
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: res.dir, encoding: 'utf8' })
    expect(head.trim()).toBe('HEAD')
  })

  test('a tag pin lands on the tag, and only force moves it', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const pin = { url: remote.url }
    const ref = { kind: 'tag', value: 'v1' } as const

    const first = await ensureClone(root, pin, ref, 'fetch')
    expect(read(first.dir)).toBe('one')

    execFileSync('git', ['tag', '-f', 'v1'], { cwd: remote.dir, stdio: 'pipe' })

    const second = await ensureClone(root, pin, ref, 'fetch')
    expect(read(second.dir)).toBe('one')

    const third = await ensureClone(root, pin, ref, 'force')
    expect(read(third.dir)).toBe('two')
  })

  test('a branch pin picks up a new remote commit on the next fetch', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const ref = { kind: 'branch', value: 'main' } as const
    const first = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(read(first.dir)).toBe('two')

    commit(remote.dir, 'three')

    const second = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(read(second.dir)).toBe('three')
  })

  test('use never moves a clone even when the remote has advanced', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const ref = { kind: 'branch', value: 'main' } as const
    await ensureClone(root, { url: remote.url }, ref, 'fetch')

    commit(remote.dir, 'three')

    const res = await ensureClone(root, { url: remote.url }, ref, 'use')
    expect(read(res.dir)).toBe('two')
  })

  test('use with nothing on disk throws, hinting at mods sync', async () => {
    const root = temp('gc-data-')
    const url = 'file:///tmp/gc-never-cloned'
    const error = await ensureClone(root, { url }, { kind: 'branch', value: 'main' }, 'use')
      .then(() => undefined, (thrown: GamecrateError) => thrown)
    expect(error?.message).toContain(url)
    expect(error?.code).toBe(Exit.Resolution)
    expect(error?.detail).toMatch(/gamecrate mods sync/)
  })

  test('a hand edit inside the cache is discarded', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const ref = { kind: 'branch', value: 'main' } as const
    const first = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    writeFileSync(join(first.dir, 'f.txt'), 'tampered')

    const second = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(read(second.dir)).toBe('two')
  })

  test('a failed fetch with a clone on disk warns and keeps the old tree', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const ref = { kind: 'branch', value: 'main' } as const
    const first = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    rmSync(remote.dir, { recursive: true, force: true })

    const second = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(second.warning).toMatch(/could not fetch/)
    expect(second.warning).toContain(remote.url)
    expect(read(second.dir)).toBe('two')
    expect(second.dir).toBe(first.dir)
  })

  test('a directory with no .git is re-cloned, and is a hard error under use', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const ref = { kind: 'branch', value: 'main' } as const
    const dir = cloneDir(root, remote.url, ref)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'f.txt'), 'half a clone')

    const error = await ensureClone(root, { url: remote.url }, ref, 'use')
      .then(() => undefined, (thrown: GamecrateError) => thrown)
    expect(error?.code).toBe(Exit.Resolution)
    expect(error?.detail).toMatch(/gamecrate mods sync/)

    const res = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(res.warning).toBeUndefined()
    expect(read(res.dir)).toBe('two')
    expect(existsSync(join(res.dir, '.git'))).toBe(true)
  })

  test('a clone killed mid-clone is re-cloned, and is a hard error under use', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const ref = { kind: 'branch', value: 'main' } as const
    const dir = cloneDir(root, remote.url, ref)
    mkdirSync(dir, { recursive: true })
    // what SIGKILL on `git clone` leaves behind: a .git with HEAD, config, objects and refs, no
    // commit, and an origin with no fetch refspec, so nothing downstream ever repairs it
    const run = (...argv: string[]): void => {
      execFileSync('git', argv, { cwd: dir, stdio: 'pipe' })
    }
    run('init')
    run('remote', 'add', 'origin', remote.url)
    run('config', '--unset', 'remote.origin.fetch')
    // a `.git` check alone passes this directory, which is why the gate resolves HEAD instead
    expect(existsSync(join(dir, '.git'))).toBe(true)

    const error = await ensureClone(root, { url: remote.url }, ref, 'use')
      .then(() => undefined, (thrown: GamecrateError) => thrown)
    expect(error?.code).toBe(Exit.Resolution)
    expect(error?.detail).toMatch(/gamecrate mods sync/)

    const res = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(res.warning).toBeUndefined()
    expect(read(res.dir)).toBe('two')
  })

  test('a failed clone with nothing on disk throws, naming the url', async () => {
    const root = temp('gc-data-')
    const url = `file://${join(tmpdir(), 'gc-not-a-repo-67890')}`
    const ref = { kind: 'branch', value: 'main' } as const
    await expect(ensureClone(root, { url }, ref, 'fetch')).rejects.toThrow(/gc-not-a-repo-67890/)
    expect(existsSync(cloneDir(root, url, ref))).toBe(false)
  })

  test('a commit pin never moves, and force resets to that exact commit', async () => {
    const remote = fixture()
    const root = temp('gc-data-')
    const sha = execFileSync('git', ['rev-parse', 'v1^{commit}'], { cwd: remote.dir, encoding: 'utf8' }).trim()
    const ref = { kind: 'commit', value: sha } as const

    const first = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(read(first.dir)).toBe('one')

    commit(remote.dir, 'three')

    const second = await ensureClone(root, { url: remote.url }, ref, 'fetch')
    expect(read(second.dir)).toBe('one')

    // force has to actually fetch and reset, so a wrong reset target shows up as a warning
    writeFileSync(join(second.dir, 'f.txt'), 'tampered')
    const third = await ensureClone(root, { url: remote.url }, ref, 'force')
    expect(third.warning).toBeUndefined()
    expect(read(third.dir)).toBe('one')
  })
})

describe('lockDir', () => {
  test('is exclusive until released', async () => {
    const root = temp('gc-data-')
    const dir = join(root, 'sources', 'x')
    const release = await lockDir(dir)

    let taken = false
    const second = lockDir(dir).then((r) => {
      taken = true
      return r
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(taken).toBe(false)

    await release()
    const secondRelease = await second
    expect(taken).toBe(true)
    await secondRelease()
  })

  test('takes over a lock whose holder is gone', async () => {
    const root = temp('gc-data-')
    const dir = join(root, 'sources', 'x')
    mkdirSync(dirname(dir), { recursive: true })
    const dead = execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim()
    writeFileSync(`${dir}.lock`, JSON.stringify({ pid: Number(dead), startedAt: new Date().toISOString() }))

    const release = await Promise.race([
      lockDir(dir),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waited on a dead holder')), 2000)),
    ])
    await release()
  })

  // a simulation, not two real processes: it plays A's read, B's legitimate take, then A's steal
  // in order, which is the interleaving a true race would have to hit by luck
  test('a steal refuses once another holder has taken the lock', async () => {
    const root = temp('gc-data-')
    const path = join(root, 'x.lock')
    const dead = execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim()
    // one timestamp for both, so the records differ by pid alone on every run and not just the ones
    // where two `new Date()` calls land in the same millisecond
    const at = new Date().toISOString()
    const seen = JSON.stringify({ pid: Number(dead), startedAt: at })
    writeFileSync(path, seen)

    // B wins the orphan and writes its own live record while A still holds the record it read
    const live = JSON.stringify({ pid: process.pid, startedAt: at })
    writeFileSync(path, live)

    expect(await unlinkOrphan(path, seen)).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(live)
  })

  test('a steal refuses when the pid matches but the start time does not', async () => {
    const root = temp('gc-data-')
    const path = join(root, 'x.lock')
    const dead = execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim()
    const seen = JSON.stringify({ pid: Number(dead), startedAt: new Date(Date.now() - 60_000).toISOString() })
    writeFileSync(path, seen)

    // pid reuse: the two records differ by startedAt alone, so comparing pid only would still refuse
    const live = JSON.stringify({ pid: Number(dead), startedAt: new Date().toISOString() })
    writeFileSync(path, live)

    expect(await unlinkOrphan(path, seen)).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(live)
  })

  test('a steal goes through while the lock still reads as the dead record', async () => {
    const root = temp('gc-data-')
    const path = join(root, 'x.lock')
    const seen = JSON.stringify({ pid: 1, startedAt: new Date().toISOString() })
    writeFileSync(path, seen)

    expect(await unlinkOrphan(path, seen)).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  test('releasing twice does not unlink the next holder', async () => {
    const root = temp('gc-data-')
    const dir = join(root, 'sources', 'x')
    const release = await lockDir(dir)
    await release()

    const second = await lockDir(dir)
    await release()
    expect(existsSync(`${dir}.lock`)).toBe(true)
    await second()
  })
})

function gameWith(library: GameConfig['library'], profiles: Record<string, ProfileConfig>, base: string[] = []): GameConfig {
  return {
    gameFiles: { source: 'mount', host: temp('gc-game-'), container: '/game' },
    dataDir: { container: '/data', mode: 'arg', arg: '-savedatafolder=/data' },
    modsDir: { container: '/game/Mods' },
    logFile: { mode: 'arg', arg: '-logfile' },
    image: { ref: 'atlas-build:latest', acquire: 'build' },
    executable: './AtlasLinux',
    steamAppId: 294100,
    workshopRoot: null,
    scanRoots: [],
    manifest: { file: 'About/About.txt' },
    modsConfig: { file: 'Config/ModsConfig.txt' },
    prefs: { file: 'Config/Prefs.txt' },
    saveExtensions: ['sav'],
    core: 'Atlasco.Atlas',
    dlc: [],
    base,
    library,
    modes: ['headed', 'headless', 'screenshot'],
    profiles,
  }
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

/** A mod the fixture repo carries, so a clone of it is something the index can read. */
function modAt(dir: string, subdir: string, id: string): string {
  const at = join(dir, subdir, 'About')
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'About.txt'), `packageId ${id}\nname ${id}\n`)
  return join(dir, subdir)
}

describe('prepareSources', () => {
  test('collects ids from base, an inherited profile, an object entry and --mod', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const pin = { git: url, branch: 'main' }
    const game = gameWith(
      { 'from.base': pin, 'from.parent': pin, 'from.object': pin, 'from.flag': pin },
      {
        parent: { mods: ['From.Parent'] },
        child: { extends: 'parent', mods: [{ id: 'From.Object' }] },
      },
      ['From.Base'],
    )
    const result = await prepareSources(game, 'child', cliArgs({ mods: ['From.Flag'] }), data, true)
    try {
      expect([...result.dirs.keys()].sort()).toEqual(['from.base', 'from.flag', 'from.object', 'from.parent'])
      expect(result.dirs.get('from.base')).toBe(cloneDir(data, url, MAIN))
    } finally {
      await result.release()
    }
  })

  test('an excluded id is never fetched', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const game = gameWith(
      { 'gone.mod': { git: 'file:///nowhere/at/all', branch: 'main' }, 'kept.mod': { git: url, branch: 'main' } },
      { p: { exclude: ['Gone.Mod'] } },
      ['Gone.Mod', 'Kept.Mod'],
    )
    const result = await prepareSources(game, 'p', cliArgs(), data, true)
    try {
      expect([...result.dirs.keys()]).toEqual(['kept.mod'])
      expect(result.fetched).toHaveLength(1)
    } finally {
      await result.release()
    }
  })

  test('a dynamic match entry contributes nothing', async () => {
    const data = temp('gc-data-')
    const game = gameWith({ 'acme.pack': { git: 'file:///nowhere', branch: 'main' } }, { p: { mods: [{ match: 'Acme.*' }] } })
    const result = await prepareSources(game, 'p', cliArgs(), data, true)
    expect(result.dirs.size).toBe(0)
    expect(result.fetched).toEqual([])
  })

  test('a mixed-case library key resolves from a differently-cased ref', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const pin = { git: url, branch: 'main' }
    const game = gameWith({ 'Acme.Mod': pin, 'two.mod': pin }, { p: { mods: ['acme.mod', 'TWO.MOD'] } })
    const result = await prepareSources(game, 'p', cliArgs(), data, true)
    try {
      expect(result.dirs.get('acme.mod')).toBe(cloneDir(data, url, MAIN))
      expect(result.dirs.get('two.mod')).toBe(cloneDir(data, url, MAIN))
    } finally {
      await result.release()
    }
    expect(cachedSources(game, 'p', cliArgs(), data).get('acme.mod')).toBe(cloneDir(data, url, MAIN))
  })

  test('two pins on one clone fetch it once', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const pin = { git: url, tag: 'v1' }
    const game = gameWith({ 'one.mod': pin, 'two.mod': pin }, { p: { mods: ['One.Mod', 'Two.Mod'] } })
    const result = await prepareSources(game, 'p', cliArgs(), data, true)
    try {
      expect(result.fetched).toHaveLength(1)
      expect(result.dirs.get('one.mod')).toBe(result.dirs.get('two.mod'))
    } finally {
      await result.release()
    }
  })

  test('allowFetch false leaves the clone where it is', async () => {
    const { url, dir } = fixture()
    const data = temp('gc-data-')
    const game = gameWith({ 'one.mod': { git: url, branch: 'main' } }, { p: { mods: ['One.Mod'] } })
    const first = await prepareSources(game, 'p', cliArgs(), data, true)
    await first.release()
    commit(dir, 'three')

    const second = await prepareSources(game, 'p', cliArgs(), data, false)
    await second.release()
    expect(read(cloneDir(data, url, MAIN))).toBe('two')
  })

  test('allowFetch false with no clone on disk points at mods sync', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const game = gameWith({ 'one.mod': { git: url, branch: 'main' } }, { p: { mods: ['One.Mod'] } })
    const error = await prepareSources(game, 'p', cliArgs(), data, false).catch((e: GamecrateError) => e)
    expect((error as GamecrateError).code).toBe(Exit.Resolution)
    expect((error as GamecrateError).detail).toContain('mods sync')
    expect(existsSync(`${cloneDir(data, url, MAIN)}.lock`)).toBe(false)
  })

  test('an unpinned entry reads the default branch once per url', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const shim = temp('gc-path-')
    const log = join(shim, 'calls.txt')
    writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$@" >> ${log}\nexec ${execFileSync('which', ['git']).toString().trim()} "$@"\n`, { mode: 0o755 })
    const game = gameWith(
      { 'one.mod': { git: url }, 'two.mod': { git: `${url}.git` } },
      { p: { mods: ['One.Mod', 'Two.Mod'] } },
    )
    const before = process.env['PATH']
    process.env['PATH'] = `${shim}:${before ?? ''}`
    try {
      const result = await prepareSources(game, 'p', cliArgs(), data, true)
      await result.release()
      expect(result.dirs.get('one.mod')).toBe(cloneDir(data, url, MAIN))
    } finally {
      process.env['PATH'] = before
    }
    const calls = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('ls-remote'))
    expect(calls).toHaveLength(1)
  })

  test('release frees every lock it took', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const game = gameWith({ 'one.mod': { git: url, branch: 'main' } }, { p: { mods: ['One.Mod'] } })
    const result = await prepareSources(game, 'p', cliArgs(), data, true)
    const dir = result.dirs.get('one.mod') as string
    expect(existsSync(`${dir}.lock`)).toBe(true)
    await result.release()

    const again = await lockDir(dir)
    await again()
  })

  test('locks go in clone order, whichever ids a run names', async () => {
    const data = temp('gc-data-')
    const first = fixture()
    const second = fixture()
    // the hash in a clone dir is not predictable, so decide which url is which after the fact
    const [low, high] = [cloneDir(data, first.url, MAIN), cloneDir(data, second.url, MAIN)].sort()
    const urlOf = (dir: string): string => (dir === cloneDir(data, first.url, MAIN) ? first.url : second.url)
    // a.one and d.four share the later clone, b.two and c.three the earlier one, so sorting ids
    // would hand the two runs opposite lock orders
    const library = {
      'a.one': { git: urlOf(high as string), branch: 'main' },
      'b.two': { git: urlOf(low as string), branch: 'main' },
      'c.three': { git: urlOf(low as string), branch: 'main', subdir: 'Pack' },
      'd.four': { git: urlOf(high as string), branch: 'main', subdir: 'Pack' },
    }
    const sequence = async (mods: string[]): Promise<string[]> => {
      const game = gameWith(library, { p: { mods } })
      const result = await prepareSources(game, 'p', cliArgs(), data, true)
      await result.release()
      return result.fetched
    }

    expect(await sequence(['A.One', 'C.Three'])).toEqual([low, high])
    expect(await sequence(['B.Two', 'D.Four'])).toEqual([low, high])
  })

  test('preCore, core and dlc ids are pinnable, and the drop list still reaches them', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const pin = { git: url, branch: 'main' }
    const game = gameWith({ 'pre.core': pin, 'atlasco.atlas': pin, 'the.dlc': pin }, { p: { mods: [] } })
    game.preCore = ['Pre.Core']
    game.dlc = ['The.Dlc']

    const result = await prepareSources(game, 'p', cliArgs(), data, true)
    try {
      expect([...result.dirs.keys()].sort()).toEqual(['atlasco.atlas', 'pre.core', 'the.dlc'])
    } finally {
      await result.release()
    }

    // the other side: they are not exempt, they go through the same drop list as every other id
    const args = cliArgs({ without: ['Pre.Core', 'The.Dlc', 'Atlasco.Atlas'] })
    const dropped = await prepareSources(game, 'p', args, data, true)
    try {
      expect([...dropped.dirs.keys()]).toEqual([])
    } finally {
      await dropped.release()
    }
  })

  test('per-version directories in one clone are one mod, so nothing ties', async () => {
    const { dir: remote, url } = fixture()
    modAt(remote, 'V14/Mod', 'Acme.Mod')
    modAt(remote, 'V15/Mod', 'Acme.Mod')
    modAt(remote, 'Core', 'Atlasco.Atlas')
    execFileSync('git', ['add', '-A'], { cwd: remote, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'mods'], { cwd: remote, stdio: 'pipe' })

    const data = temp('gc-data-')
    const game = gameWith({ 'acme.mod': { git: url, branch: 'main' } }, { p: { mods: ['Acme.Mod'] } })
    const sources = await prepareSources(game, 'p', cliArgs(), data, true)
    await sources.release()

    const index = await buildIndex('atlas', game, fixturePlugin('atlas'), sourcesRoot(data))
    expect((index.byPackageId.get('acme.mod') ?? []).map((r) => r.dir))
      .toEqual([join(cloneDir(data, url, MAIN), 'V14', 'Mod')])

    // the tie used to be fatal here, and this is the caller that has no map to dodge it with
    const { problems } = await resolvePlan({
      game: 'atlas',
      profile: 'p',
      plugins: new Map([['atlas', fixturePlugin('atlas')]]),
      root: { dataRoot: data, defaults: { settings: {} }, games: { atlas: game } },
      index,
      sources: new Map(),
    })
    expect(problems).toEqual([])
  })

  test('the collapse is per clone and per id, never wider', async () => {
    const { dir: remote, url } = fixture()
    modAt(remote, 'V14/Mod', 'Acme.Mod')
    modAt(remote, 'V15/Mod', 'Acme.Mod')
    modAt(remote, 'Other', 'Acme.Other')
    modAt(remote, 'Core', 'Atlasco.Atlas')
    execFileSync('git', ['add', '-A'], { cwd: remote, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'mods'], { cwd: remote, stdio: 'pipe' })
    execFileSync('git', ['tag', 'v2'], { cwd: remote, stdio: 'pipe' })

    const data = temp('gc-data-')
    const game = gameWith({ 'acme.mod': { git: url, branch: 'main' } }, { p: { mods: ['Acme.Mod'] } })
    const onBranch = await prepareSources(game, 'p', cliArgs(), data, true)
    await onBranch.release()
    const tagged = gameWith({ 'acme.mod': { git: url, tag: 'v2' } }, { p: { mods: ['Acme.Mod'] } })
    const onTag = await prepareSources(tagged, 'p', cliArgs(), data, true)
    await onTag.release()

    const index = await buildIndex('atlas', game, fixturePlugin('atlas'), sourcesRoot(data))
    // two clones still contribute two records: the collapse must not reach across a ref
    expect((index.byPackageId.get('acme.mod') ?? []).map((r) => r.dir).sort()).toEqual([
      join(cloneDir(data, url, MAIN), 'V14', 'Mod'),
      join(cloneDir(data, url, { kind: 'tag', value: 'v2' }), 'V14', 'Mod'),
    ].sort())
    // and a second id inside the same clones is untouched
    expect((index.byPackageId.get('acme.other') ?? []).length).toBe(2)
  })

  test('a git pin prepared here resolves to the subdir it names, not the one the scan finds', async () => {
    const { dir: remote, url } = fixture()
    // both declare Acme.Twin, and `Decoy` sorts ahead of `Wanted`, so a packageId scan alone
    // picks the wrong one. only the sources map can tell them apart.
    modAt(remote, 'Decoy', 'Acme.Twin')
    modAt(remote, 'Wanted', 'Acme.Twin')
    modAt(remote, 'Core', 'Atlasco.Atlas')
    execFileSync('git', ['add', '-A'], { cwd: remote, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'mods'], { cwd: remote, stdio: 'pipe' })

    const data = temp('gc-data-')
    const game = gameWith({ 'acme.twin': { git: url, branch: 'main', subdir: 'Wanted' } }, { p: { mods: ['Acme.Twin'] } })
    const sources = await prepareSources(game, 'p', cliArgs(), data, true)
    try {
      const index = await buildIndex('atlas', game, fixturePlugin('atlas'), sourcesRoot(data))
      const plan = async (map: Map<string, string>): Promise<{ plan: LaunchPlan; problems: Problem[] }> =>
        await resolvePlan({
          game: 'atlas',
          profile: 'p',
          plugins: new Map([['atlas', fixturePlugin('atlas')]]),
          root: { dataRoot: data, defaults: { settings: {} }, games: { atlas: game } },
          index,
          sources: map,
        })

      const clone = cloneDir(data, url, MAIN)
      const prepared = await plan(sources.dirs)
      expect(prepared.problems).toEqual([])
      expect(prepared.plan.mods.map((mod: { hostDir: string }) => mod.hostDir)).toContain(join(clone, 'Wanted'))

      // without the map the pin says nothing, and the scan hands back the decoy
      const bare = await plan(new Map())
      expect(bare.plan.mods.map((mod: { hostDir: string }) => mod.hostDir)).toContain(join(clone, 'Decoy'))
    } finally {
      await sources.release()
    }
  })
})

describe('cachedSources', () => {
  test('maps a pinned id only once its clone is on disk', async () => {
    const { url } = fixture()
    const data = temp('gc-data-')
    const game = gameWith(
      { 'acme.one': { git: url, tag: 'v1' }, 'acme.two': { git: url, tag: 'v1' } },
      { p: { mods: ['Acme.One', 'Acme.Two'] } },
    )
    // the other side of the existsSync check: an id whose clone was never fetched stays out
    expect([...cachedSources(game, 'p', cliArgs(), data).keys()]).toEqual([])

    const prepared = await prepareSources(game, 'p', cliArgs(), data, true)
    await prepared.release()

    const map = cachedSources(game, 'p', cliArgs(), data)
    expect(map.get('acme.one')).toBe(cloneDir(data, url, { kind: 'tag', value: 'v1' }))
    expect(map.get('acme.two')).toBe(map.get('acme.one'))
  })

  test('an unpinned entry takes the one branch clone on disk, and abstains on two', async () => {
    const { dir: remote, url } = fixture()
    execFileSync('git', ['branch', 'other'], { cwd: remote, stdio: 'pipe' })
    const data = temp('gc-data-')
    const game = gameWith({ 'acme.one': { git: url } }, { p: { mods: ['Acme.One'] } })
    const prepared = await prepareSources(game, 'p', cliArgs(), data, true)
    await prepared.release()
    expect(cachedSources(game, 'p', cliArgs(), data).get('acme.one')).toBe(cloneDir(data, url, MAIN))

    const second = gameWith({ 'acme.one': { git: url, branch: 'other' } }, { p: { mods: ['Acme.One'] } })
    const also = await prepareSources(second, 'p', cliArgs(), data, true)
    await also.release()
    // two branch clones of one url is a coin flip, so it maps nothing and leaves the scan in charge
    expect(cachedSources(game, 'p', cliArgs(), data).has('acme.one')).toBe(false)
  })
})

describe('a cache-versus-cache tie', () => {
  const V2 = { kind: 'tag', value: 'v2' } as const
  const V3 = { kind: 'tag', value: 'v3' } as const

  /** Two tagged refs that both carry the mods, both cloned: one id, two cache records. */
  async function repinned(data: string): Promise<{ url: string; one: string; two: string }> {
    const { dir: remote, url } = fixture()
    const run = (...argv: string[]): void => {
      execFileSync('git', argv, { cwd: remote, stdio: 'pipe' })
    }
    modAt(remote, 'Mod', 'Acme.Mod')
    modAt(remote, 'Core', 'Atlasco.Atlas')
    run('add', '-A')
    run('commit', '-m', 'mods')
    run('tag', 'v2')
    commit(remote, 'three')
    run('tag', 'v3')

    for (const ref of ['v2', 'v3']) {
      const game = gameWith({ 'acme.mod': { git: url, tag: ref } }, { p: { mods: ['Acme.Mod'] } })
      const prepared = await prepareSources(game, 'p', cliArgs(), data, true)
      await prepared.release()
    }
    return { url, one: cloneDir(data, url, V2), two: cloneDir(data, url, V3) }
  }

  /** mtime to the second, so the assertion never rides on how fast two clones ran. */
  function fetchedAt(dir: string, seconds: number): void {
    utimesSync(dir, seconds, seconds)
  }

  async function problemsAndDirs(
    game: GameConfig,
    data: string,
    sources: Map<string, string>,
    profile = 'p',
  ): Promise<{ problems: Problem[]; dirs: string[] }> {
    const index = await buildIndex('atlas', game, fixturePlugin('atlas'), sourcesRoot(data))
    const { plan, problems } = await resolvePlan({
      game: 'atlas',
      profile,
      plugins: new Map([['atlas', fixturePlugin('atlas')]]),
      root: { dataRoot: data, defaults: { settings: {} }, games: { atlas: game } },
      index,
      sources,
    })
    return { problems, dirs: plan.mods.map((mod: { hostDir: string }) => mod.hostDir) }
  }

  test('path 1: a match: glob over a repinned mod takes the newest clone, either way round', async () => {
    const data = temp('gc-data-')
    const { url, one, two } = await repinned(data)
    // a glob is never pinnable, so cachedSources maps nothing and this lands in pick()
    const game = gameWith({ 'acme.mod': { git: url, tag: 'v3' } }, { p: { mods: [{ match: 'Acme.M*' }] } })
    expect(cachedSources(game, 'p', cliArgs(), data).has('acme.mod')).toBe(false)

    fetchedAt(one, 1_000)

    fetchedAt(two, 2_000)
    const newer = await problemsAndDirs(game, data, new Map())
    expect(newer.problems).toEqual([])
    expect(newer.dirs).toContain(join(two, 'Mod'))

    // the other way round: it is the clock that decides, not the directory name
    fetchedAt(one, 3_000)
    const older = await problemsAndDirs(game, data, new Map())
    expect(older.problems).toEqual([])
    expect(older.dirs).toContain(join(one, 'Mod'))
  })

  test('path 2: an unpinned entry with two branch clones is unmapped, and still resolves', async () => {
    const { dir: remote, url } = fixture()
    modAt(remote, 'Mod', 'Acme.Mod')
    modAt(remote, 'Core', 'Atlasco.Atlas')
    execFileSync('git', ['add', '-A'], { cwd: remote, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'mods'], { cwd: remote, stdio: 'pipe' })
    execFileSync('git', ['branch', 'other'], { cwd: remote, stdio: 'pipe' })

    const data = temp('gc-data-')
    for (const branch of ['main', 'other']) {
      const pinned = gameWith({ 'acme.mod': { git: url, branch } }, { p: { mods: ['Acme.Mod'] } })
      const prepared = await prepareSources(pinned, 'p', cliArgs(), data, true)
      await prepared.release()
    }
    const other = cloneDir(data, url, { kind: 'branch', value: 'other' })

    const game = gameWith({ 'acme.mod': { git: url } }, { p: { mods: ['Acme.Mod'] } })
    // soleBranchClone abstains on two, which is what put this id back in front of pick()
    expect(cachedSources(game, 'p', cliArgs(), data).has('acme.mod')).toBe(false)

    fetchedAt(cloneDir(data, url, MAIN), 1_000)
    fetchedAt(other, 2_000)
    const result = await problemsAndDirs(game, data, new Map())
    expect(result.problems).toEqual([])
    expect(result.dirs).toContain(join(other, 'Mod'))
  })

  test('path 3: doctor reaches it through a git-pinned dlc, and its map keeps the subdir', async () => {
    const data = temp('gc-data-')
    const { url, one, two } = await repinned(data)
    const game = gameWith({ 'acme.mod': { git: url, tag: 'v3', subdir: 'Mod' } }, {})
    game.dlc = ['Acme.Mod']
    fetchedAt(one, 2_000)
    fetchedAt(two, 1_000)

    // doctor runs modless and passes this map, so the pin names its own directory
    const sources = cachedSources(game, 'modless', {}, data)
    expect(sources.get('acme.mod')).toBe(two)
    const mapped = await problemsAndDirs(game, data, sources, 'modless')
    expect(mapped.problems).toEqual([])
    expect(mapped.dirs).toContain(join(two, 'Mod'))

    // and with no map at all the tie is still broken rather than fatal, here toward the older tag
    const bare = await problemsAndDirs(game, data, new Map(), 'modless')
    expect(bare.problems).toEqual([])
    expect(bare.dirs).toContain(join(one, 'Mod'))
  })

  test('the clock never reorders a clone against a local checkout', async () => {
    const data = temp('gc-data-')
    const { url, one, two } = await repinned(data)
    const checkout = temp('gc-local-')
    modAt(checkout, 'Acme', 'Acme.Mod')

    const game = gameWith({ 'acme.mod': { git: url, tag: 'v3' } }, { p: { mods: ['Acme.Mod'] } })
    game.scanRoots = [{ path: checkout, maxDepth: 2 }]
    // both clones newer than anything: a scan-root record carries no clonedAt and must still win
    fetchedAt(one, 3_999_999_999)
    fetchedAt(two, 4_000_000_000)

    const result = await problemsAndDirs(game, data, new Map())
    expect(result.problems).toEqual([])
    expect(result.dirs).toContain(join(checkout, 'Acme'))
  })
})
