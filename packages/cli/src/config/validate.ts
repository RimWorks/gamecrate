import { z } from 'zod'
import { suggest } from '../cli/args'
import { profileKey, resolveProfile } from './load'
import { NAME_PATTERN, RESERVED_NAMES, own } from '../types'
import type { GameConfig, Problem, RootConfig } from '../types'

type Bag = Record<string, unknown>

const MODES = ['headed', 'headless', 'screenshot'] as const

const HINTS = '\u0000gamecrate/hints:'

function obj<T extends z.ZodRawShape>(shape: T) {
  const known = Object.keys(shape)
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? HINTS + JSON.stringify(issue.keys.map((key) => suggest(key, known) ?? null))
        : 'expected an object',
  })
}

const REMOVED_KEYS: Record<string, { message: string; suggestion: string }> = {
  '/image/acquire': {
    message: 'the key "acquire" was removed, and "context" decides now',
    suggestion: 'delete this line: an image with a "context" is built, one without it is pulled',
  },
}

function hintsFor(message: string): (string | null)[] {
  if (!message.startsWith(HINTS)) return []
  try {
    return JSON.parse(message.slice(HINTS.length)) as (string | null)[]
  } catch {
    return []
  }
}

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
  width: num.describe('Window width in pixels. `--resolution` overrides it.').optional(),
  height: num.describe('Window height in pixels. `--resolution` overrides it.').optional(),
  devMode: bool.describe("Writes the game's own developer-mode preference.").optional(),
  runInBackground: bool.describe("Writes the game's own run-in-background preference.").optional(),
  resetModsConfigOnCrash: bool
    .describe('Forced to `false` when written, whatever you set.')
    .optional(),
  gpu: bool
    .describe(
      'Passes the card in. NVIDIA needs `/etc/cdi/nvidia.yaml`, AMD and Intel use `/dev/dri`, and a host with neither renders in software.',
    )
    .optional(),
  audio: bool.describe('Mounts the host audio sockets.').optional(),
  input: bool.describe('Mounts `/dev/input`.').optional(),
  network: oneOf(['none', 'bridge', 'host']).describe('The container network mode.').optional(),
  display: oneOf(['x11', 'wayland'])
    .describe('Only `x11` lets gamecrate retitle and close the window.')
    .optional(),
  memory: str.describe('Container memory limit.').optional(),
  cpus: num.describe('Container CPU limit.').optional(),
  pidsLimit: num.describe('Container process limit.').optional(),
  prefsExtra: strMap.describe('Written into the prefs file verbatim.').optional(),
  gameArgs: strArray
    .describe('Appended to the game command line. Concatenates across layers.')
    .optional(),
  dockerArgs: strArray.describe('Appended to `docker run`. Concatenates across layers.').optional(),
})

const dynamicModEntry = obj({
  match: str.describe('A glob over every indexed `packageId`.'),
  first: strArray.describe('`packageIds` to load ahead of the rest of the match.').optional(),
  sort: oneOf(['alpha', 'none']).describe('How the rest of the match is ordered.').optional(),
  minMatches: num.describe('Fails the launch when the match lands below this count.').optional(),
})

const modSettingsFile = obj({
  file: str.describe("Path relative to the game's `modSettingsDir`. Climbing out of it fails with exit `3`."),
  class: str.describe('The type the engine writes on the settings block.'),
  values: z
    .record(z.string(), z.unknown())
    .describe('The keys to write. A key already in the file keeps its value unless `replace` names it.'),
  replace: strArray.describe('Keys in `values` rewritten on every launch, instead of merged.').optional(),
})

