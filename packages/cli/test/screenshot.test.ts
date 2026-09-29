import { describe, expect, mock, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { StdioOptions } from 'node:child_process'
import { capture } from '../src/docker/run'
import { CONTAINER_LOG_DIR } from '../src/docker/spec'
import { RUNTIME_BASE } from '../src/image/base'
import type { LaunchPlan } from '../src/types'

const shell = { bin: '', out: '', argv: [] as string[] }

const realRun = { ...(await import('../src/docker/run')) }
const { spawn } = await import('node:child_process')

await mock.module('../src/docker/run', () => {
  const real = realRun
  return {
    ...real,
    spawnArgv: (argv: string[], stdio: StdioOptions) => {
      shell.argv = argv
      if (shell.bin === '') return real.spawnArgv(argv, stdio)
      return spawn('/bin/sh', ['-c', argv[5] ?? ''], {
        stdio,
        env: { PATH: shell.bin, OUT_DIR: shell.out },
      })
    },
  }
})

const { captureScreenshot } = await import('../src/launch/prepare')

function imagemagick(tag: string): string {
  return `[ "$1" = "xwd:-" ] || { echo "$0: expected xwd:- and got '$1'" >&2; exit 2; }
case "$2" in /*) ;; *) echo "$0: expected an output path and got '$2'" >&2; exit 2 ;; esac
dump=$(cat)
[ "$dump" = XWDFAKE ] || { echo "$0: stdin was not an xwd dump" >&2; exit 2; }
# CONTAINER_LOG_DIR is bind-mounted to runDirHost, so the run dir is where the file lands.
printf '%s %s' "${tag}" "$2" > "$OUT_DIR/$(basename "$2")"
`
}

const FAKES: Record<string, string> = {
  ls: `[ "$1" = /tmp/.X11-unix ] && { echo X99; exit 0; }
exec /usr/bin/ls "$@"
`,
  import: `d=""; w=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -display) d="$2"; shift 2 ;;
    -window) w="$2"; shift 2 ;;
    *) out="$1"; shift ;;
  esac
done
[ -n "$d" ] && [ "$w" = root ] && [ -n "$out" ] || { echo "import: bad arguments" >&2; exit 2; }
echo "import: unable to open X server $d" >&2
exit 1
`,
  xwd: `d=""; root=0
while [ $# -gt 0 ]; do
  case "$1" in
    -root) root=1; shift ;;
    -display) d="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$root" = 1 ] && [ -n "$d" ] || { echo "xwd: bad arguments" >&2; exit 2; }
printf XWDFAKE
`,
  convert: imagemagick('im6'),
  magick: imagemagick('im7'),
}

async function container(binaries: string[]): Promise<LaunchPlan> {
  const dir = await mkdtemp(join(tmpdir(), 'gamecrate-shot-'))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  for (const name of binaries) {
    const file = join(bin, name)
    await writeFile(file, `#!/bin/sh\n${FAKES[name]}`)
    await chmod(file, 0o755)
  }
  for (const real of ['head', 'tr', 'cat', 'basename', 'printf']) {
    await symlink(`/usr/bin/${real}`, join(bin, real))
  }
  shell.bin = bin
  shell.out = dir
  return { game: 'atlas', runDirHost: dir } as unknown as LaunchPlan
}

describe('the screenshot fallback', () => {
  test('falls back to convert, which is the only imagemagick on ubuntu 24.04', async () => {
    const plan = await container(['ls', 'import', 'xwd', 'convert'])

    const host = await captureScreenshot('gamecrate-atlas-modless', plan)

    expect(shell.argv.slice(0, 2)).toEqual(['docker', 'exec'])
    expect(shell.argv.slice(3, 5)).toEqual(['sh', '-c'])
    expect(host).toMatch(/atlas-\d{8}T\d+Z\.png$/)
    expect(dirname(host!)).toBe(plan.runDirHost)
    expect(await readFile(host!, 'utf8')).toBe(`im6 /logs/${basename(host!)}`)
  })

  test('an image with no imagemagick says so instead of dying on an empty binary name', async () => {
    const plan = await container(['ls', 'import', 'xwd'])
    const errs: string[] = []
    const spy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errs.push(String(chunk))
      return true
    })

    try {
      expect(await captureScreenshot('gamecrate-atlas-modless', plan)).toBeNull()
    } finally {
      spy.mockRestore()
    }
    expect(errs.join('')).toContain('no imagemagick in the container')
  })
})

const DOCKER_OK = process.env['GAMECRATE_TEST_DOCKER'] === '1'

async function docker(argv: string[]): Promise<boolean> {
  return (await capture(['docker', ...argv])).code === 0
}

describe('a real xvfb display', () => {
  test.skipIf(!DOCKER_OK)('gives up a frame to a plain docker exec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gamecrate-shot-live-'))
    const name = `gamecrate-screenshot-test-${process.pid}`
    const started = await docker([
      'run',
      '--rm',
      '--detach',
      '--name',
      name,
      '--volume',
      `${dir}:${CONTAINER_LOG_DIR}`,
      RUNTIME_BASE.linux,
      'sh',
      '-c',
      'xvfb-run -a -s "-screen 0 320x240x24" sleep 120 & wait',
    ])
    if (!started) return

    try {
      for (let tries = 0; tries < 30; tries++) {
        if (await docker(['exec', name, 'sh', '-c', 'ls /tmp/.X11-unix/X*'])) break
        await new Promise((done) => setTimeout(done, 200))
      }
      shell.bin = ''
      const plan = { game: 'atlas', runDirHost: dir } as unknown as LaunchPlan

      const host = await captureScreenshot(name, plan)

      expect(dirname(host!)).toBe(dir)
      expect(basename(host!)).toMatch(/^atlas-\d{8}T\d+Z\.png$/)
      expect((await stat(host!)).size).toBeGreaterThan(0)
      expect((await readFile(host!)).subarray(1, 4).toString()).toBe('PNG')
    } finally {
      await docker(['rm', '--force', name])
    }
  }, 60_000)
})
