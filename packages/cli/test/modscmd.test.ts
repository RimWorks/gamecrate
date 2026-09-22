import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { parseArgs } from '../src/cli/args'
import { modsAdd, modsRm, modsSync } from '../src/cli/mods'
import type { ModsContext } from '../src/cli/mods'
import { loadConfig } from '../src/config/load'
import { cloneDir } from '../src/mods/source'
import { downloadRoot } from '../src/mods/steamcmd'
import { Exit, GamecrateError } from '../src/types'
import type { GameConfig, ParsedArgs, RootConfig } from '../src/types'
import { fixtureGame, pluginMap } from './fixture-plugin'

const temps: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

/** FIXTURE_DEFAULTS puts the manifest at About/About.txt, and the fixture codec is `key value`. */
function writeMod(dir: string, packageId: string): void {
  mkdirSync(join(dir, 'About'), { recursive: true })
  writeFileSync(join(dir, 'About', 'About.txt'), `packageId ${packageId}\nname ${packageId}\n`)
}

function git(dir: string, ...argv: string[]): void {
  execFileSync('git', argv, { cwd: dir, stdio: 'pipe' })
}

/** A repo with one mod per named subdir, committed and tagged v1. No network, no mocks. */
function modRepo(ids: string[]): { url: string; dir: string } {
  const dir = temp('gc-modrepo-')
  git(dir, 'init', '-b', 'main')
  // a throwaway repo must not inherit the global hooksPath, its commit-msg hook blocks on a ui.
  git(dir, 'config', 'core.hooksPath', '/dev/null')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'gamecrate test')
  for (const id of ids) writeMod(join(dir, id.split('.').pop() as string), id)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'mods')
  git(dir, 'tag', 'v1')
  return { url: `file://${dir}`, dir }
}

/** A repo with a mod at each named path, committed and tagged v1. */
function repoAt(dirs: Record<string, string>): { url: string; dir: string } {
  const dir = temp('gc-modrepo-')
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'core.hooksPath', '/dev/null')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'gamecrate test')
  for (const [at, id] of Object.entries(dirs)) writeMod(join(dir, at), id)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'mods')
  git(dir, 'tag', 'v1')
  return { url: `file://${dir}`, dir }
}

/** A repo whose only content is f.txt, tagged v1, then moved on. Enough for sync. */
function plainRepo(): { url: string; dir: string } {
  const dir = temp('gc-plain-')
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'core.hooksPath', '/dev/null')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'gamecrate test')
  writeFileSync(join(dir, 'f.txt'), 'one')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'one')
  git(dir, 'tag', 'v1')
  return { url: `file://${dir}`, dir }
}

const FAKE_STEAMCMD = fileURLToPath(new URL('./fixtures/fake-steamcmd.sh', import.meta.url))

/**
 * The fake steamcmd, wrapped so the test can count its runs and so every item it writes carries
 * a manifest the fixture plugin can read: the fake writes a real game's About.xml.
 */
function fakeSteamcmd(fail = ''): { path: string; runs: () => number } {
  const dir = temp('gc-steamcmd-')
  const log = join(dir, 'runs')
  const path = join(dir, 'steamcmd')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `echo run >> ${log}`,
      `FAKE_FAIL_IDS='${fail}' ${FAKE_STEAMCMD} "$@"`,
      'code=$?',
      'appid=""; ids=""; install=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "+workshop_download_item" ]; then appid="$2"; ids="$ids $3"; shift 3;',
      '  elif [ "$1" = "+force_install_dir" ]; then install="$2"; shift 2; else shift; fi',
      'done',
      'root="$install/steamapps/workshop/content/$appid"',
      'for id in $ids; do',
      '  [ -d "$root/$id" ] || continue',
      String.raw`  printf 'packageId a.item%s\nname a.item%s\n' "$id" "$id" > "$root/$id/About/About.txt"`,
      'done',
      'exit $code',
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
  return {
    path,
    runs: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').length : 0),
  }
}