const objectModEntry = obj({
  id: str.describe('The `packageId` to load.'),
  workshop: num.describe('Pins the mod to this workshop item id.').optional(),
  path: str.describe('Pins the mod to this directory.').optional(),
  optional: bool.describe('Turns a miss into a warning instead of a failed launch.').optional(),
})

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
  mods: z
    .array(modEntry, { error: 'expected an array' })
    .describe('The mod set. Each entry is a `packageId` string, a mod entry object, or a match entry.')
    .optional(),
  extends: str.describe("Inherits a parent profile's mods, then appends its own.").optional(),
  exclude: strArray
    .describe("Globs dropping entries from the resolved list. A child's list adds to its parent's.")
    .optional(),
  includeBase: bool.describe("`false` leaves out the game's `base` list.").optional(),
  autoDependencies: bool
    .describe("Inserts each mod's declared dependencies ahead of it. On unless you set `false`.")
    .optional(),
  settings: settings.optional().describe('Settings for this profile, over the game block.'),
  instances: z
    .record(
      z.string(),
      obj({
        worktree: str
          .describe('Wins over every other worktree request when you name this instance.')
          .optional(),
        settings: settings.optional().describe('Settings for this instance, over the profile.'),
      }),
      {
        error: 'expected an object',
      },
    )
    .optional()
    .describe('Named sub-runs of this profile, each with its own saves, logs, lock, and container.'),
  modSettings: z
    .array(modSettingsFile, { error: 'expected a list of mod settings files' })
    .optional()
    .describe('Mod settings files written before launch.'),
  alias: str
    .describe('Marks this profile as another name for an existing one. It cannot also set `mods` or `extends`.')
    .optional(),
  aliases: strArray
    .describe('Extra names this profile answers to. Every name shares one data directory.')
    .optional(),
  description: str.describe('A one-line note for `gamecrate list`. Never read by the launcher.').optional(),
  gameVersion: str
    .describe("A tag on the game's own image repository, so `1.6` means `<repo>:1.6`. Reads the game out of the image.")
    .optional(),
  image: str
    .describe('A whole image reference, used verbatim. It beats `gameVersion`, and `--image` beats both.')
    .optional(),
  windowTitle: str.describe('The caption the window takes, instead of `<game> <profile>`. X11 only.').optional(),
  windowIcon: str
    .describe('An icon path relative to the config file it appears in, read by ImageMagick. X11 only.')
    .optional(),
  detach: bool.describe('Stands in for `--detach`. `--no-detach` overrides it.').optional(),
  replace: bool.describe('Stands in for `--replace`. `--no-replace` overrides it.').optional(),
  steam: bool.describe('Stands in for `--steam`. `--no-steam` overrides it.').optional(),
  build: oneOf(['auto', 'always', 'never'])
    .describe('Stands in for `--build` and `--no-build`.')
    .optional(),
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

const RELEASE_REPO = /^[\w.-]+\/[\w.-]+$/

const libraryEntry = obj({
  workshop: num.describe('A workshop item id to download.').optional(),
  path: str.describe('A directory on this machine.').optional(),
  git: str.describe('A git url to clone and build.').optional(),
  release: str.describe('`owner/repo`, whose GitHub releases carry a built copy of the mod.').optional(),
  asset: str.describe("A glob over a release's asset names. Defaults to `*.zip`.").optional(),
  branch: str.describe('The branch to check out. Needs `git`.').optional(),
  tag: str.describe('The tag to check out, or the release to pin.').optional(),
  commit: str.describe('The commit to check out. Needs `git`.').optional(),
  subdir: str.describe('The mod directory inside the repo. Relative, with no `..` segment.').optional(),
}).check((ctx) => {
  const v = ctx.value as Bag
  const push: Push = (message, path) => {
    ctx.issues.push({ code: 'custom', message, input: v, ...(path === undefined ? {} : { path }) })
  }

  checkOneSource(v, push)
  checkReleasePin(v, push)
  checkGitOnlyKeys(v, push)
  checkSubdir(v, push)
})

type Push = (message: string, path?: string[]) => void

function refKeys(v: Bag): string[] {
  return (['branch', 'tag', 'commit'] as const).filter((k) => v[k] !== undefined)
}

