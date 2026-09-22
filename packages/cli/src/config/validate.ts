import { z } from 'zod'
import { suggest } from '../cli/args'
import { profileKey, resolveProfile } from './load'
import { NAME_PATTERN, RESERVED_NAMES, own } from '../types'
import type { GameConfig, Problem, RootConfig } from '../types'

type Bag = Record<string, unknown>

const MODES = ['headed', 'headless', 'screenshot'] as const

/** Marks a message as our hint payload. Zod's own messages never start with it. */
const HINTS = '\u0000gamecrate/hints:'

/**
 * Zod reports unrecognized keys as one issue with no room for a did-you-mean, so the message
 * carries a JSON hint per key, in the same order as the issue's `keys`.
 */
function obj<T extends z.ZodRawShape>(shape: T) {
  const known = Object.keys(shape)
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? HINTS + JSON.stringify(issue.keys.map((key) => suggest(key, known) ?? null))
        : 'expected an object',
  })
}

/** Never falls back to reading a Zod message as a hint: no payload means no suggestions. */
function hintsFor(message: string): (string | null)[] {
  if (!message.startsWith(HINTS)) return []
  try {
    return JSON.parse(message.slice(HINTS.length)) as (string | null)[]
  } catch {
    return []
  }
}

/** A key the discriminant next to it makes required. */
function requiredWhen(key: string, when: (v: Bag) => boolean) {
  return (ctx: { value: Bag; issues: z.core.$ZodRawIssue[] }): void => {
    if (!when(ctx.value) || ctx.value[key] !== undefined) return
    ctx.issues.push({ code: 'custom', message: `missing required key "${key}"`, path: [key], input: ctx.value })
  }
}

const str = z.string({ error: 'expected a string' })
const num = z.number({ error: 'expected a number' })
const bool = z.boolean({ error: 'expected a boolean' })
const strArray = z.array(z.string({ error: 'expected an array of strings' }), {
  error: 'expected an array of strings',
})
const strMap = z.record(z.string(), z.string({ error: 'expected an object of string values' }), {
  error: 'expected an object of string values',
})

function oneOf<T extends string>(values: readonly T[]) {
  return z.enum(values as unknown as [T, ...T[]], { error: `expected one of ${values.join(', ')}` })
}

const modeName = z.unknown().check((ctx) => {
  const value = ctx.value
  if (typeof value === 'string' && MODES.includes(value as (typeof MODES)[number])) return
  const hint = typeof value === 'string' ? suggest(value, MODES) : undefined
  ctx.issues.push({
    code: 'custom',
    message: `expected one of ${MODES.join(', ')}`,
    input: value,
    ...(hint === undefined ? {} : { params: { suggestion: `did you mean "${hint}"?` } }),
  })
})

const settings = obj({
  width: num.optional(),
  height: num.optional(),
  devMode: bool.optional(),
  runInBackground: bool.optional(),
  resetModsConfigOnCrash: bool.optional(),
  gpu: bool.optional(),
  audio: bool.optional(),
  input: bool.optional(),
  network: oneOf(['none', 'bridge', 'host']).optional(),
  display: oneOf(['x11', 'wayland']).optional(),
  memory: str.optional(),
  cpus: num.optional(),
  pidsLimit: num.optional(),
  prefsExtra: strMap.optional(),
  gameArgs: strArray.optional(),
  dockerArgs: strArray.optional(),
})

const dynamicModEntry = obj({
  match: str,
  first: strArray.optional(),
  sort: oneOf(['alpha', 'none']).optional(),
  minMatches: num.optional(),
})

const objectModEntry = obj({
  id: str,
  workshop: num.optional(),
  path: str.optional(),
  optional: bool.optional(),
})

