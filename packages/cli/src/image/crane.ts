import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { capture } from '../docker/run'
import { Exit, GamecrateError } from '../types'

/** The debug tag, because the default one has no shell and the tar step needs one. */
export const CRANE_IMAGE = 'gcr.io/go-containerregistry/crane:debug'

// the same backoff steamcmd.ts uses. a 502 from a registry should not cost a re-download
const ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

/** Where `crane auth login` writes inside the container. HOME there may not be writable. */
const CONTAINER_CONFIG = '/tmp/gamecrate-docker'

const USER_VAR = 'GAMECRATE_REGISTRY_USER'
const PASSWORD_VAR = 'GAMECRATE_REGISTRY_PASSWORD'

/** Both set or neither. One of the two is a refusal, not a silent anonymous push. */
function registryCreds(): { user: string } | null {
  const user = process.env[USER_VAR] ?? ''
  const password = process.env[PASSWORD_VAR] ?? ''
  if (user !== '' && password !== '') return { user }
  if (user === '' && password === '') return null
  throw new GamecrateError(
    `only one of ${USER_VAR} and ${PASSWORD_VAR} is set`,
    Exit.Environment,
    'set both, or neither to fall back to the docker config',
  )
}

/** The host docker config dir, only when it holds a config.json. */
function dockerConfigDir(): string | undefined {
  const dir = process.env.DOCKER_CONFIG ?? join(process.env.HOME ?? '', '.docker')
  if (dir === '.docker' || !existsSync(join(dir, 'config.json'))) return undefined
  return dir
}

/**
 * The password rides an env var docker forwards by name, never an argument: a docker argv is
 * readable from the process list on a shared runner.
 */
function authArgs(): string[] {
  if (registryCreds() !== null) {
    return ['-e', PASSWORD_VAR, '-e', `DOCKER_CONFIG=${CONTAINER_CONFIG}`]
  }
  const dir = dockerConfigDir()
  if (dir === undefined) return []
  return ['-v', `${dir}:/dockercfg:ro`, '-e', 'DOCKER_CONFIG=/dockercfg']
}

/** What crane resolves a ref carrying no registry to. `crane auth login` normalizes this. */
const DOCKER_HUB = 'index.docker.io'

/**
 * The registry crane logs in to. A head is a hostname only with a '.' or ':' in it, or exactly
 * 'localhost'; anything else is a hub short name, and `myuser/x` would log in to a host `myuser`.
 */
function registryOf(ref: string): string {
  const slash = ref.indexOf('/')
  if (slash === -1) return DOCKER_HUB
  const head = ref.slice(0, slash)
  if (head === 'localhost' || head.includes('.') || head.includes(':')) return head
  return DOCKER_HUB
}

type AuthEntry = { auth?: string; identitytoken?: string } | null

type DockerConfig = {
  auths?: Record<string, AuthEntry>
  credsStore?: string
  credHelpers?: Record<string, string>
}

/** docker keys the hub as `https://index.docker.io/v1/`, so a bare host compare misses it. */
function keyHost(key: string): string {
  return key.replace(/^https?:\/\//, '').split('/')[0] ?? key
}

function forRegistry<T>(table: Record<string, T> | undefined, registry: string): T | undefined {
  for (const [key, value] of Object.entries(table ?? {})) {
    if (keyHost(key) === registry) return value
  }
  return undefined
}

/**
 * Runs before the first download. Only a helper covering the push target is a problem: its binary
 * is not in the crane container, so the push would go out anonymous for no visible reason.
 */
export function checkRegistryAuthEarly(ref: string): void {
  if (registryCreds() !== null) return
  const dir = dockerConfigDir()
  if (dir === undefined) return
  const path = join(dir, 'config.json')
  let parsed: DockerConfig
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as DockerConfig
  } catch {
    return
  }
  const registry = registryOf(ref)
  const entry = forRegistry(parsed.auths, registry)
  // docker leaves an empty `{}` beside a helper entry, so only a filled field counts
  if ((entry?.auth ?? entry?.identitytoken ?? '') !== '') return
  const helper = forRegistry(parsed.credHelpers, registry) ?? parsed.credsStore ?? ''
  throw new GamecrateError(
    `no registry credentials for ${registry}`,
    Exit.Environment,
    helper === ''
      ? `${path} has no auths entry for ${registry}. set ${USER_VAR} and ${PASSWORD_VAR}`
      : `${path} stores ${registry} credentials in a helper (${helper}) the crane container cannot run. set ${USER_VAR} and ${PASSWORD_VAR}`,
  )
}