function checkOneSource(v: Bag, push: Push): void {
  const sources = (['workshop', 'path', 'git', 'release'] as const).filter((k) => v[k] !== undefined)
  if (sources.length === 0) {
    push('library entry needs a "workshop" id, a "path", a "git" url, or a "release" repository')
  }
  if (sources.length > 1) push(`library entry takes only one of ${sources.join(', ')}`)

  const refs = refKeys(v)
  if (refs.length > 1) push(`library entry takes only one of branch, tag or commit, got ${refs.join(', ')}`)
}

function checkReleasePin(v: Bag, push: Push): void {
  const release = v['release']
  if (typeof release === 'string' && !RELEASE_REPO.test(release)) {
    push(`"${release}" is not a GitHub repository; write it as owner/repo`, ['release'])
  }
  if (release !== undefined) {
    for (const key of refKeys(v).filter((name) => name !== 'tag')) {
      push(`"${key}" needs a "git" url; a "release" is pinned by "tag"`, [key])
    }
  }
  if (v['asset'] !== undefined && release === undefined) push('"asset" needs a "release" repository', ['asset'])
}

function checkGitOnlyKeys(v: Bag, push: Push): void {
  if (v['git'] !== undefined || v['release'] !== undefined) return
  for (const key of [...refKeys(v), ...(v['subdir'] === undefined ? [] : ['subdir'])]) {
    push(`"${key}" needs a "git" url or a "release" repository`, [key])
  }
}

function checkSubdir(v: Bag, push: Push): void {
  const subdir = v['subdir']
  if (typeof subdir === 'string' && (subdir.startsWith('/') || subdir.split('/').includes('..'))) {
    push('"subdir" must be a relative path inside the repo, with no ".." segment', ['subdir'])
  }
}