/** A bare string, a `match` pattern, or a pinned entry; the shape picks itself. */
const modEntry = z.unknown().check((ctx) => {
  const value = ctx.value
  if (typeof value === 'string') {
    if (value.trim() === '') ctx.issues.push({ code: 'custom', message: 'mod entry is empty', input: value })
    return
  }
  if (!isObj(value)) {
    ctx.issues.push({ code: 'custom', message: 'expected a packageId string or an object', input: value })
    return
  }
  const schema = value['match'] !== undefined ? dynamicModEntry : objectModEntry
  const result = schema.safeParse(value)
  if (result.success) return
  for (const issue of result.error.issues) ctx.issues.push({ ...issue, input: value } as z.core.$ZodRawIssue)
})

const profile = obj({
  mods: z.array(modEntry, { error: 'expected an array' }).optional(),
  extends: str.optional(),
  exclude: strArray.optional(),
  includeBase: bool.optional(),
  autoDependencies: bool.optional(),
  settings: settings.optional(),
  instances: z
    .record(z.string(), obj({ worktree: str.optional(), settings: settings.optional() }), {
      error: 'expected an object',
    })
    .optional(),
  alias: str.optional(),
  aliases: strArray.optional(),
  description: str.optional(),
  detach: bool.optional(),
  replace: bool.optional(),
  build: oneOf(['auto', 'always', 'never']).optional(),
}).check((ctx) => {
  const v = ctx.value
  if (v.alias !== undefined && (v.extends !== undefined || v.mods !== undefined)) {
    ctx.issues.push({
      code: 'custom',
      message: 'an alias profile cannot also declare "mods" or "extends"',
      input: v,
    })
  }
})

const libraryEntry = obj({
  workshop: num.optional(),
  path: str.optional(),
  git: str.optional(),
  branch: str.optional(),
  tag: str.optional(),
  commit: str.optional(),
  subdir: str.optional(),
}).check((ctx) => {
  const v = ctx.value
  const push = (message: string, path?: string[]): void => {
    ctx.issues.push({ code: 'custom', message, input: v, ...(path === undefined ? {} : { path }) })
  }

  const sources = (['workshop', 'path', 'git'] as const).filter((k) => v[k] !== undefined)
  if (sources.length === 0) push('library entry needs a "workshop" id, a "path", or a "git" url')
  if (sources.length > 1) push(`library entry takes only one of ${sources.join(', ')}`)

  const refs = (['branch', 'tag', 'commit'] as const).filter((k) => v[k] !== undefined)
  if (refs.length > 1) push(`library entry takes only one of branch, tag or commit, got ${refs.join(', ')}`)

  if (v['git'] === undefined) {
    for (const key of [...refs, ...(v['subdir'] === undefined ? [] : ['subdir'])]) {
      push(`"${key}" needs a "git" url`, [key])
    }
  }

  const subdir = v['subdir']
  if (typeof subdir === 'string' && (subdir.startsWith('/') || subdir.split('/').includes('..'))) {
    push('"subdir" must be a relative path inside the repo, with no ".." segment', ['subdir'])
  }
})

const game = obj({
  gameFiles: obj({ source: oneOf(['mount', 'image']), host: str.optional(), container: str }).check(
    requiredWhen('host', (v) => v['source'] === 'mount'),
  ),
  dataDir: obj({
    container: str,
    mode: oneOf(['arg', 'env']),
    arg: str.optional(),
    env: strMap.optional(),
  }).check(
    requiredWhen('arg', (v) => v['mode'] === 'arg'),
    requiredWhen('env', (v) => v['mode'] === 'env'),
  ),
  modsDir: obj({ container: str, mask: strArray.optional() }),
  logFile: obj({ mode: oneOf(['arg', 'copy-out']), arg: str.optional(), from: str.optional() }).check(
    requiredWhen('arg', (v) => v['mode'] === 'arg'),
    requiredWhen('from', (v) => v['mode'] === 'copy-out'),
  ),
  image: obj({ ref: str, acquire: oneOf(['pull', 'build']), context: str.optional() }).check(
    requiredWhen('context', (v) => v['acquire'] === 'build'),
  ),
  executable: str,
  steamAppId: num,
  workshopRoot: z.union([z.string(), z.null()], { error: 'expected a string or null' }),
  scanRoots: z.array(obj({ path: str, maxDepth: num, exclude: strArray.optional() }), {
    error: 'expected an array',
  }),
  manifest: obj({ file: str }),
  modsConfig: obj({ file: str }),
  prefs: obj({ file: str }),
  saveExtensions: strArray,
  core: str,
  dlc: strArray,
  preCore: strArray.optional(),
  base: strArray.optional(),
  library: z
    .record(
      z.string(),
      libraryEntry,
      { error: 'expected an object' },
    )
    .optional(),
  modes: z.array(modeName, { error: 'expected a non-empty array' }).min(1, {
    error: 'expected a non-empty array',
  }),
  aliases: strMap.optional(),
  settings: settings.optional(),
  ignoresWmDelete: bool.optional(),
  profiles: z.record(z.string(), profile, { error: 'expected an object' }),
})

