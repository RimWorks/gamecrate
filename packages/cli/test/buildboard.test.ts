import { describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdioOptions } from 'node:child_process'
import type { LaunchPlan, ResolvedMod } from '../src/types'

const outcome = { code: 0, say: '' }
const realRun = { ...(await import('../src/docker/run')) }
const { spawn } = await import('node:child_process')

await mock.module('../src/docker/run', () => ({
  ...realRun,
  spawnArgv: (argv: string[], stdio: StdioOptions) => {
    if (argv[0] !== 'dotnet') return realRun.spawnArgv(argv, stdio)
    const script = `printf '%s\\n' "${outcome.say}"; exit ${outcome.code}`
    return spawn('/bin/sh', ['-c', script], { stdio })
  },
}))

const { buildLocalMods } = await import('../src/launch/prepare')

async function modDir(name: string, withProject: boolean): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'buildboard-')), name)
  await mkdir(dir, { recursive: true })
  if (withProject) await writeFile(join(dir, `${name}.csproj`), '<Project />')
  return dir
}

function mod(packageId: string, hostDir: string): ResolvedMod {
  return { packageId, hostDir, containerDir: `/mods/${packageId}`, kind: 'local', explicit: true, stale: true }
}

function planOf(mods: ResolvedMod[]): LaunchPlan {
  return { game: 'rimworld', mods } as unknown as LaunchPlan
}

interface Cell {
  id: string
  state: string
}

function hooks(): { plan: string[][]; cells: Cell[]; onPlan: (t: readonly { id: string }[]) => void; onCell: (id: string, patch: { state?: string }) => void } {
  const seen: string[][] = []
  const cells: Cell[] = []
  return {
    plan: seen,
    cells,
    onPlan: (tasks) => seen.push(tasks.map((task) => task.id)),
    onCell: (id, patch) => {
      if (patch.state !== undefined) cells.push({ id, state: patch.state })
    },
  }
}

describe('buildLocalMods hooks', () => {
  test('plans every buildable mod once, then reports each running and done', async () => {
    outcome.code = 0
    outcome.say = 'Build succeeded.'
    const a = mod('one.mod', await modDir('one', true))
    const b = mod('two.mod', await modDir('two', true))
    const h = hooks()

    await buildLocalMods(planOf([a, b]), 'always', undefined, h)

    expect(h.plan).toEqual([['one.mod', 'two.mod']])
    // lanes run at once, so only each mod's own running-then-done order is fixed
    expect(h.cells.filter((c) => c.id === 'one.mod')).toEqual([
      { id: 'one.mod', state: 'running' },
      { id: 'one.mod', state: 'done' },
    ])
    expect(h.cells.filter((c) => c.id === 'two.mod')).toEqual([
      { id: 'two.mod', state: 'running' },
      { id: 'two.mod', state: 'done' },
    ])
    expect(a.stale).toBe(false)
    expect(b.stale).toBe(false)
  })

  test('a mod with no project never reaches the plan', async () => {
    outcome.code = 0
    outcome.say = 'Build succeeded.'
    const a = mod('one.mod', await modDir('one', true))
    const b = mod('xml.mod', await modDir('xml', false))
    const h = hooks()

    await buildLocalMods(planOf([a, b]), 'always', undefined, h)

    expect(h.plan).toEqual([['one.mod']])
    expect(h.cells.map((cell) => cell.id)).toEqual(['one.mod', 'one.mod'])
  })

  test('a failure marks its own row failed and still builds the rest', async () => {
    outcome.code = 1
    outcome.say = 'error CS0103'
    const a = mod('one.mod', await modDir('one', true))
    const b = mod('two.mod', await modDir('two', true))
    const h = hooks()

    await expect(buildLocalMods(planOf([a, b]), 'always', undefined, h)).rejects.toThrow('dotnet build failed')

    expect(h.cells.filter((c) => c.id === 'one.mod')).toEqual([
      { id: 'one.mod', state: 'running' },
      { id: 'one.mod', state: 'failed' },
    ])
    expect(h.cells.filter((c) => c.id === 'two.mod')).toEqual([
      { id: 'two.mod', state: 'running' },
      { id: 'two.mod', state: 'failed' },
    ])
  })

  test('one lane keeps the old strict order, and a lane never runs a mod twice', async () => {
    outcome.code = 0
    outcome.say = 'Build succeeded.'
    const a = mod('one.mod', await modDir('one', true))
    const b = mod('two.mod', await modDir('two', true))
    const h = hooks()
    const plan = planOf([a, b])
    plan.buildConcurrency = 1

    await buildLocalMods(plan, 'always', undefined, h)

    expect(h.cells).toEqual([
      { id: 'one.mod', state: 'running' },
      { id: 'one.mod', state: 'done' },
      { id: 'two.mod', state: 'running' },
      { id: 'two.mod', state: 'done' },
    ])
  })

  test('nothing to build calls neither hook', async () => {
    const h = hooks()
    await buildLocalMods(planOf([mod('one.mod', await modDir('one', true))]), 'never', undefined, h)
    expect(h.plan).toEqual([])
    expect(h.cells).toEqual([])
  })
})
