import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { exited } from '../src/docker/run'
import { collectRequests, contains, resolveWorktree } from '../src/mods/worktree'
import { applyWorktreeRequests, buildIndex } from '../src/mods/modindex'
import { fixturePlugin, FIXTURE_DEFAULTS } from './fixture-plugin'
import type { GameConfig, WorktreeRequest } from '../src/types'

const PACKAGE_ID = 'fixture.shared'
const BRANCH = 'ci/runtime-package-sync'

let root = ''
let primary = ''
let worktree = ''
let dead = ''
let game: GameConfig

async function git(cwd: string, ...argv: string[]): Promise<void> {
  const proc = spawn('git', argv, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  if ((await exited(proc)) !== 0) throw new Error(`git ${argv.join(' ')} failed in ${cwd}`)
}

async function writeMod(dir: string, packageId: string): Promise<void> {
  await mkdir(join(dir, 'About'), { recursive: true })
  await writeFile(join(dir, 'About', 'About.txt'), `packageId ${packageId}\nname ${packageId}\n`)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gc-worktree-'))
  primary = join(root, 'primary')
  worktree = join(root, 'linked')
  dead = join(root, 'dead')

  await mkdir(primary, { recursive: true })
  await git(primary, 'init', '-b', 'main')
  await git(primary, 'config', 'user.email', 'test@example.invalid')
  await git(primary, 'config', 'user.name', 'test')
  await writeMod(join(primary, 'Mod'), PACKAGE_ID)
  await git(primary, 'add', '-A')
  await git(primary, 'commit', '-m', 'fixture')
  await git(primary, 'worktree', 'add', '-b', BRANCH, worktree)

  // A pruned worktree: the .git file survives, the gitdir it points at does not.
  await mkdir(dead, { recursive: true })
  await writeFile(join(dead, '.git'), `gitdir: ${join(root, 'gone', 'worktrees', 'dead')}\n`)

  game = {
    ...(FIXTURE_DEFAULTS as GameConfig),
    gameFiles: { source: 'image', container: '/game' },
    scanRoots: [{ path: primary, maxDepth: 3 }],
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function isRequest(v: unknown): v is WorktreeRequest {
  return typeof v === 'object' && v !== null && 'root' in v
}

describe('resolveWorktree', () => {
  // The tilde expansion is shared with config/load now; the old private copy dropped a bare `~`
  // on the floor and looked for `<cwd>/~` instead.
  test.skipIf(existsSync(join(homedir(), '.git')))('a bare ~ means the home directory', () => {
    const got = resolveWorktree('~', 'flag', 0)
    expect(isRequest(got)).toBe(false)
    if (isRequest(got)) return
    expect(got.where).toBe(homedir())
  })

  test('a linked worktree is a selection, and carries its branch', () => {
    const got = resolveWorktree(worktree, 'flag', 0)
    expect(isRequest(got)).toBe(true)
    if (!isRequest(got)) return
    expect(got.root).toBe(worktree)
    expect(got.branch).toBe(BRANCH)
  })

  test('a directory INSIDE the worktree resolves to its root', () => {
    const got = resolveWorktree(join(worktree, 'Mod'), 'flag', 0)
    expect(isRequest(got)).toBe(true)
    if (isRequest(got)) expect(got.root).toBe(worktree)
  })

  test('the PRIMARY checkout is not a selection', () => {
    const got = resolveWorktree(primary, 'flag', 0)
    expect(isRequest(got)).toBe(false)
    if (!isRequest(got)) expect(got.message).toContain('primary checkout')
  })

  test('a non-repo directory is not a selection', () => {
    const got = resolveWorktree('/tmp', 'flag', 0)
    expect(isRequest(got)).toBe(false)
  })

  test('a missing path is a Problem, not a throw', () => {
    const got = resolveWorktree('/nope/does/not/exist', 'flag', 0)
    expect(isRequest(got)).toBe(false)
    if (!isRequest(got)) expect(got.message).toContain('does not exist')
  })

  test('a pruned gitdir is not a selection and says how to fix it', () => {
    const got = resolveWorktree(dead, 'flag', 0)
    expect(isRequest(got)).toBe(false)
    if (!isRequest(got)) expect(got.suggestion).toContain('git worktree prune')
  })
})

describe('collectRequests', () => {
  test('flags outrank the env var, which outranks cwd', () => {
    const { requests } = collectRequests([worktree], undefined, primary, false)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.source).toBe('flag')
    expect(requests[0]!.order).toBe(0)
  })

  test('cwd inside a linked worktree is an ambient selection', () => {
    const { requests } = collectRequests([], undefined, join(worktree, 'Mod'), false)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.source).toBe('cwd')
    expect(requests[0]!.root).toBe(worktree)
  })

  test('cwd in a primary checkout yields nothing, silently', () => {
    const { requests, problems } = collectRequests([], undefined, primary, false)
    expect(requests).toEqual([])
    expect(problems).toEqual([])
  })

  test('--no-worktree disables everything, including an explicit flag', () => {
    const { requests } = collectRequests([worktree], worktree, worktree, true)
    expect(requests).toEqual([])
  })

  test('the same directory named twice is one request', () => {
    const { requests } = collectRequests([worktree, join(worktree, 'Mod')], undefined, '/tmp', false)
    expect(requests).toHaveLength(1)
  })

  test('a bad explicit flag is a Problem; a bad cwd is not', () => {
    const withFlag = collectRequests(['/nope/missing'], undefined, '/tmp', false)
    expect(withFlag.problems).toHaveLength(1)

    const cwdOnly = collectRequests([], undefined, '/tmp', false)
    expect(cwdOnly.problems).toEqual([])
  })
})

describe('contains', () => {
  test('matches the root and anything under it, never a sibling prefix', () => {
    const req: WorktreeRequest = { root: '/a/b', branch: 'x', source: 'flag', order: 0 }
    expect(contains(req, '/a/b')).toBe(true)
    expect(contains(req, '/a/b/c/d')).toBe(true)
    expect(contains(req, '/a/bc')).toBe(false)
    expect(contains(req, '/a')).toBe(false)
  })
})

describe('promotion', () => {
  test('an UNSELECTED worktree is not even scanned', async () => {
    const index = await buildIndex('atlas', game, fixturePlugin())
    const bucket = index.byPackageId.get(PACKAGE_ID) ?? []

    expect(bucket).toHaveLength(1)
    expect(bucket[0]!.dir).toBe(join(primary, 'Mod'))
    expect(bucket[0]!.selectedWorktree).toBeUndefined()
  })

  test('a SELECTED worktree beats the primary and is stamped', async () => {
    const index = await buildIndex('atlas', game, fixturePlugin())
    const { requests } = collectRequests([worktree], undefined, '/tmp', false)
    await applyWorktreeRequests(index, requests, game)

    const winner = index.byPackageId.get(PACKAGE_ID)?.[0]
    expect(winner).toBeDefined()
    expect(winner!.dir.startsWith(worktree)).toBe(true)
    expect(winner!.selectedWorktree).toBe(0)
    expect(winner!.worktree?.branch).toBe(BRANCH)
    expect(winner!.worktree?.source).toBe('flag')
  })

  test('selecting one worktree does not promote a different one', async () => {
    const index = await buildIndex('atlas', game, fixturePlugin())
    const requests: WorktreeRequest[] = [{ root: '/some/other/tree', branch: 'x', source: 'flag', order: 0 }]
    await applyWorktreeRequests(index, requests, game)

    const winner = index.byPackageId.get(PACKAGE_ID)?.[0]
    expect(winner!.dir).toBe(join(primary, 'Mod'))
    expect(winner!.selectedWorktree).toBeUndefined()
  })
})