const root = obj({
  plugins: strArray.optional(),
  dataRoot: str,
  defaults: obj({ settings: settings.optional() }).optional(),
  steamcmd: obj({ path: str.optional() }).optional(),
  // Checked per game below, so the pointers stay rooted at each game's name.
  games: z.unknown(),
})

/**
 * Phase one checks shape, phase two checks cross-references. Every problem is
 * collected with a JSON Pointer; nothing throws on the first failure.
 */
export function validateConfig(cfg: unknown): { config: RootConfig; problems: Problem[] } {
  const problems: Problem[] = []
  if (!isObj(cfg)) {
    problems.push({ where: '', message: 'expected the config to be an object' })
    return { config: { dataRoot: '', games: {} }, problems }
  }

  collect(problems, '', root, cfg)

  const games = cfg['games']
  if (!isObj(games)) {
    problems.push({ where: '/games', message: 'missing required key "games", or it is not an object' })
    return { config: cfg as unknown as RootConfig, problems }
  }

  for (const [name, entry] of Object.entries(games)) {
    collect(problems, `/games/${esc(name)}`, game, entry)
  }
  crossReference(problems, games)
  return { config: cfg as unknown as RootConfig, problems }
}

function collect(problems: Problem[], prefix: string, schema: z.ZodType, value: unknown): void {
  const result = schema.safeParse(value)
  if (result.success) return

  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const hints = hintsFor(issue.message)
      issue.keys.forEach((key, i) => {
        const problem: Problem = {
          where: `${prefix}${pointer(issue.path)}/${esc(key)}`,
          message: `unknown key "${key}"`,
        }
        const hint = hints[i]
        if (hint != null) problem.suggestion = `did you mean "${hint}"?`
        problems.push(problem)
      })
      continue
    }

    const key = issue.path.at(-1)
    const missing = typeof key === 'string' && valueAt(value, issue.path) === undefined
    const problem: Problem = {
      where: `${prefix}${pointer(issue.path)}`,
      message: missing ? `missing required key "${key}"` : issue.message,
    }
    const hint = (issue as { params?: { suggestion?: string } }).params?.suggestion
    if (hint !== undefined) problem.suggestion = hint
    problems.push(problem)
  }
}