/** --user maps the host owner onto the bind, or the tar comes back root-owned. */
function dockerRun(mounts: string[], script: string): string[] {
  return [
    'docker',
    'run',
    '--rm',
    '--user',
    `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    ...mounts.flatMap((m) => ['-v', m]),
    ...authArgs(),
    '--entrypoint',
    'sh',
    CRANE_IMAGE,
    '-c',
    script,
  ]
}

/** POSIX single-quoting, for the one place an argv becomes a shell script. */
function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Every crane call logs in through here, not just the push. A null ref touches no registry.
 * The password reaches crane on stdin, and the login chatter goes to stderr so stdout parses.
 */
function craneArgv(mounts: string[], ref: string | null, lines: string[][]): string[] {
  const creds = ref === null ? null : registryCreds()
  const login =
    creds === null
      ? []
      : ['crane', 'auth', 'login', registryOf(ref as string), '-u', creds.user, '--password-stdin']
  const script = [
    'set -e',
    ...(login.length === 0
      ? []
      : [`printf '%s' "$${PASSWORD_VAR}" | ${login.map(shq).join(' ')} >&2`]),
    ...lines.map((line) => line.map(shq).join(' ')),
  ].join('\n')
  return dockerRun(mounts, script)
}

async function runOnce(argv: string[], what: string): Promise<void> {
  const { code, stdout, stderr } = await capture(argv)
  if (code === 0) return
  throw new GamecrateError(`${what} failed`, Exit.Environment, `${stdout}\n${stderr}`.trim())
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
  /** The name the tar carries. crane refuses an append without one, and docker load reads it. */
  tag: string
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
  // named after the output, because a phase appends several cells into one layer directory
  const layer = `${opts.out}.layer.tar`
  // "/game" -> "game". tar paths are relative, and a leading slash would be stripped anyway
  const prefix = opts.gamePath.replace(/^\/+/, '')
  // the prefix comes from where the game is bound, not --transform: the crane image ships
  // busybox tar, which has no --transform
  const stage = `/stage/${prefix}`
  const tar =
    opts.include.length > 0
      ? ['tar', '-C', '/stage', '-cf', layer, ...opts.include.map((p) => `${prefix}/${p}`)]
      : [
          'tar',
          '-C',
          '/stage',
          `--exclude=${prefix}/steamapps`,
          `--exclude=${prefix}/lost+found`,
          '-cf',
          layer,
          prefix,
        ]
  const append = [
    'crane',
    'append',
    '--platform',
    opts.platform,
    ...(opts.base === null ? [] : ['-b', opts.base]),
    // required even with -o: crane exits with 'required flag(s) "new_tag" not set' without it
    '-t',
    opts.tag,
    '-f',
    layer,
    '-o',
    opts.out,
  ]
  // null, never opts.base: this touches no push target, and a login here would write the push
  // credentials into the base's registry and break the anonymous pull that follows
  const argv = craneArgv([`${opts.gameDir}:${stage}:ro`, `${outDir}:${outDir}`], null, [
    tar,
    append,
    ['rm', '-f', layer],
  ])
  await runOnce(argv, `crane append for ${opts.out}`)
}

/** The one call that retries. A 502 from a registry should not cost a two gigabyte download. */
export async function cranePush(tar: string, ref: string): Promise<void> {
  const dir = dirname(tar)
  checkRegistryAuthEarly(ref)
  const argv = craneArgv([`${dir}:${dir}:ro`], ref, [['crane', 'push', tar, ref]])
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
  await runOnce(craneArgv([], ref, [['crane', 'tag', ref, tag]]), `crane tag ${ref} ${tag}`)
}

export async function craneMutateLabels(ref: string, labels: Record<string, string>): Promise<void> {
  const args = ['crane', 'mutate', ref]
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
  args.push('-t', ref)
  await runOnce(craneArgv([], ref, [args]), `crane mutate ${ref}`)
}

/** null when the image or its config cannot be read. An empty record means no labels. */
export async function craneLabels(ref: string): Promise<Record<string, string> | null> {
  const { code, stdout } = await capture(craneArgv([], ref, [['crane', 'config', ref]]))
  if (code !== 0) return null
  try {
    const parsed = JSON.parse(stdout) as { config?: { Labels?: Record<string, string> | null } }
    return parsed.config?.Labels ?? {}
  } catch {
    return null
  }
}