function repeats(entries: unknown[], key: string): { index: number; name: string }[] {
  const seen = new Set<string>()
  const found: { index: number; name: string }[] = []
  entries.forEach((entry, index) => {
    const name = (entry as Bag | null)?.[key]
    if (typeof name !== 'string') return
    if (seen.has(name)) found.push({ index, name })
    else seen.add(name)
  })
  return found
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const TAG_COMPONENT = /^\w[\w.-]*$/

function steamBuildRules(ctx: { value: Bag; issues: z.core.$ZodRawIssue[] }): void {
  const push = (message: string, path: PropertyKey[], suggestion?: string): void => {
    ctx.issues.push({
      code: 'custom',
      message,
      path,
      input: ctx.value,
      ...(suggestion === undefined ? {} : { params: { suggestion } }),
    })
  }
  const branches = ctx.value['branches']
  const variants = ctx.value['variants']

  if (Array.isArray(variants) && variants.length === 0) {
    push('steamBuild.variants cannot be empty', ['variants'])
  }
  if (Array.isArray(branches)) {
    if (branches.length === 0) push('steamBuild.branches cannot be empty', ['branches'])
    for (const dup of repeats(branches, 'name')) {
      push(`duplicate branch name "${dup.name}"`, ['branches', dup.index, 'name'])
    }
    branches.forEach((branch, index) => {
      const name = (branch as Bag | null)?.['name']
      if (typeof name === 'string' && !TAG_COMPONENT.test(name)) {
        push(`branch name "${name}" must match ${TAG_COMPONENT.source}`, ['branches', index, 'name'])
      }
      const tags = (branch as Bag | null)?.['tags']
      if (!Array.isArray(tags)) return
      tags.forEach((tag, at) => {
        if (typeof tag !== 'string' || TAG_COMPONENT.test(tag)) return
        push(`branch tag "${String(tag)}" must match ${TAG_COMPONENT.source}`, ['branches', index, 'tags', at])
      })
    })
  }
  if (!Array.isArray(variants)) return
  for (const dup of repeats(variants, 'name')) {
    push(`duplicate variant name "${dup.name}"`, ['variants', dup.index, 'name'])
  }
  variants.forEach((variant, index) => {
    const v = variant as Bag | null
    const base = v?.['base']
    if (base !== 'linux' && base !== 'windows') return
    const depot = v?.['depot'] ?? 'linux'
    if (depot === 'macos') {
      push(
        'a macos depot cannot be runnable',
        ['variants', index, 'base'],
        'set base to "none"; no macos container runtime exists',
      )
      return
    }
    if (base === depot) return
    push(
      `a ${describe(depot)} depot cannot run on the "${base}" base`,
      ['variants', index, 'base'],
      depot === 'windows'
        ? 'set base to "windows"; it is the only base with wine'
        : 'set base to "linux", or set depot to "windows" if the image should run under wine',
    )
  })
}

/** Exported so a config-less `steam build` gets the same refusals a config file would. */
export const steamBuildSchema = obj({
  branches: z
    .array(
      obj({
        name: str.describe('The steam branch name.'),
        password: bool.describe('The branch needs a beta password, asked for at build time.').optional(),
        tags: strArray.describe('Extra moving tags for this branch, beside the version and `latest` forms.').optional(),
        executable: z
          .record(str, str)
          .describe('Executable per variant name, when this branch ships a different one.')
          .optional(),
      }),
      {
        error: 'expected an array',
      },
    )
    .describe('The branches to download from. The first is the default. Concatenated, matched on `name`.'),
  variants: z
    .array(
      obj({
        name: str.describe('The variant name, which becomes part of the image tag.'),
        depot: oneOf(['linux', 'windows', 'macos']).describe('The platform depot to download. Defaults to `linux`.').optional(),
        base: oneOf(['linux', 'windows', 'none']).describe(
          'The runtime this build runs on. `windows` is the only base with wine, and `none` builds an image that cannot run.',
        ),
        include: strArray.describe('The paths to put in the image. Empty takes the whole depot.'),
        executable: str.describe('The binary for this variant, when it differs from the game default.').optional(),
      }),
      { error: 'expected an array' },
    )
    .describe('The images to build. The first is the default.'),
}).check(steamBuildRules)

const game = obj({
  gameFiles: obj({
    source: oneOf(['mount', 'image']).describe(
      '`mount` binds your own install read-only into a runtime image. `image` takes the game baked into the image, which `steam build` produces.',
    ),
    host: str.describe('Your game install on this machine. Required while `source` is `mount`.').optional(),
    container: str.describe('Where the game files appear inside the container.'),
  })
    .describe('Where the game files come from.')
    .check(requiredWhen('host', (v) => v['source'] === 'mount')),
  dataDir: obj({
    container: str.describe('Where the data directory appears inside the container.'),
    mode: oneOf(['arg', 'env']).describe('How the engine is told where its data is: a command-line `arg`, or `env` variables.'),
    arg: str.describe('The argument carrying the data path. Required while `mode` is `arg`.').optional(),
    env: strMap.describe('Environment variables carrying the data path. Required while `mode` is `env`.').optional(),
  })
    .describe('The directory the game writes saves, config, and logs into.')
    .check(
      requiredWhen('arg', (v) => v['mode'] === 'arg'),
      requiredWhen('env', (v) => v['mode'] === 'env'),
    ),
  modsDir: obj({
    container: str.describe('Where the staged mod tree is bind-mounted. Not necessarily under `dataDir`.'),
    mask: strArray.describe('Extra mod roots inside the image, hidden with a `tmpfs` so the game cannot load them.').optional(),
  }).describe('Where the staged mods land inside the container.'),
  logFile: obj({
    mode: oneOf(['arg', 'copy-out']).describe('`arg` hands the game a log path. `copy-out` reads a log the game chose.'),
    arg: str.describe('The argument carrying the log path. Required while `mode` is `arg`.').optional(),
    from: str.describe('The log path, relative to the data directory. Required while `mode` is `copy-out`.').optional(),
  })
    .describe("Where the game's log comes from.")
    .check(
      requiredWhen('arg', (v) => v['mode'] === 'arg'),
      requiredWhen('from', (v) => v['mode'] === 'copy-out'),
    ),
  image: obj({
    ref: str.describe('The image to run. A `mount` game that names none gets the published runtime base.'),
    context: str.describe('The docker build context. Naming one builds `ref`; leaving it out pulls `ref`.').optional(),
    updates: obj({
      check: bool.describe('Whether a launch looks for a newer game build. Default `true`.').optional(),
      everyHours: num.describe('How long one answer lasts. Default `6`. `0` checks every launch.').optional(),
    })
      .optional()
      .describe('The staleness check a launch runs against the image registry.'),
  }).describe('The image a launch runs. A `mount` game gets a runtime holding no game.'),
  executable: str.describe('The game binary, relative to the game files.'),
  managed: strArray.describe('The directories holding the assemblies `mods refs` points a csproj at.').optional(),
  steamAppId: num.describe("The game's steam app id, used for workshop downloads and `steam build`."),
  workshopRoot: z
    .union([z.string(), z.null()], { error: 'expected a string or null' })
    .describe("Your steam client's own workshop directory, or `null` when there is none to read."),
  scanRoots: z
    .array(
      obj({
        path: str.describe('The directory to walk.'),
        maxDepth: num.describe('How many levels below `path` a mod may sit.'),
        exclude: strArray.describe('Globs skipped during the walk.').optional(),
      }),
      {
        error: 'expected an array',
      },
    )
    .describe('The directories walked to index local mods. It ships empty, so nothing is indexed until you add one.'),
  manifest: obj({ file: str.describe('The manifest path inside a mod directory, parsed by the plugin.') }).describe(
    'Where a mod declares its `packageId`, name, and dependencies.',
  ),
  modsConfig: obj({ file: str.describe('Path relative to the data directory.') }).describe(
    "The game's own active-mod list, written before every launch.",
  ),
  prefs: obj({ file: str.describe('Path relative to the data directory.') }).describe(
    "The game's own preferences file, merged before every launch.",
  ),
  modSettingsDir: str
    .describe('Where mod settings files live, relative to the data directory. Absent means this game has none.')
    .optional(),
  version: obj({ file: str.describe('Path relative to the game files.') }).describe(
    'Where the engine writes its version string.',
  ),
  steamBuild: steamBuildSchema.describe('How `steam build` turns a steam depot into images.'),
  records: obj({
    dir: str.describe("Relative to the profile's config directory."),
    mods: strArray.describe('`packageIds` that write records there.'),
    enable: modSettingsFile
      .optional()
      .describe('Settings written before launch when one of `mods` is loaded, to turn record output on.'),
  })
    .optional()
    .describe('Where a mod writes the NDJSON records a run reads instead of raw container output.'),
  saveExtensions: strArray.describe('Filename suffixes that mean a save. `clean --all` counts them before it deletes.'),
  core: str.describe("The base game's `packageId`."),
  dlc: strArray.describe('The official expansions, loaded after `core`.'),
  steamlessMod: str
    .describe('The `packageId` loaded in place of the steam client when steam is off.')
    .optional(),
  preCore: strArray.describe('Mods that must load before the base game.').optional(),
  base: strArray.describe('Mods every profile of this game needs, loaded after the DLC.').optional(),
  library: z
    .record(z.string(), libraryEntry, { error: 'expected an object' })
    .optional()
    .describe('Where to get a mod from, keyed by `packageId`.'),
  modes: z
    .array(modeName, { error: 'expected a non-empty array' })
    .min(1, {
      error: 'expected a non-empty array',
    })
    .describe('The run modes this game supports: `headed`, `headless` or `screenshot`.'),
  aliases: strMap
    .describe('Maps a name you type to a `packageId`. It runs after an exact id match and before the short-name match.')
    .optional(),
  settings: settings.optional().describe('Settings for this game, over the top-level `defaults`.'),
  ignoresWmDelete: bool
    .describe('The engine claims WM_DELETE_WINDOW and drops it, so the titlebar X does nothing.')
    .optional(),
  x11Env: strMap
    .describe('Set on every launch that is not Wayland, for an engine that probes Wayland regardless.')
    .optional(),
  profiles: z
    .record(z.string(), profile, { error: 'expected an object' })
    .describe('The mod sets you can launch, keyed by profile name.'),
})

const root = obj({
  plugins: strArray
    .describe('Plugins to load before the rest of the file. A `~`, `.` or `/` prefix is a path; anything else is a package name.')
    .optional(),
  dataRoot: str.describe('Where saves, logs, locks, clones, and downloads go.'),
  defaults: obj({ settings: settings.optional().describe('Settings for every game.') })
    .optional()
    .describe('The bottom of the settings ladder, under the built-in values.'),
  buildConcurrency: num
    .describe('How many `dotnet build` runs go at once when a launch rebuilds stale mods. Default `3`.')
    .optional(),
  steamcmd: obj({
    path: str
      .describe('A steamcmd executable. One that is not fails with exit `5`, rather than falling back.')
      .optional(),
  })
    .optional()
    .describe('Which `steamcmd` downloads workshop items. Absent looks on `PATH`, then runs the `steamcmd/steamcmd` image.'),
  prune: obj({
    keepRuns: num
      .describe('How many run log directories a profile keeps. Every launch trims to this, and so does `prune`. Default `10`.')
      .optional(),
    maxAgeDays: num
      .describe('How old something has to be before `prune` deletes it. Default `30`.')
      .optional(),
    locks: bool
      .describe('Delete a lock file whose process and container are both gone. Default `true`.')
      .optional(),
    downloads: bool
      .describe('Delete workshop downloads nothing touched in `maxAgeDays`. They come back on the next launch that needs them. Default `true`.')
      .optional(),
    containers: bool
      .describe('Delete exited containers gamecrate started. Default `true`.')
      .optional(),
  })
    .optional()
    .describe('What `gamecrate prune` deletes. Every key has a flag that overrides it for one run.'),
  games: z.unknown(),
})

/** The schemas the reference-doc generator reads, keyed by the name it prints for each. */
export const SCHEMAS = {
  root,
  game,
  profile,
  settings,
  modSettingsFile,
  libraryEntry,
  modEntryObject: objectModEntry,
  matchEntry: dynamicModEntry,
} as const

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
        const at = `${pointer(issue.path)}/${esc(key)}`
        const removed = own(REMOVED_KEYS, at)
        const problem: Problem = {
          where: `${prefix}${at}`,
          message: removed?.message ?? `unknown key "${key}"`,
        }
        const hint = hints[i]
        if (removed) problem.suggestion = removed.suggestion
        else if (hint != null) problem.suggestion = `did you mean "${hint}"?`
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
  const containers = new Map<string, string>()
  for (const [gameName, game_] of Object.entries(games)) {
    const where = `/games/${esc(gameName)}`
    checkName(p, where, gameName, 'game')
    if (!isObj(game_)) continue
    checkVariantNames(p, where, game_)
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

function checkVariantNames(p: Problem[], where: string, game_: Bag): void {
  const steamBuild = game_['steamBuild']
  const variants = isObj(steamBuild) ? steamBuild['variants'] : undefined
  if (!Array.isArray(variants)) return
  variants.forEach((variant, index) => {
    const name = isObj(variant) ? variant['name'] : undefined
    if (typeof name !== 'string') return
    checkName(p, `${where}/steamBuild/variants/${index}/name`, name, 'variant')
  })
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

function checkInstances(p: Problem[], w: string, prof: Bag): void {
  const instances = prof['instances']
  if (!isObj(instances)) return
  for (const instance of Object.keys(instances)) {
    checkName(p, `${w}/instances/${esc(instance)}`, instance, 'instance')
  }
}

function resolves(profiles: Bag, name: string): boolean {
  if (name.toLowerCase() === 'modless') return true
  return profileKey({ profiles } as unknown as GameConfig, name) !== undefined
}

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
