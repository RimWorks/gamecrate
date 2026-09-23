import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { capture } from '../docker/run'
import { Exit, GamecrateError } from '../types'

/** The debug tag, because the default one has no shell and the tar step needs one. */
export const CRANE_IMAGE = 'gcr.io/go-containerregistry/crane:debug'

// the same backoff steamcmd.ts uses. a 502 from a registry should not cost a re-download
const ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

/**
 * A registry login, mounted rather than passed. Credentials never reach an argv, because a
 * docker argv is readable from the process list on a shared runner.
 */
function authArgs(): string[] {
  const dir = process.env.DOCKER_CONFIG ?? join(process.env.HOME ?? '', '.docker')
  if (dir === '.docker' || !existsSync(join(dir, 'config.json'))) return []
  return ['-v', `${dir}:/dockercfg:ro`, '-e', 'DOCKER_CONFIG=/dockercfg']
}

/** --user maps the host owner onto the bind, or the tar comes back root-owned. */
function dockerRun(mounts: string[], entrypoint: string | null, args: string[]): string[] {
  return [
    'docker',
    'run',
    '--rm',
    '--user',
    `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    ...mounts.flatMap((m) => ['-v', m]),
    ...authArgs(),
    ...(entrypoint === null ? [] : ['--entrypoint', entrypoint]),
    CRANE_IMAGE,
    ...args,
  ]
}

async function runOnce(argv: string[], what: string): Promise<void> {
  const { code, stdout, stderr } = await capture(argv)
  if (code === 0) return
  throw new GamecrateError(`${what} failed`, Exit.Environment, `${stdout}\n${stderr}`.trim())
}

/** POSIX single-quoting, for the one place an argv becomes a shell script. */
function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export async function craneAppend(opts: {
  gameDir: string
  /** Subpaths to include. Empty means the whole game. */
  include: string[]
  /** Where the game goes inside the image, e.g. /game. */
  gamePath: string
  /** null appends onto an empty base, which is what a reference image wants. */
  base: string | null
  platform: string
  out: string
}): Promise<void> {
  for (const p of opts.include) {
    if (!existsSync(join(opts.gameDir, p))) {
      throw new GamecrateError(
        `include path not found in the game dir: ${p}`,
        Exit.Resolution,
        `looked under ${opts.gameDir}. check the variant's include list`,
      )
    }
  }
  const outDir = dirname(opts.out)
  const layer = join(outDir, '.layer.tar')
  // "/game" -> "game". tar paths are relative, and a leading slash would be stripped anyway
  const prefix = opts.gamePath.replace(/^\/+/, '')
  const tar =
    opts.include.length > 0
      ? ['tar', '-C', opts.gameDir, `--transform=s,^,${prefix}/,`, '-cf', layer, ...opts.include]
      : [
          'tar',
          '-C',
          opts.gameDir,
          '--exclude=./steamapps',
          '--exclude=./lost+found',
          `--transform=s,^\\.,${prefix},`,
          '-cf',
          layer,
          '.',
        ]
  const append = [
    'crane',
    'append',
    '--platform',
    opts.platform,
    ...(opts.base === null ? [] : ['-b', opts.base]),
    '-f',
    layer,
    '-o',
    opts.out,
  ]
  const script = [
    'set -e',
    tar.map(shq).join(' '),
    append.map(shq).join(' '),
    `rm -f ${shq(layer)}`,
  ].join('\n')
  const argv = dockerRun(
    [`${opts.gameDir}:${opts.gameDir}:ro`, `${outDir}:${outDir}`],
    'sh',
    ['-c', script],
  )
  await runOnce(argv, `crane append for ${opts.out}`)
}

/** The one call that retries. A 502 from a registry should not cost a two gigabyte download. */
export async function cranePush(tar: string, ref: string): Promise<void> {
  const dir = dirname(tar)
  const argv = dockerRun([`${dir}:${dir}:ro`], null, ['push', tar, ref])
  let last = ''
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { code, stdout, stderr } = await capture(argv)
    if (code === 0) return
    last = `${stdout}\n${stderr}`.trim()
    if (attempt + 1 < ATTEMPTS) await sleep(RETRY_DELAY_MS)
  }
  throw new GamecrateError(`crane push failed for ${ref}`, Exit.Environment, last)
}

/** Runs after the push, never before. A moving tag only moves once the real tag is there. */
export async function craneTag(ref: string, tag: string): Promise<void> {
  await runOnce(dockerRun([], null, ['tag', ref, tag]), `crane tag ${ref} ${tag}`)
}

export async function craneMutateLabels(ref: string, labels: Record<string, string>): Promise<void> {
  const args = ['mutate', ref]
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
  args.push('-t', ref)
  await runOnce(dockerRun([], null, args), `crane mutate ${ref}`)
}

/** null when the image or its config cannot be read. An empty record means no labels. */
export async function craneLabels(ref: string): Promise<Record<string, string> | null> {
  const { code, stdout } = await capture(dockerRun([], null, ['config', ref]))
  if (code !== 0) return null
  try {
    const parsed = JSON.parse(stdout) as { config?: { Labels?: Record<string, string> | null } }
    return parsed.config?.Labels ?? {}
  } catch {
    return null
  }
}
