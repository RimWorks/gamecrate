import type { ImageLaunch } from '../docker/spec'
import type { GameConfig, ModeName, Problem } from '../types'
import { resolveProfile } from '../config/load'
import { imageDigest, imageLabel } from './prepare'

/** What an image says about itself. Every field is null for an image gamecrate did not build. */
export interface ImageFacts {
  present: boolean
  /** gamecrate.runtime: the base digest a steam build appended onto. */
  runtime: string | null
  launcher: string | null
  executable: string | null
  /** The cell that produced this image, and the steam build it carries. */
  branch: string | null
  variant: string | null
  buildid: string | null
}

const NO_IMAGE: ImageFacts = {
  present: false,
  runtime: null,
  launcher: null,
  executable: null,
  branch: null,
  variant: null,
  buildid: null,
}

export async function readImageFacts(ref: string): Promise<ImageFacts> {
  if (ref.trim() === '') return NO_IMAGE
  if ((await imageDigest(ref)) === null) return NO_IMAGE
  const [runtime, launcher, executable, branch, variant, buildid] = await Promise.all([
    imageLabel(ref, 'gamecrate.runtime'),
    imageLabel(ref, 'gamecrate.launcher'),
    imageLabel(ref, 'gamecrate.executable'),
    imageLabel(ref, 'gamecrate.branch'),
    imageLabel(ref, 'gamecrate.variant'),
    imageLabel(ref, 'steam.buildid'),
  ])
  return { present: true, runtime, launcher, executable, branch, variant, buildid }
}

/** The labels buildRunSpec reads. An unknown launcher is dropped, not passed through. */
export function imageLaunch(facts: ImageFacts): ImageLaunch {
  const launcher =
    facts.launcher === 'proton' || facts.launcher === 'direct' ? facts.launcher : undefined
  return {
    ...(launcher === undefined ? {} : { launcher }),
    ...(facts.executable === null ? {} : { executable: facts.executable }),
  }
}

export function imageProblem(input: {
  game: string
  ref: string
  mode: ModeName
  facts: ImageFacts
}): Problem | null {
  const { game, ref, mode, facts } = input
  const where = `/games/${game}/image/ref`
  const build = `gamecrate steam build ${game}`

  if (ref.trim() === '') {
    return {
      where,
      message: `${game} has no image.ref configured`,
      suggestion: `${build}, then set games.${game}.image.ref to the tag it prints`,
    }
  }
  if (!facts.present) {
    return {
      where,
      message: `image ${ref} is not present locally and could not be pulled`,
      suggestion: build,
    }
  }
  // A headed launch runs the binary straight, so an image from anywhere can work.
  if (mode === 'headed') return null
  if (facts.runtime === null) {
    return {
      where,
      message: `image ${ref} has no gamecrate.runtime label, so gamecrate did not build it and --mode ${mode} has no X server to use`,
      suggestion: `${build} rebuilds it on a runtime base`,
    }
  }
  return null
}

/**
 * Explorer detaches under wine, so the game's exit code never reaches gamecrate. A marker is the
 * only success signal a proton variant has, and without one a crash reads like a clean run.
 */
export function markerProblem(input: {
  game: string
  facts: ImageFacts
  marker: string | undefined
}): Problem | null {
  if (input.marker !== undefined) return null
  if (input.facts.launcher !== 'proton') return null
  return {
    where: `/games/${input.game}/image/ref`,
    message: `${input.game} runs under proton, which cannot report the game's exit code`,
    suggestion: 'pass --marker <text>: a log line is the only success signal this image has',
  }
}

/**
 * The flag wins, then the profile's own ref, then its version tag on the game's repository.
 * A profile that names neither leaves the configured ref alone.
 */
export function imageFor(game: GameConfig, profile: string, flag?: string): string | undefined {
  if (flag !== undefined) return flag
  const spec = resolveProfile(game, profile)
  if (spec.image !== undefined) return spec.image
  if (spec.gameVersion === undefined) return undefined
  return `${repoOf(game.image.ref)}:${spec.gameVersion}`
}

/** The ref without its tag. A colon after the last slash is a tag; before it, a registry port. */
export function repoOf(ref: string): string {
  const colon = ref.lastIndexOf(':')
  return colon === -1 || ref.includes('/', colon) ? ref : ref.slice(0, colon)
}

/**
 * `--image <ref>` launches one gamecrate-built image. The game lives inside such an image, so
 * the host mount goes with it: a bind over /game would shadow what the image carries.
 */
export function withImageOverride(game: GameConfig, ref?: string): GameConfig {
  if (ref === undefined) return game
  return {
    ...game,
    image: { ...game.image, ref, acquire: 'pull' },
    gameFiles: { ...game.gameFiles, source: 'image' },
  }
}