function pointer(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${esc(String(segment))}`).join('')
}

function valueAt(root_: unknown, path: readonly PropertyKey[]): unknown {
  let current = root_
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = own(current as Bag, String(segment))
  }
  return current
}

function crossReference(p: Problem[], games: Bag): void {
  // one map across every game: container names carry the game, so two games can collide too
  const containers = new Map<string, string>()
  for (const [gameName, game_] of Object.entries(games)) {
    const where = `/games/${esc(gameName)}`
    checkName(p, where, gameName, 'game')
    if (!isObj(game_)) continue
    const profiles = game_['profiles']
    if (!isObj(profiles)) continue

    for (const [name, prof] of Object.entries(profiles)) {
      const w = `${where}/profiles/${esc(name)}`
      checkName(p, w, name, 'profile')
      if (isObj(prof)) checkProfile(p, w, name, prof, profiles)
    }

    checkCollisions(p, where, gameName, profiles, containers)
  }
}

function checkProfile(p: Problem[], w: string, name: string, prof: Bag, profiles: Bag): void {
  const names = Object.keys(profiles)
  checkExtends(p, w, prof, profiles, names)
  checkAlias(p, w, name, prof, profiles, names)
  checkAliases(p, w, prof, names)
  checkInstances(p, w, prof)
}

function checkExtends(p: Problem[], w: string, prof: Bag, profiles: Bag, names: string[]): void {
  const parent = prof['extends']
  if (typeof parent !== 'string' || resolves(profiles, parent)) return
  const prob: Problem = { where: `${w}/extends`, message: `extends unknown profile "${parent}"` }
  const hint = suggest(parent, names)
  if (hint) prob.suggestion = `did you mean "${hint}"?`
  p.push(prob)
}

function checkAlias(p: Problem[], w: string, name: string, prof: Bag, profiles: Bag, names: string[]): void {
  const alias = prof['alias']
  if (typeof alias !== 'string') return
  if (!resolves(profiles, alias)) {
    const prob: Problem = { where: `${w}/alias`, message: `alias of unknown profile "${alias}"` }
    const hint = suggest(alias, [...names, 'modless'])
    if (hint) prob.suggestion = `did you mean "${hint}"?`
    p.push(prob)
  }
  if (alias.toLowerCase() === name.toLowerCase()) {
    p.push({ where: `${w}/alias`, message: 'a profile cannot alias itself' })
  }
}

/**
 * An alias is a name you can type, so it gets the checks a profile key gets, and it must not
 * shadow a real profile.
 */
function checkAliases(p: Problem[], w: string, prof: Bag, names: string[]): void {
  const aliases = prof['aliases']
  if (!Array.isArray(aliases)) return
  for (const [i, entry] of aliases.entries()) {
    if (typeof entry !== 'string') continue
    const at = `${w}/aliases/${i}`
    checkName(p, at, entry, 'profile alias')
    if (names.some((k) => k.toLowerCase() === entry.toLowerCase())) {
      p.push({ where: at, message: `alias "${entry}" is already a profile name` })
    }
  }
}

/** The name becomes a directory and a container name, so it gets the checks a profile does. */
function checkInstances(p: Problem[], w: string, prof: Bag): void {
  const instances = prof['instances']
  if (!isObj(instances)) return
  for (const instance of Object.keys(instances)) {
    checkName(p, `${w}/instances/${esc(instance)}`, instance, 'instance')
  }
}

/**
 * The same name a user types at runtime. `profileKey` lowercases and falls through to every
 * profile's `aliases`, and `resolveNamed` answers "modless" before it looks at all, so anything
 * stricter here rejects configs the launcher runs happily.
 */
function resolves(profiles: Bag, name: string): boolean {
  if (name.toLowerCase() === 'modless') return true
  return profileKey({ profiles } as unknown as GameConfig, name) !== undefined
}

/**
 * checkName sees one name at a time, so it cannot catch two names that fight. This walks a
 * game's whole name space and reports the second occurrence, which is the key to delete.
 *
 * The container check is here rather than in `containerName` because there is no separator to
 * switch to: NAME_PATTERN and docker allow the same `-._` set, so `dev--wt` is a legal profile
 * too. Refusing the config needs no migration and leaves existing container names valid.
 *
 * `containers` is keyed on the whole docker name and shared across games, because the game is
 * part of that name: `rim` + `world-dev` and `rim-world` + `dev` both make
 * `gamecrate-rim-world-dev`, which is two runs on one container, not a refusal.
 *
 * One gap stays: `derive()` in launch/instance.ts builds `<slug>-<hash6>` from a worktree path,
 * which no config can know, so a profile named exactly that still collides at runtime. Not
 * worth defending against.
 */
function checkCollisions(
  p: Problem[],
  where: string,
  gameName: string,
  profiles: Bag,
  containers: Map<string, string>,
): void {
  const names = new Map<string, string>()
  const aliasOwners = new Map<string, string>()
  const prefix = `${gameName.toLowerCase()}-`

  for (const [name, prof] of Object.entries(profiles)) {
    const w = `${where}/profiles/${esc(name)}`
    const lower = name.toLowerCase()

    const twin = names.get(lower)
    if (twin !== undefined) {
      p.push({
        where: w,
        message: `profile "${name}" differs from "${twin}" only in case, so both share one data directory`,
      })
      continue
    }
    names.set(lower, name)

    const clash = containers.get(prefix + lower)
    if (clash !== undefined) {
      p.push({ where: w, message: `container name collides with ${clash}` })
      continue
    }
    containers.set(prefix + lower, w)

    if (!isObj(prof)) continue
    checkAliasOwners(p, w, prof, name, aliasOwners)
    checkInstanceContainers(p, w, profiles, name, `${prefix}${lower}`, containers)
  }
}

function checkAliasOwners(p: Problem[], w: string, prof: Bag, name: string, owners: Map<string, string>): void {
  const aliases = prof['aliases']
  if (!Array.isArray(aliases)) return
  for (const [i, entry] of aliases.entries()) {
    if (typeof entry !== 'string') continue
    const owner = owners.get(entry.toLowerCase())
    if (owner !== undefined) {
      p.push({
        where: `${w}/aliases/${i}`,
        message: `alias "${entry}" is already declared by profile "${owner}"`,
      })
      continue
    }
    owners.set(entry.toLowerCase(), name)
  }
}

function checkInstanceContainers(
  p: Problem[],
  w: string,
  profiles: Bag,
  name: string,
  prefix: string,
  containers: Map<string, string>,
): void {
  const prof = profiles[name]
  if (!isObj(prof)) return
  const declared = prof['instances']
  for (const instance of instanceNames(profiles, name, prof)) {
    const container = `${prefix}-${instance.toLowerCase()}`
    // An inherited instance has no key of its own to point at, so blame the profile.
    const at = isObj(declared) && Object.hasOwn(declared, instance) ? `${w}/instances/${esc(instance)}` : w
    const first = containers.get(container)
    if (first !== undefined) {
      p.push({
        where: at,
        message: `instance "${instance}" makes a container name that collides with ${first}`,
      })
      continue
    }
    containers.set(container, at)
  }
}

/**
 * A child inherits its parent's `instances`, so the declared block is not the set of containers
 * the profile can run. `resolveProfile` is the same walk the launcher does, which is the point:
 * a second rule that walked the chain its own way is what put the hole here to begin with. It
 * throws on an unknown parent or an extends cycle, and both already fail elsewhere, so a throw
 * means fall back to what this profile declares.
 */
function instanceNames(profiles: Bag, name: string, prof: Bag): string[] {
  try {
    const resolved = resolveProfile({ profiles } as unknown as GameConfig, name).instances
    return isObj(resolved) ? Object.keys(resolved) : []
  } catch {
    const declared = prof['instances']
    return isObj(declared) ? Object.keys(declared) : []
  }
}

function checkName(p: Problem[], where: string, name: string, kind: string): void {
  // Case-insensitive: `canonicalProfile` lowercases, so `MODLESS` is just as reserved as `modless`.
  // NAME_PATTERN below still matches case-sensitively. Harmless, it accepts both cases, but the
  // two rules disagree about what a name is, and that disagreement is this bug class.
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    p.push({ where, message: `"${name}" is a reserved name and cannot be used as a ${kind} name` })
    return
  }
  if (!NAME_PATTERN.test(name)) {
    p.push({ where, message: `${kind} name "${name}" must match ${NAME_PATTERN.source}` })
  }
}

function esc(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

export function isObj(v: unknown): v is Bag {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
