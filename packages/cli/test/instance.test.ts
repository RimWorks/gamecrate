import { describe, expect, test, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveInstance } from '../src/launch/instance'
import type { ParsedArgs, ProfileConfig } from '../src/types'

let repo: string
let treeA: string
let treeB: string

function git(cwd: string, ...argv: string[]): void {
  // The fixture commit would otherwise open the commit-msg review window and block, and only
  // one of those can be open at a time, so it would also stall every other repo on the machine.
  const env = { ...process.env, GIT_COMMIT_REVIEW: '0' }
  const r = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', env })
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`)
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gamecrate-instance-'))
  writeFileSync(join(repo, 'README'), 'hi\n')
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'init')

  treeA = join(repo, '.worktrees', 'fix-thing')
  treeB = join(repo, '.worktrees', 'other-thing')
  git(repo, 'worktree', 'add', '-b', 'fix/thing', treeA)
  git(repo, 'worktree', 'add', '-b', 'other/thing', treeB)
  mkdirSync(join(treeA, 'nested'), { recursive: true })
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

const PROFILE_DIR = '/data/atlas/dev'

function args(over: Partial<ParsedArgs> = {}): Partial<ParsedArgs> {
  return { worktree: [], noWorktree: false, ...over }
}

/** cwd defaults to process.cwd(), which is a repo; every case states it explicitly. */
function select(over: Partial<ParsedArgs>, profile?: ProfileConfig, cwd = '/tmp') {
  return resolveInstance({
    profileDir: PROFILE_DIR,
    ...(profile === undefined ? {} : { profile }),
    args: args(over),
    cwd,
    env: undefined,
  })
}

describe('resolveInstance', () => {
  test('no worktree and no flag is the base profile', () => {
    const got = select({})
    expect(got.name).toBeUndefined()
    expect(got.dir).toBe(PROFILE_DIR)
  })

  test('a --worktree flag forks an instance under the profile', () => {
    const got = select({ worktree: [treeA] })
    expect(got.name).toBeDefined()
    expect(got.name).toMatch(/^fix-thing-/)
    expect(got.dir).toBe(join(PROFILE_DIR, 'instances', got.name!))
  })

  test('the same worktree spelled two ways is the same instance', () => {
    const byRoot = select({ worktree: [treeA] })
    const byChild = select({ worktree: [join(treeA, 'nested')] })
    expect(byChild.name).toBe(byRoot.name!)
  })

  test('two worktrees are two instances', () => {
    expect(select({ worktree: [treeB] }).name).not.toBe(select({ worktree: [treeA] }).name!)
  })

  // Two repos can each hold a `.worktrees/fix-thing`; sharing a save dir would be a data loss.
  test('the name carries a hash of the root, not just its basename', () => {
    const name = select({ worktree: [treeA] }).name!
    expect(name).toMatch(/^fix-thing-[0-9a-f]{6}$/)
  })

  test('an ambient cwd forks an instance of its own', () => {
    const got = select({}, undefined, treeA)
    expect(got.requests.length).toBe(1)
    expect(got.requests[0]!.source).toBe('cwd')
    expect(got.name).toMatch(/^fix-thing-[0-9a-f]{6}$/)
    expect(got.dir).toBe(join(PROFILE_DIR, 'instances', got.name!))
  })

  // The whole point: two checkouts of one profile must not share a save dir or a launch lock.
  test('two ambient worktrees of one profile are two instances', () => {
    expect(select({}, undefined, treeA).name).not.toBe(select({}, undefined, treeB).name!)
  })

  test('an ambient cwd reaches the same instance as naming it with --worktree', () => {
    expect(select({}, undefined, treeA).name).toBe(select({ worktree: [treeA] }).name!)
  })

  // Different mods are staged, so the two runs cannot land on the flag's instance alone.
  test('a flag and an ambient cwd together make a third instance', () => {
    const both = select({ worktree: [treeB] }, undefined, treeA)
    expect(both.requests.map((r) => r.root)).toEqual([treeB, treeA])
    expect(both.name).toMatch(/^other-thing-/)
    expect(both.name).not.toBe(select({ worktree: [treeB] }).name!)
  })

  test('--instance wins over a derived name', () => {
    const got = select({ instance: 'scratch', worktree: [treeA] })
    expect(got.name).toBe('scratch')
    expect(got.dir).toBe(join(PROFILE_DIR, 'instances', 'scratch'))
  })

  test('an instance name that cannot be a directory or container is rejected', () => {
    expect(() => select({ instance: '../escape' })).toThrow(/invalid instance name/)
    expect(() => select({ instance: '-lead' })).toThrow(/invalid instance name/)
  })

  test('--no-worktree keeps the base profile even with an explicit flag', () => {
    const got = select({ worktree: [treeA], noWorktree: true })
    expect(got.requests).toEqual([])
    expect(got.name).toBeUndefined()
  })

  test('a configured instance contributes its worktree and its settings', () => {
    const profile: ProfileConfig = {
      instances: { 'wt-a': { worktree: treeA, settings: { gameArgs: ['-quicktest'] } } },
    }
    const got = select({ instance: 'wt-a' }, profile)

    expect(got.name).toBe('wt-a')
    expect(got.settings).toEqual({ gameArgs: ['-quicktest'] })
    expect(got.requests.map((r) => r.root)).toContain(treeA)
    expect(got.requests[0]!.source).toBe('flag')
  })

  test('a configured instance is found case-insensitively, like a profile', () => {
    const profile: ProfileConfig = { instances: { 'wt-a': { settings: { memory: '4g' } } } }
    expect(select({ instance: 'WT-A' }, profile).settings).toEqual({ memory: '4g' })
  })

  test('an --instance naming a prototype member finds no config entry', () => {
    const profile: ProfileConfig = { instances: { 'wt-a': {} } }
    for (const name of ['toString', 'constructor', 'valueOf']) {
      const got = select({ instance: name }, profile)
      expect(got.name).toBe(name)
      expect(got.settings).toBeUndefined()
      expect(got.requests).toEqual([])
    }
  })

  test('an --instance with no config entry is a valid ad-hoc instance', () => {
    const profile: ProfileConfig = { instances: { 'wt-a': {} } }
    const got = select({ instance: 'wt-z' }, profile)
    expect(got.name).toBe('wt-z')
    expect(got.settings).toBeUndefined()
  })
})
