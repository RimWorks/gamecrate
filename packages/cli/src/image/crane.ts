import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { status, waitNotice, warn } from '../cli/output'
import { capture, captureLive } from '../docker/run'
import { Exit, GamecrateError } from '../types'

/** The debug tag, because the default one has no shell and the tar step needs one. */
export const CRANE_IMAGE = 'gcr.io/go-containerregistry/crane:debug'

const ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

const CONTAINER_CONFIG = '/tmp/gamecrate-docker'

const USER_VAR = 'GAMECRATE_REGISTRY_USER'
const PASSWORD_VAR = 'GAMECRATE_REGISTRY_PASSWORD'

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

function dockerConfigDir(): string | undefined {
  const dir = process.env.DOCKER_CONFIG ?? join(process.env.HOME ?? '', '.docker')
  if (dir === '.docker' || !existsSync(join(dir, 'config.json'))) return undefined
  return dir
}

function authArgs(): string[] {
  if (registryCreds() !== null) {
    return ['-e', PASSWORD_VAR, '-e', `DOCKER_CONFIG=${CONTAINER_CONFIG}`]
  }
  const dir = dockerConfigDir()
  if (dir === undefined) return []
  return ['-v', `${dir}:/dockercfg:ro`, '-e', 'DOCKER_CONFIG=/dockercfg']
}

const DOCKER_HUB = 'index.docker.io'

function registryOf(ref: string): string {
  const slash = ref.indexOf('/')
  if (slash === -1) return DOCKER_HUB
  const head = ref.slice(0, slash)
  // crane reads `docker.io` off the hub's own `https://index.docker.io/v1/` key; registry-1 is not
  if (head === 'docker.io') return DOCKER_HUB
  if (head === 'localhost' || head.includes('.') || head.includes(':')) return head
  return DOCKER_HUB
}

type AuthEntry = { auth?: string; identitytoken?: string } | null

type DockerConfig = {
  auths?: Record<string, AuthEntry>
  credsStore?: string
  credHelpers?: Record<string, string>
}

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
  if (dir === undefined) {
    throw new GamecrateError(
      `no registry credentials for ${registryOf(ref)}`,
      Exit.Environment,
      `there is no docker config.json to read. set ${USER_VAR} and ${PASSWORD_VAR}`,
    )
  }
  const path = join(dir, 'config.json')
  let parsed: DockerConfig
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as DockerConfig
  } catch {
    return
  }
  const registry = registryOf(ref)
  const entry = forRegistry(parsed.auths, registry)
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

function shq(value: string): string {
  const escaped = value.replaceAll("'", String.raw`'\''`)
  return `'${escaped}'`
}

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

const HEARTBEAT_MS = 1000

function spawnFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === undefined || message.includes(code) ? message : `${message} (${code})`
}

async function live(argv: string[], what: string): Promise<{ code: number; text: string }> {
  const since = Date.now()
  let lastNotice = 0
  const timer = setInterval(() => {
    const waited = Date.now() - since
    const notice = waitNotice(waited, lastNotice)
    if (notice === undefined) return
    lastNotice = waited
    status(`${what} (${notice})`)
  }, HEARTBEAT_MS)
  try {
    return await captureLive(argv).catch((error: unknown) => ({ code: 127, text: spawnFailure(error) }))
  } finally {
    clearInterval(timer)
  }
}

async function runLive(argv: string[], what: string): Promise<void> {
  const { code, text } = await live(argv, what)
  if (code === 0) return
  throw new GamecrateError(`${what} failed`, Exit.Environment, text.trim())
}

function lastLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).findLast((l) => l !== '') ?? 'no output'
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
  const layer = `${opts.out}.layer.tar`
  // "/game" -> "game". tar paths are relative
  const prefix = opts.gamePath.replace(/^\/+/, '')
  // the crane image ships busybox tar, which has no --transform
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
  const argv = craneArgv([`${opts.gameDir}:${stage}:ro`, `${outDir}:${outDir}`], null, [
    tar,
    append,
    ['rm', '-f', layer],
  ])
  await runLive(argv, `crane append for ${opts.out}`)
}

/** The one call that retries. A 502 from a registry should not cost a two gigabyte download. */
export async function cranePush(tar: string, ref: string): Promise<void> {
  const dir = dirname(tar)
  checkRegistryAuthEarly(ref)
  const argv = craneArgv([`${dir}:${dir}:ro`], ref, [['crane', 'push', tar, ref]])
  let last = ''
  status(`pushing ${tar} to ${ref}`)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { code, text } = await live(argv, `crane push ${ref}`)
    if (code === 0) return
    last = text.trim()
    if (attempt + 1 < ATTEMPTS) {
      warn(`push attempt ${attempt + 1} of ${ATTEMPTS} failed: ${lastLine(last)}. retrying`)
      await sleep(RETRY_DELAY_MS)
    }
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

/**
 * The platform manifest a tag resolves to, so an image records the base it was built on rather
 * than the moving tag. Never the index digest: that is not what a runtime pulls.
 */
export async function craneDigest(ref: string, platform: string): Promise<string | null> {
  const argv = craneArgv([], ref, [['crane', 'digest', '--platform', platform, ref]])
  const { code, stdout } = await capture(argv)
  const digest = stdout.trim()
  return code === 0 && digest.startsWith('sha256:') ? digest : null
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
