import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { status } from '../cli/output'
import { capture } from '../docker/run'
import { imageDigest } from '../launch/prepare'
import { cacheDir } from '../mods/modindex'
import { GamecrateError, Exit } from '../types'
import type { GameConfig } from '../types'

export interface ManagedRefs {
  /** Holds the .dll files. Reproducible for one image id. */
  dir: string
  /** Stays pointed at the newest extraction for this game, so a csproj can hardcode it. */
  link: string
  /** The image id the assemblies came out of. */
  digest: string
  /** Container path they were found at. */
  source: string
  count: number
}

function refsRoot(): string {
  return join(cacheDir(), 'refs')
}

export function refsLink(game: string): string {
  return join(refsRoot(), 'current', game)
}

const MARK = '@@gamecrate@@ '

/**
 * First declared directory holding a .dll wins. A bind mount carries the bytes because a cat
 * through stdout corrupts one and busybox tar has no --transform; see landmines.md.
 */
export function extractScript(candidates: string[], container: string): string {
  const quoted = candidates.map((c) => {
    const escaped = join(container, c).replaceAll("'", String.raw`'\''`)
    return `'${escaped}'`
  })
  return [
    `for d in ${quoted.join(' ')}; do`,
    '  set -- "$d"/*.dll',
    '  [ -f "$1" ] || continue',
    `  echo "${MARK}$d"`,
    '  cp "$@" /out/',
    '  exit 0',
    'done',
    'exit 3',
  ].join('\n')
}

/**
 * The managed assemblies for a game's image, extracted once per image id. Handing back a
 * directory keeps <Private>False</Private> the consumer's choice.
 */
export async function extractRefs(game: string, config: GameConfig): Promise<ManagedRefs> {
  const candidates = config.managed
  if (candidates === undefined || candidates.length === 0) {
    throw new GamecrateError(
      `the "${game}" plugin does not declare where its managed assemblies live`,
      Exit.Config,
      'add a "managed" list of container-relative directories to the plugin defaults',
    )
  }
  const ref = config.image.ref
  const digest = await imageDigest(ref)
  if (digest === null) {
    throw new GamecrateError(
      `${ref} is not present, so ${game} has no assemblies to extract`,
      Exit.Environment,
      `gamecrate steam build ${game}, or docker pull ${ref}`,
    )
  }

  const dir = join(refsRoot(), digest.replace(/[^A-Za-z0-9]/g, '-'))
  const link = refsLink(game)
  if (existsSync(dir)) {
    return { dir, link: await point(link, dir), digest, source: '(cached)', count: await dllCount(dir) }
  }

  const partial = `${dir}.partial`
  await rm(partial, { recursive: true, force: true })
  await mkdir(partial, { recursive: true })

  status(`extracting managed assemblies from ${ref}`)
  const { code, stdout, stderr } = await capture([
    'docker', 'run', '--rm',
    '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    '-v', `${partial}:/out`,
    '--entrypoint', 'sh',
    ref, '-c', extractScript(candidates, config.gameFiles.container),
  ])
  if (code !== 0) {
    await rm(partial, { recursive: true, force: true })
    const detail = code === 3 ? `looked in: ${candidates.join(', ')}` : stderr.trim()
    throw new GamecrateError(
      `no managed assemblies in ${ref}`,
      code === 3 ? Exit.Resolution : Exit.Environment,
      detail === '' ? undefined : detail,
    )
  }
  const source = stdout.includes(MARK) ? stdout.slice(stdout.indexOf(MARK) + MARK.length).trim() : candidates[0]!
  const count = await dllCount(partial)
  if (count === 0) {
    await rm(partial, { recursive: true, force: true })
    throw new GamecrateError(
      `${ref} reported assemblies at ${source} but none arrived`,
      Exit.Environment,
      'the copy ran inside the image; check /out was writable by the calling uid',
    )
  }
  await rename(partial, dir)
  return { dir, link: await point(link, dir), digest, source, count }
}

async function dllCount(dir: string): Promise<number> {
  const entries = await readdir(dir).catch(() => [])
  return entries.filter((name) => name.toLowerCase().endsWith('.dll')).length
}

/** Replaced rather than followed, so an old target never gets written through. */
async function point(link: string, target: string): Promise<string> {
  await mkdir(dirname(link), { recursive: true })
  await unlink(link).catch(() => undefined)
  await symlink(target, link, 'dir')
  return link
}
