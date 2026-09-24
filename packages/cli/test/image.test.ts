import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { imageLaunch, imageProblem, markerProblem } from '../src/launch/image'
import type { ImageFacts } from '../src/launch/image'

const built: ImageFacts = {
  present: true,
  runtime: 'sha256:abc',
  launcher: 'direct',
  executable: './RimWorldLinux',
}
const proton: ImageFacts = { ...built, launcher: 'proton', executable: 'RimWorldWin64.exe' }
const foreign: ImageFacts = { present: true, runtime: null, launcher: null, executable: null }
const missing: ImageFacts = { present: false, runtime: null, launcher: null, executable: null }

describe('imageProblem', () => {
  test('an image somebody else built is refused offscreen, naming the command', () => {
    const problem = imageProblem({ game: 'rimworld', ref: 'x/y:1', mode: 'headless', facts: foreign })
    expect(problem?.message).toContain('gamecrate.runtime')
    expect(problem?.suggestion).toContain('gamecrate steam build rimworld')
  })

  test('the same image is fine headed', () => {
    expect(imageProblem({ game: 'rimworld', ref: 'x/y:1', mode: 'headed', facts: foreign })).toBeNull()
  })

  test('an absent image names the ref it tried', () => {
    const problem = imageProblem({ game: 'rimworld', ref: 'x/y:1', mode: 'headless', facts: missing })
    expect(problem?.message).toContain('x/y:1')
    expect(problem?.suggestion).toBe('gamecrate steam build rimworld')
  })

  test('an unconfigured ref says which key to set', () => {
    const problem = imageProblem({ game: 'rimworld', ref: '', mode: 'headless', facts: missing })
    expect(problem?.suggestion).toContain('games.rimworld.image.ref')
  })

  test('a gamecrate-built image passes in every mode', () => {
    for (const mode of ['headed', 'headless', 'screenshot'] as const) {
      expect(imageProblem({ game: 'rimworld', ref: 'x/y:1', mode, facts: built })).toBeNull()
    }
  })
})

describe('markerProblem', () => {
  test('a proton image with no marker is refused, naming --marker', () => {
    const problem = markerProblem({ game: 'rimworld', facts: proton, marker: undefined })
    expect(problem?.suggestion).toContain('--marker')
    expect(problem?.message).toContain('exit code')
  })

  test('a proton image with a marker runs', () => {
    expect(markerProblem({ game: 'rimworld', facts: proton, marker: 'ready' })).toBeNull()
  })

  test('a direct image with no marker still runs', () => {
    expect(markerProblem({ game: 'rimworld', facts: built, marker: undefined })).toBeNull()
  })
})

describe('imageLaunch', () => {
  test('an unlabelled image asks for nothing, so config decides', () => {
    expect(imageLaunch(foreign)).toEqual({})
  })

  test('a label gamecrate never writes is dropped rather than passed on', () => {
    expect(imageLaunch({ ...built, launcher: 'wibble' })).toEqual({ executable: './RimWorldLinux' })
  })
})

// execute() needs docker to reach, so the wiring is pinned by reading it: both checks have to
// sit between acquireImage and stageMods, or a bad image wipes the stage before it is caught.
describe('run wires the checks in before staging', () => {
  const source = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '../src/index.ts'),
    'utf8',
  )

  test('imageProblem and markerProblem run before stageMods', () => {
    const acquire = source.indexOf('await acquireImage(')
    const image = source.indexOf('imageProblem({')
    const marker = source.indexOf('markerProblem({')
    const stage = source.indexOf('await stageMods(')
    expect(acquire).toBeGreaterThan(-1)
    expect(image).toBeGreaterThan(acquire)
    expect(marker).toBeGreaterThan(acquire)
    expect(stage).toBeGreaterThan(image)
    expect(stage).toBeGreaterThan(marker)
  })

  test('the refusals carry the exit codes the table gives them', () => {
    expect(source).toContain('throw new GamecrateError(problem.message, Exit.Environment')
    expect(source).toContain('throw new GamecrateError(needsMarker.message, Exit.Usage')
  })

  test('the runtime layer build is gone', () => {
    expect(source).not.toContain('ensureRuntimeLayer')
  })
})