/** Steam's answer for every id, so no test reaches the network. */
function steamSays(details: { id: string; timeUpdated: number; result?: number }[]): typeof fetch {
  const body = {
    response: {
      publishedfiledetails: details.map((one) => ({
        publishedfileid: one.id,
        result: one.result ?? 1,
        time_updated: one.timeUpdated,
      })),
    },
  }
  return (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
}

/** The .acf steamcmd writes beside the content root, listing what is installed. */
function writeAcf(ctx: ModsContext, items: Record<string, number>): void {
  const root = downloadRoot(ctx.config.dataRoot, ctx.config.games['atlas'] as GameConfig)
  const entries = Object.entries(items)
    .map(([id, at]) => `\t\t"${id}"\n\t\t{\n\t\t\t"timeupdated"\t\t"${at}"\n\t\t\t"manifest"\t\t"102505266"\n\t\t}`)
    .join('\n')
  mkdirSync(root, { recursive: true })
  // the acf sits one level above content/<appid>, wherever the pinned root is
  writeFileSync(
    join(dirname(dirname(root)), 'appworkshop_294100.acf'),
    `"AppWorkshop"\n{\n\t"WorkshopItemsInstalled"\n\t{\n${entries}\n\t}\n}\n`,
  )
}

interface CtxOptions {
  globalText?: string
  cwd?: string
  game?: Partial<GameConfig>
  steamcmd?: string
  fetch?: typeof fetch
}

function context(options: CtxOptions = {}): ModsContext {
  const home = temp('gc-home-')
  const globalPath = join(home, 'profiles.yml')
  if (options.globalText !== undefined) writeFileSync(globalPath, options.globalText)
  const config: RootConfig = {
    dataRoot: temp('gc-data-'),
    games: { atlas: { ...fixtureGame(), ...options.game } },
    ...(options.steamcmd === undefined ? {} : { steamcmd: { path: options.steamcmd } }),
  }
  return {
    config,
    plugins: pluginMap('atlas'),
    defaults: {},
    cwd: options.cwd ?? home,
    globalPath,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
}

function args(...argv: string[]): ParsedArgs {
  return parseArgs(argv, { env: {}, games: ['atlas'] })
}

function fails(run: Promise<number>): Promise<GamecrateError> {
  return run.then(
    () => {
      throw new Error('expected a refusal')
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(GamecrateError)
      return error as GamecrateError
    },
  )
}

function library(file: string, game?: string): Record<string, Record<string, unknown>> {
  const doc = parseYaml(readFileSync(file, 'utf8')) as Record<string, any>
  const bag = game === undefined ? doc : doc?.['games']?.[game]
  return (bag?.['library'] ?? {}) as Record<string, Record<string, unknown>>
}

describe('modsAdd', () => {
  test('a repo with three manifests writes three pins in one write', async () => {
    const remote = modRepo(['a.one', 'a.two', 'a.three'])
    const ctx = context()

    const code = await modsAdd(args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global'), ctx)

    expect(code).toBe(Exit.Ok)
    const pins = library(ctx.globalPath, 'atlas')
    expect(Object.keys(pins).sort()).toEqual(['a.one', 'a.three', 'a.two'])
    for (const [id, entry] of Object.entries(pins)) {
      expect(entry['git']).toBe(remote.url)
      expect(entry['tag']).toBe('v1')
      expect(entry['subdir']).toBe(id.split('.').pop())
    }
  })

  test('one id declared by two directories writes nothing, even with --force', async () => {
    // one pair spelled the same, one pair spelled differently: ids match case-blind everywhere
    // else in this codebase, so two spellings of one id are still one key in the library
    const remote = repoAt({ 'V14/Mod': 'a.one', 'V15/Mod': 'A.One', W1: 'a.three', W2: 'a.three', Two: 'a.two' })
    const ctx = context()

    const error = await fails(
      modsAdd(args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global'), ctx),
    )
    expect(error.code).toBe(Exit.Config)
    expect(error.message).toContain('2 mod id(s) are declared by more than one directory')
    expect(error.detail).toContain('a.one: V14/Mod, V15/Mod')
    expect(error.detail).toContain('a.three: W1, W2')
    expect(error.detail).toContain('--subdir')
    // the refusal is ahead of the write, so the global config is never created
    expect(existsSync(ctx.globalPath)).toBe(false)

    // --force is for overwriting an existing pin, never for picking one of two directories
    const forced = context()
    const again = await fails(
      modsAdd(args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global', '--force'), forced),
    )
    expect(again.code).toBe(Exit.Config)
    expect(existsSync(forced.globalPath)).toBe(false)
  })

  test('the same repo pins fine once --subdir names one of the two', async () => {
    const remote = repoAt({ 'V14/Mod': 'a.one', 'V15/Mod': 'A.One', Two: 'a.two' })
    const ctx = context()

    // the other side: only a real duplicate refuses, and the message names the way out
    const code = await modsAdd(
      args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--subdir', 'V15', '--global'),
      ctx,
    )

    expect(code).toBe(Exit.Ok)
    const pins = library(ctx.globalPath, 'atlas')
    expect(Object.keys(pins)).toEqual(['A.One'])
    expect(pins['A.One']!['subdir']).toBe('V15/Mod')
  })

  test('two directories declaring two different ids is not a duplicate', async () => {
    const remote = repoAt({ 'V14/Mod': 'a.one', 'V15/Mod': 'a.two' })
    const ctx = context()

    const code = await modsAdd(args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global'), ctx)

    expect(code).toBe(Exit.Ok)
    expect(Object.keys(library(ctx.globalPath, 'atlas')).sort()).toEqual(['a.one', 'a.two'])
  })

  test('one collision among three writes nothing', async () => {
    const remote = modRepo(['a.one', 'a.two', 'a.three'])
    const ctx = context({
      globalText: 'games:\n  atlas:\n    library:\n      a.two:\n        path: /old/two\n',
    })
    const before = readFileSync(ctx.globalPath, 'utf8')

    const error = await fails(modsAdd(args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global'), ctx))

    expect(error.code).toBe(Exit.Config)
    expect(error.message).toContain('1 mod id(s) are already pinned')
    expect(error.detail).toContain('a.two')
    expect(readFileSync(ctx.globalPath, 'utf8')).toBe(before)
  })

  test('every colliding id is named, and still nothing is written', async () => {
    const remote = modRepo(['a.one', 'a.two', 'a.three'])
    const ctx = context({
      globalText: [
        'games:',
        '  atlas:',
        '    library:',
        '      a.two:',
        '        path: /old/two',
        '      a.three:',
        '        path: /old/three',
        '',
      ].join('\n'),
    })
    const before = readFileSync(ctx.globalPath, 'utf8')

    const error = await fails(modsAdd(args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global'), ctx))

    expect(error.message).toContain('2 mod id(s)')
    expect(error.detail).toContain('a.two')
    expect(error.detail).toContain('a.three')
    expect(readFileSync(ctx.globalPath, 'utf8')).toBe(before)
  })

  test('--force replaces a colliding pin and drops its old key', async () => {
    const remote = modRepo(['a.one'])
    const ctx = context({
      globalText: 'games:\n  atlas:\n    library:\n      A.One:\n        path: /old/one\n',
    })

    const code = await modsAdd(
      args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global', '--force'),
      ctx,
    )

    expect(code).toBe(Exit.Ok)
    const pins = library(ctx.globalPath, 'atlas')
    expect(Object.keys(pins)).toEqual(['a.one'])
    expect(pins['a.one']).toEqual({ git: remote.url, tag: 'v1', subdir: 'one' })
  })

  test('--path stores an absolute path', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const ctx = context({ cwd: work })

    await modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--global'), ctx)

    expect(library(ctx.globalPath, 'atlas')['a.local']).toEqual({ path: join(work, 'mymod') })
  })

  test('a source with no parsable manifest exits Resolution, leaving no config behind', async () => {
    const work = temp('gc-work-')
    mkdirSync(join(work, 'empty'))
    const ctx = context({ cwd: work })

    const error = await fails(modsAdd(args('mods', 'add', 'atlas', '--path', './empty', '--global'), ctx))

    expect(error.code).toBe(Exit.Resolution)
    expect(existsSync(ctx.globalPath)).toBe(false)
  })

  test('--project refuses when the project file has no game:', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const project = join(work, '.gamecrate.yml')
    writeFileSync(project, 'profiles:\n  dev:\n    mods: []\n')
    const before = readFileSync(project, 'utf8')
    const ctx = context({ cwd: work })

    const error = await fails(modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--project'), ctx))

    expect(error.code).toBe(Exit.Config)
    expect(error.message).toContain('has no top-level game:')
    expect(readFileSync(project, 'utf8')).toBe(before)
  })

  test('--workshop downloads the item and pins it, with workshopRoot null', async () => {
    const ctx = context({ steamcmd: fakeSteamcmd().path })

    const code = await modsAdd(args('mods', 'add', 'atlas', '--workshop', '12345', '--global'), ctx)

    expect(code).toBe(Exit.Ok)
    expect(ctx.config.games['atlas']!.workshopRoot).toBeNull()
    // the recorded entry is the same one a workshopRoot read used to write
    expect(library(ctx.globalPath, 'atlas')['a.item12345']).toEqual({ workshop: 12345 })
    const root = downloadRoot(ctx.config.dataRoot, ctx.config.games['atlas'] as GameConfig)
    expect(existsSync(join(root, '12345'))).toBe(true)
  })

  test('a download steam refuses fails the add, naming the item and the reason', async () => {
    const ctx = context({ steamcmd: fakeSteamcmd('12345').path })

    const error = await fails(modsAdd(args('mods', 'add', 'atlas', '--workshop', '12345', '--global'), ctx))

    expect(error.code).toBe(Exit.Resolution)
    expect(error.message).toContain('12345')
    expect(error.message).toContain('Failure')
    expect(existsSync(ctx.globalPath)).toBe(false)
  })

  test('--project with no .gamecrate above cwd refuses rather than creating one', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const ctx = context({ cwd: work })

    const error = await fails(modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--project'), ctx))

    expect(error.code).toBe(Exit.Config)
    expect(error.message).toContain('no .gamecrate config in this directory or any parent')
    expect(existsSync(join(work, '.gamecrate.yml'))).toBe(false)
    expect(existsSync(ctx.globalPath)).toBe(false)
  })

  test('--project refuses when the project file names another game', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const project = join(work, '.gamecrate.yml')
    writeFileSync(project, 'game: other\n')
    const before = readFileSync(project, 'utf8')
    const ctx = context({ cwd: work })

    const error = await fails(modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--project'), ctx))

    expect(error.code).toBe(Exit.Config)
    expect(error.message).toContain('belongs to other')
    expect(readFileSync(project, 'utf8')).toBe(before)
  })

  test('--project pins into the file own single library', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const project = join(work, '.gamecrate.yml')
    writeFileSync(project, 'game: atlas\nprofiles:\n  dev:\n    mods: []\n')
    const ctx = context({ cwd: work })

    await modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--project'), ctx)

    expect(library(project)['a.local']).toEqual({ path: join(work, 'mymod') })
    expect(readFileSync(project, 'utf8')).toContain('dev:')
  })

  test('--subdir narrows the walk to one subtree', async () => {
    const remote = modRepo(['a.one', 'a.two'])
    const ctx = context()

    await modsAdd(
      args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--subdir', 'one', '--global'),
      ctx,
    )

    expect(Object.keys(library(ctx.globalPath, 'atlas'))).toEqual(['a.one'])
  })
})

describe('modsRm', () => {
  test('removes the named pins and leaves the others', async () => {
    const ctx = context({
      globalText: [
        'games:',
        '  atlas:',
        '    library:',
        '      a.one:',
        '        path: /one',
        '      a.two:',
        '        path: /two',
        '      a.three:',
        '        path: /three',
        '',
      ].join('\n'),
    })

    const code = await modsRm(args('mods', 'rm', 'atlas', 'a.one', 'a.three', '--global'), ctx)

    expect(code).toBe(Exit.Ok)
    expect(Object.keys(library(ctx.globalPath, 'atlas'))).toEqual(['a.two'])
  })

  test('an id that is not pinned is an error and the file is unchanged', async () => {
    const ctx = context({
      globalText: 'games:\n  atlas:\n    library:\n      a.one:\n        path: /one\n',
    })
    const before = readFileSync(ctx.globalPath, 'utf8')

    const error = await fails(modsRm(args('mods', 'rm', 'atlas', 'a.one', 'a.nope', '--global'), ctx))

    expect(error.code).toBe(Exit.Config)
    expect(error.detail).toContain('a.nope')
    expect(readFileSync(ctx.globalPath, 'utf8')).toBe(before)
  })

  test('removing the last pin drops the library key, so the next add is not a flow map', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const project = join(work, '.gamecrate.yml')
    writeFileSync(project, 'game: atlas\nprofiles:\n  dev:\n    mods: []\n')
    const ctx = context({ cwd: work })

    await modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--project'), ctx)
    await modsRm(args('mods', 'rm', 'atlas', 'a.local', '--project'), ctx)

    expect(readFileSync(project, 'utf8')).not.toContain('library')

    await modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--project'), ctx)

    expect(readFileSync(project, 'utf8')).not.toContain('library: {')
    expect(library(project)['a.local']).toEqual({ path: join(work, 'mymod') })
  })

  test('removing the last pin of a game leaves its other blocks alone', async () => {
    const ctx = context({
      globalText: [
        'games:',
        '  atlas:',
        '    library:',
        '      a.one:',
        '        path: /one',
        '    profiles:',
        '      dev:',
        '        mods: []',
        '',
      ].join('\n'),
    })

    await modsRm(args('mods', 'rm', 'atlas', 'a.one', '--global'), ctx)

    const text = readFileSync(ctx.globalPath, 'utf8')
    expect(text).not.toContain('library')
    expect(text).toContain('dev:')
  })

  test('add, rm, add on the global file stays block yaml', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const ctx = context({ cwd: work })

    await modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--global'), ctx)
    expect(readFileSync(ctx.globalPath, 'utf8')).toContain('\n  atlas:')

    // games was the file's only key, so the rm empties the root. a `{}` left there would make
    // the next write a one-line flow map, and every write after that compounds it.
    await modsRm(args('mods', 'rm', 'atlas', 'a.local', '--global'), ctx)
    expect(readFileSync(ctx.globalPath, 'utf8')).toBe('')

    await modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--global'), ctx)

    const text = readFileSync(ctx.globalPath, 'utf8')
    expect(text).not.toContain('{')
    expect(text).toContain('\n  atlas:')
    expect(library(ctx.globalPath, 'atlas')['a.local']).toEqual({ path: join(work, 'mymod') })
  })

  test('a config emptied by rm still loads, rather than throwing', async () => {
    const work = temp('gc-work-')
    writeMod(join(work, 'mymod'), 'a.local')
    const ctx = context({ cwd: work })
    await modsAdd(args('mods', 'add', 'atlas', '--path', './mymod', '--global'), ctx)
    await modsRm(args('mods', 'rm', 'atlas', 'a.local', '--global'), ctx)
    expect(readFileSync(ctx.globalPath, 'utf8')).toBe('')

    // an empty file has to mean the same as no file at all, or emptying one bricks it
    const loaded = await loadConfig(ctx.globalPath)

    expect(loaded.config.games).toEqual({})
  })

  test.each([
    ['a sequence root', '- a\n- b\n'],
    ['a bare scalar', 'hello\n'],
  ])('a config that is %s still throws, only an empty one loads', async (_name, text) => {
    const ctx = context({ globalText: text })

    await expect(loadConfig(ctx.globalPath)).rejects.toThrow(/config is invalid/)
  })

  test('the clone stays on disk afterwards', async () => {
    const remote = modRepo(['a.one'])
    const ctx = context()
    await modsAdd(args('mods', 'add', 'atlas', '--git', remote.url, '--tag', 'v1', '--global'), ctx)
    const dir = cloneDir(ctx.config.dataRoot, remote.url, { kind: 'tag', value: 'v1' })
    expect(existsSync(dir)).toBe(true)

    await modsRm(args('mods', 'rm', 'atlas', 'a.one', '--global'), ctx)

    expect(Object.keys(library(ctx.globalPath, 'atlas'))).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })
})

describe('modsSync', () => {
  test('clones a pin that has never been cloned', async () => {
    const remote = plainRepo()
    const ctx = context()
    ctx.config.games['atlas']!.library = { 'a.one': { git: remote.url, tag: 'v1' } }
    const dir = cloneDir(ctx.config.dataRoot, remote.url, { kind: 'tag', value: 'v1' })
    expect(existsSync(dir)).toBe(false)

    expect(await modsSync(args('mods', 'sync', 'atlas'), ctx)).toBe(Exit.Ok)

    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('one')
  })

  test('a tag pin is forced to the moved remote tag', async () => {
    const remote = plainRepo()
    const ctx = context()
    ctx.config.games['atlas']!.library = { 'a.one': { git: remote.url, tag: 'v1' } }
    await modsSync(args('mods', 'sync', 'atlas'), ctx)
    const dir = cloneDir(ctx.config.dataRoot, remote.url, { kind: 'tag', value: 'v1' })
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('one')

    writeFileSync(join(remote.dir, 'f.txt'), 'two')
    git(remote.dir, 'add', '-A')
    git(remote.dir, 'commit', '-m', 'two')
    git(remote.dir, 'tag', '-f', 'v1')

    await modsSync(args('mods', 'sync', 'atlas'), ctx)

    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('two')
  })

  test('one id syncs only that pin', async () => {
    const remote = plainRepo()
    const ctx = context()
    ctx.config.games['atlas']!.library = {
      'a.one': { git: remote.url, tag: 'v1' },
      'a.two': { git: 'file:///nowhere/at/all', tag: 'v1' },
    }

    expect(await modsSync(args('mods', 'sync', 'atlas', 'a.one'), ctx)).toBe(Exit.Ok)

    expect(existsSync(cloneDir(ctx.config.dataRoot, remote.url, { kind: 'tag', value: 'v1' }))).toBe(true)
  })

  test('every named id is synced, not just the first', async () => {
    const one = plainRepo()
    const two = plainRepo()
    const ctx = context()
    ctx.config.games['atlas']!.library = {
      'a.one': { git: one.url, tag: 'v1' },
      'a.two': { git: two.url, tag: 'v1' },
      'a.three': { path: '/three' },
    }

    expect(await modsSync(args('mods', 'sync', 'atlas', 'a.one', 'a.two'), ctx)).toBe(Exit.Ok)

    expect(existsSync(cloneDir(ctx.config.dataRoot, one.url, { kind: 'tag', value: 'v1' }))).toBe(true)
    expect(existsSync(cloneDir(ctx.config.dataRoot, two.url, { kind: 'tag', value: 'v1' }))).toBe(true)
  })

  test('one named id that is not git-pinned fails the whole sync', async () => {
    const one = plainRepo()
    const ctx = context()
    ctx.config.games['atlas']!.library = { 'a.one': { git: one.url, tag: 'v1' } }

    const error = await fails(modsSync(args('mods', 'sync', 'atlas', 'a.one', 'a.nope'), ctx))

    expect(error.code).toBe(Exit.Resolution)
    expect(error.detail).toContain('a.nope')
  })

  test('several workshop pins refresh in one steamcmd run', async () => {
    const fake = fakeSteamcmd()
    const ctx = context({
      steamcmd: fake.path,
      fetch: steamSays([
        { id: '11', timeUpdated: 20 },
        { id: '22', timeUpdated: 20 },
        { id: '33', timeUpdated: 20 },
      ]),
    })
    ctx.config.games['atlas']!.library = {
      'a.one': { workshop: 11 },
      'a.two': { workshop: 22 },
      'a.three': { workshop: 33 },
    }

    expect(await modsSync(args('mods', 'sync', 'atlas'), ctx)).toBe(Exit.Ok)

    const root = downloadRoot(ctx.config.dataRoot, ctx.config.games['atlas'] as GameConfig)
    for (const id of ['11', '22', '33']) expect(existsSync(join(root, id))).toBe(true)
    expect(fake.runs()).toBe(1)
  })

  test('a workshop pin steam says is unchanged never runs steamcmd', async () => {
    const fake = fakeSteamcmd()
    const ctx = context({ steamcmd: fake.path, fetch: steamSays([{ id: '11', timeUpdated: 20 }]) })
    ctx.config.games['atlas']!.library = { 'a.one': { workshop: 11 } }
    writeAcf(ctx, { '11': 20 })
    const root = downloadRoot(ctx.config.dataRoot, ctx.config.games['atlas'] as GameConfig)
    mkdirSync(join(root, '11'), { recursive: true })

    expect(await modsSync(args('mods', 'sync', 'atlas'), ctx)).toBe(Exit.Ok)

    expect(fake.runs()).toBe(0)
  })

  test('a pin steam refuses reads as unavailable, never as up to date', async () => {
    const fake = fakeSteamcmd()
    const ctx = context({
      steamcmd: fake.path,
      fetch: steamSays([{ id: '11', timeUpdated: 20, result: 9 }]),
    })
    ctx.config.games['atlas']!.library = { 'a.one': { workshop: 11 } }
    writeAcf(ctx, { '11': 20 })
    const root = downloadRoot(ctx.config.dataRoot, ctx.config.games['atlas'] as GameConfig)
    mkdirSync(join(root, '11'), { recursive: true })

    const real = process.stderr.write.bind(process.stderr)
    const lines: string[] = []
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      expect(await modsSync(args('mods', 'sync', 'atlas'), ctx)).toBe(Exit.Ok)
    } finally {
      process.stderr.write = real
    }

    const out = lines.join('')
    expect(out).toContain('a.one is unavailable at workshop item 11')
    expect(out).not.toContain('a.one is up to date')
    expect(fake.runs()).toBe(0)
  })

  test('a workshop pin steam says moved is downloaded again', async () => {
    const fake = fakeSteamcmd()
    const ctx = context({ steamcmd: fake.path, fetch: steamSays([{ id: '11', timeUpdated: 99 }]) })
    ctx.config.games['atlas']!.library = { 'a.one': { workshop: 11 } }
    writeAcf(ctx, { '11': 20 })
    const root = downloadRoot(ctx.config.dataRoot, ctx.config.games['atlas'] as GameConfig)
    mkdirSync(join(root, '11'), { recursive: true })

    expect(await modsSync(args('mods', 'sync', 'atlas'), ctx)).toBe(Exit.Ok)

    expect(fake.runs()).toBe(1)
  })

  test('an id that is neither git- nor workshop-pinned is a Resolution error', async () => {
    const ctx = context()
    ctx.config.games['atlas']!.library = { 'a.one': { path: '/one' } }

    const error = await fails(modsSync(args('mods', 'sync', 'atlas', 'a.one'), ctx))

    expect(error.code).toBe(Exit.Resolution)
  })
})
