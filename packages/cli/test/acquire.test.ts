import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { GameConfig } from '../src/types'

const state = { present: false, argv: [] as string[][] }

const realRun = { ...(await import('../src/docker/run')) }
const realOutput = { ...(await import('../src/cli/output')) }

await mock.module('../src/cli/output', () => ({ ...realOutput, forwardOutput: () => Promise.resolve() }))

await mock.module('../src/docker/run', () => ({
  ...realRun,
  capture: () =>
    Promise.resolve(
      state.present
        ? { code: 0, stdout: 'sha256:abc\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'No such image\n' },
    ),
  spawnArgv: (argv: string[]) => {
    state.argv.push(argv)
    return { stdout: null, stderr: null }
  },
  exited: () => Promise.resolve(0),
}))

const { acquireImage } = await import('../src/launch/prepare')

function config(image: GameConfig['image']): GameConfig {
  return { image } as GameConfig
}

describe('acquireImage', () => {
  beforeEach(() => {
    state.present = false
    state.argv = []
  })

  test('a context builds the ref from it', async () => {
    await acquireImage('atlas', config({ ref: 'atlas:1', context: '/ctx' }), 'missing')
    expect(state.argv).toEqual([['docker', 'build', '--tag', 'atlas:1', '/ctx']])
  })

  test('no context pulls the ref', async () => {
    await acquireImage('atlas', config({ ref: 'atlas:1' }), 'missing')
    expect(state.argv).toEqual([['docker', 'pull', 'atlas:1']])
  })

  test('a present built image is left alone unless --pull always', async () => {
    state.present = true
    await acquireImage('atlas', config({ ref: 'atlas:1', context: '/ctx' }), 'missing')
    expect(state.argv).toEqual([])
    await acquireImage('atlas', config({ ref: 'atlas:1', context: '/ctx' }), 'always')
    expect(state.argv).toEqual([['docker', 'build', '--tag', 'atlas:1', '/ctx']])
  })
})
