import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, OutputSink } from '../src/channels'
import { useBaseSink } from '../src/channels'
import { PLUGIN_API_VERSION } from '../src/plugin'
import type { GamecrateError } from '../src/types'
import { Exit } from '../src/types'
import { FIXTURE_DEFAULTS } from './fixture-plugin'

const temps: string[] = []
const restore: (() => void)[] = []

afterEach(() => {
  while (restore.length > 0) (restore.pop() as () => void)()
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

function pluginSource(defaults: unknown = FIXTURE_DEFAULTS): string {
  return `export default {
  apiVersion: ${PLUGIN_API_VERSION},
  game: 'atlas',
  defaults: ${JSON.stringify(defaults)},
  parseManifest: (text) => {
    const found = /^packageId (.+)$/m.exec(text)
    if (!found) return null
    return {
      packageId: found[1].trim(),
      modDependencies: [], loadAfter: [], loadBefore: [],
      forceLoadAfter: [], forceLoadBefore: [], incompatibleWith: [],
    }
  },
  renderModsConfig: () => '',
  mergePrefs: () => '',
  windowedPrefs: {},
  parseVersion: () => null,
}
`
}

/** Collects what the CLI writes, so a test reads output without a subprocess. */
function captured(): { text: () => string; data: () => string } {
  const seen: { channel: Channel; chunk: string }[] = []
  const sink: OutputSink = {
    write(channel, chunk) {
      seen.push({ channel, chunk: typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString() })
    },
    close() {},
  }
  const handle = useBaseSink(sink)
  restore.push(() => handle.close())
  return {
    text: () => seen.map((part) => part.chunk).join(''),
    data: () => seen.filter((p) => p.channel === 'data').map((p) => p.chunk).join(''),
  }
}

function bareWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gc-bare-'))
  temps.push(dir)

  const mods = join(dir, 'mods', 'Core')
  mkdirSync(join(mods, 'About'), { recursive: true })
  writeFileSync(join(mods, 'About', 'About.txt'), 'packageId Atlasco.Atlas\nname Core\n')

  const { gameFiles, ...rest } = FIXTURE_DEFAULTS
  const defaults = {
    ...rest,
    gameFiles: { source: gameFiles!.source, container: gameFiles!.container },
    scanRoots: [{ path: join(dir, 'mods'), maxDepth: 2 }],
  }
  const pkg = join(dir, 'node_modules', '@gamecrate', 'atlas')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@gamecrate/atlas', type: 'module', main: './plugin.js' }))
  writeFileSync(join(pkg, 'plugin.js'), pluginSource(defaults))

  mkdirSync(join(dir, 'cfg'), { recursive: true })
  const previous = { xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME, cwd: process.cwd() }
  process.env.XDG_CONFIG_HOME = join(dir, 'cfg')
  process.env.HOME = dir
  process.chdir(dir)
  restore.push(() => {
    process.chdir(previous.cwd)
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.xdg
    if (previous.home === undefined) delete process.env.HOME
    else process.env.HOME = previous.home
  })
  return dir
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gc-main-'))
  temps.push(dir)

  const pluginDir = join(dir, 'plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'gamecrate-atlas', type: 'module', main: './plugin.js' }),
  )
  writeFileSync(join(pluginDir, 'plugin.js'), pluginSource())

  const mods = join(dir, 'mods', 'Core')
  mkdirSync(join(mods, 'About'), { recursive: true })
  writeFileSync(join(mods, 'About', 'About.txt'), 'packageId Atlasco.Atlas\nname Core\n')

  mkdirSync(join(dir, 'cfg', 'gamecrate'), { recursive: true })
  writeFileSync(
    join(dir, 'cfg', 'gamecrate', 'config.json'),
    JSON.stringify({
      dataRoot: join(dir, 'data'),
      plugins: [pluginDir],
      games: {
        atlas: {
          image: { ref: 'atlas:latest' },
          scanRoots: [{ path: join(dir, 'mods'), maxDepth: 2 }],
          profiles: { dsd: { mods: [] } },
        },
      },
    }),
  )

  const previous = { xdg: process.env.XDG_CONFIG_HOME, cwd: process.cwd() }
  process.env.XDG_CONFIG_HOME = join(dir, 'cfg')
  process.chdir(dir)
  restore.push(() => {
    process.chdir(previous.cwd)
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.xdg
  })
  return dir
}

async function cli(argv: string[]): Promise<number> {
  const { main } = await import('../src/index')
  return await main(argv)
}

/** Usage errors leave `main` by throwing; only the entry point maps them to an exit code. */
async function thrown(argv: string[]): Promise<{ code: number; message: string } | undefined> {
  try {
    await cli(argv)
    return undefined
  } catch (error) {
    const fault = error as GamecrateError
    return { code: fault.code, message: fault.message }
  }
}

describe('main', () => {
  test('version answers before any config loads', async () => {
    const out = captured()
    expect(await cli(['version'])).toBe(0)
    expect(out.data()).toContain('gamecrate ')
  })

  test('help is exit 0 and names the subcommands', async () => {
    workspace()
    const out = captured()
    expect(await cli(['--help'])).toBe(0)
    const text = out.data()
    expect(text).toContain('run')
    expect(text).toContain('doctor')
  })

  test('an unknown subcommand throws usage, for the entry point to report', async () => {
    workspace()
    captured()
    expect(await thrown(['nonsense'])).toEqual({ code: Exit.Usage, message: 'nonsense is not a subcommand' })
  })

  test('a game name alone refuses and names its profiles', async () => {
    workspace()
    captured()
    const error = await thrown(['atlas'])
    expect(error).toEqual({ code: Exit.Usage, message: 'atlas is a game, not a subcommand' })
  })

  test('the entry point turns a thrown usage error into its exit code', async () => {
    workspace()
    const out = captured()
    const { reportFatal } = await import('../src/index')
    const error = await cli(['nonsense']).then(() => undefined, (e: unknown) => e)
    expect(reportFatal(error)).toBe(Exit.Usage)
    expect(out.text()).toContain('nonsense is not a subcommand')
  })

  test('list names the game and its profile', async () => {
    workspace()
    const out = captured()
    expect(await cli(['list'])).toBe(0)
    expect(out.data()).toContain('atlas')
    expect(out.data()).toContain('dsd')
  })

  test('an unknown profile is a resolution error that names the ones that exist', async () => {
    workspace()
    const out = captured()
    const code = await cli(['mods', 'nope'])
    expect(code).not.toBe(0)
    expect(out.text()).toContain('dsd')
  })

  test('completion prints a script for a shell it knows', async () => {
    workspace()
    const out = captured()
    expect(await cli(['completion', 'bash'])).toBe(0)
    expect(out.data().length).toBeGreaterThan(0)
  })

  test('mods lists what a profile resolves to', async () => {
    workspace()
    const out = captured()
    expect(await cli(['mods', 'dsd'])).toBe(0)
    expect(out.data()).toContain('Atlasco.Atlas')
  })

  test('run reaches the image check with no config file at all', async () => {
    bareWorkspace()
    const out = captured()
    const code = await cli(['run', '--game', 'atlas', '--image', 'ghcr.io/example/atlas:1', '--mode', 'headless', '--print-plan'])
    expect(code).toBe(Exit.Resolution)
    expect(out.text()).toContain('ghcr.io/example/atlas:1 is not present')
  })

  test('a missing plugin names the package and how to install it', async () => {
    bareWorkspace()
    captured()
    const error = await cli(['run', '--game', 'nosuchgame', '--image', 'x:1', '--mode', 'headless'])
      .then(() => undefined, (caught: unknown) => caught as GamecrateError)
    expect(error?.code).toBe(Exit.Environment)
    expect(error?.message).toBe('no plugin for game "nosuchgame"')
    expect(error?.detail).toContain('npm i -g @gamecrate/nosuchgame')
  })

  test('--help answers without hunting for a plugin', async () => {
    bareWorkspace()
    const out = captured()
    expect(await cli(['run', '--game', 'nosuchgame', '--help'])).toBe(0)
    expect(out.data()).toContain('gamecrate run')
  })

  test('doctor reports instead of dying when no plugin is installed', async () => {
    bareWorkspace()
    const out = captured()
    const error = await cli(['doctor', '--game', 'nosuchgame'])
      .then(() => undefined, (caught: unknown) => caught as GamecrateError)
    expect(error?.message ?? '').not.toContain('no plugin for game')
    expect(out.text()).not.toContain('no plugin for game')
  })

  test('steam keeps its own --plugin bootstrap, so --game loads nothing here', async () => {
    bareWorkspace()
    const out = captured()
    const error = await cli(['steam', 'build', '--game', 'nosuchgame', '--plugin', './nope'])
      .then(() => undefined, (caught: unknown) => caught as GamecrateError)
    expect(error?.message ?? '').not.toContain('no plugin for game')
    expect(out.text()).not.toContain('no plugin for game')
  })
})
