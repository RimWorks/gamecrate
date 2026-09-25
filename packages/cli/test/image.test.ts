import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { imageFor, imageLaunch, imageProblem, markerProblem, repoOf, withImageOverride } from '../src/launch/image'
import type { GameConfig } from '../src/types'
import type { ImageFacts } from '../src/launch/image'

const built: ImageFacts = {
  present: true,
  runtime: 'sha256:abc',
  launcher: 'direct',
  executable: './RimWorldLinux',
  branch: 'public',
  variant: 'linux',
  buildid: '23969874',
}
const proton: ImageFacts = { ...built, launcher: 'proton', executable: 'RimWorldWin64.exe' }
const blank = { runtime: null, launcher: null, executable: null, branch: null, variant: null, buildid: null }
const foreign: ImageFacts = { present: true, ...blank }
const missing: ImageFacts = { present: false, ...blank }

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

  /** The body of one function, so an offset inside it means what it looks like. */
  function body(name: string): string {
    const start = source.indexOf(`async function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  test('both checks follow acquireImage inside readyImage', () => {
    const ready = body('readyImage')
    const acquire = ready.indexOf('await acquireImage(')
    expect(acquire).toBeGreaterThan(-1)
    expect(ready.indexOf('imageProblem({', acquire)).toBeGreaterThan(acquire)
    expect(ready.indexOf('markerProblem({')).toBeGreaterThan(acquire)
    expect(ready).not.toContain('stageMods(')
  })

  test('execute readies the image before it stages anything', () => {
    const run = body('execute')
    const ready = run.indexOf('await readyImage(')
    const stage = run.indexOf('await stageMods(')
    expect(ready).toBeGreaterThan(-1)
    expect(stage).toBeGreaterThan(ready)
  })

  test('the refusals carry the exit codes the table gives them', () => {
    expect(source).toContain('throw new GamecrateError(problem.message, Exit.Environment')
    expect(source).toContain('throw new GamecrateError(needsMarker.message, Exit.Usage')
  })

  test('the runtime layer build is gone', () => {
    expect(source).not.toContain('ensureRuntimeLayer')
  })

  // a csproj that references one build while the container runs another is the disagreement
  // refs exists to stop, and build picking a different image is the same bug
  test('refs and build resolve the image the same way a launch does', () => {
    for (const name of ['refs', 'build']) {
      expect(body(name)).toContain('gameForImage(args, config, defaults, game)')
    }
    expect(source).toContain('withImageOverride(base, imageFor(base, launchProfile(args, defaults, base), args.image))')
  })

  test('refs keeps stdout to the path alone, so an MSBuild Exec captures nothing else', () => {
    const handler = body('refs')
    expect(handler.match(/process\.stdout\.write/g)).toHaveLength(2)
    expect(handler).toContain('process.stdout.write(`${found.dir}\\n`)')
    expect(handler).toContain('status(')
  })
})

describe('imageFor', () => {
  const game = {
    image: { ref: 'dsd-rimworld:latest', acquire: 'pull' as const },
    profiles: {
      plain: { mods: [] },
      pinned: { mods: [], gameVersion: '2.0' },
      literal: { mods: [], image: 'ghcr.io/me/other:sha-abc' },
      both: { mods: [], gameVersion: '2.0', image: 'ghcr.io/me/other:sha-abc' },
    },
  } as unknown as GameConfig

  test('a profile that names neither leaves the configured ref alone', () => {
    expect(imageFor(game, 'plain')).toBeUndefined()
  })

  test('a version tag resolves against the game repository', () => {
    expect(imageFor(game, 'pinned')).toBe('dsd-rimworld:2.0')
  })

  test('a whole ref is used verbatim', () => {
    expect(imageFor(game, 'literal')).toBe('ghcr.io/me/other:sha-abc')
  })

  test('image beats gameVersion, and the flag beats both', () => {
    expect(imageFor(game, 'both')).toBe('ghcr.io/me/other:sha-abc')
    expect(imageFor(game, 'both', 'local:1')).toBe('local:1')
    expect(imageFor(game, 'pinned', 'local:1')).toBe('local:1')
  })
})

describe('repoOf', () => {
  // a colon after the last slash is a tag; before it, a registry port
  test('a port is not a tag', () => {
    expect(repoOf('localhost:5000/me/atlas')).toBe('localhost:5000/me/atlas')
    expect(repoOf('localhost:5000/me/atlas:2.0')).toBe('localhost:5000/me/atlas')
  })

  test('a bare name with no tag stays whole', () => {
    expect(repoOf('dsd-rimworld')).toBe('dsd-rimworld')
    expect(repoOf('ghcr.io/me/atlas:latest')).toBe('ghcr.io/me/atlas')
  })
})

describe('withImageOverride', () => {
  const mounted = {
    image: { ref: 'a:1', acquire: 'build' as const, context: '/ctx' },
    gameFiles: { source: 'mount' as const, host: '/games/atlas', container: '/game' },
  } as unknown as GameConfig

  test('an override switches the game files to the image, so no bind shadows it', () => {
    const out = withImageOverride(mounted, 'b:2')
    expect(out.image).toEqual({ ref: 'b:2', acquire: 'pull', context: '/ctx' })
    expect(out.gameFiles.source).toBe('image')
  })

  test('no override changes nothing', () => {
    expect(withImageOverride(mounted, undefined)).toBe(mounted)
  })
})
