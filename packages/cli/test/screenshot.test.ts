import { describe, expect, test, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdioOptions } from 'node:child_process'
import type { LaunchPlan } from '../src/types'

const shell = vi.hoisted(() => ({ bin: '', out: '', argv: [] as string[] }))

vi.mock('../src/docker/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/docker/run')>()
  const { spawn } = await import('node:child_process')
  return {
    ...real,
    // `docker exec <container> sh -c <script>` becomes a real /bin/sh whose PATH holds only
    // the fakes, so a binary the image does not ship is genuinely missing.
    spawnArgv: (argv: string[], stdio: StdioOptions) => {
      shell.argv = argv
      return spawn('/bin/sh', ['-c', argv[5] ?? ''], {
        stdio,
        env: { PATH: shell.bin, OUT_DIR: shell.out },
      })
    },
  }
})

const { captureScreenshot } = await import('../src/launch/prepare')

/** ImageMagick reads an xwd dump on stdin and writes the path it was given, nothing else. */
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
  // the container's /tmp/.X11-unix holds one socket; every other listing is the real ls.
  ls: `[ "$1" = /tmp/.X11-unix ] && { echo X99; exit 0; }
exec /usr/bin/ls "$@"
`,
  // import needs -display and -window root, and fails on an unreachable display, which is the
  // only case the xwd fallback exists for.
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

/** A tmpdir standing in for one container: fakes on PATH, and the run dir the png lands in. */
async function container(binaries: string[]): Promise<LaunchPlan> {
  const dir = await mkdtemp(join(tmpdir(), 'gamecrate-shot-'))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  for (const name of binaries) {
    const file = join(bin, name)
    await writeFile(file, `#!/bin/sh\n${FAKES[name]}`)
    await chmod(file, 0o755)
  }
  // PATH cannot reach /usr/bin, or the host's own imagemagick answers `command -v convert`.
  for (const real of ['head', 'tr', 'cat', 'basename', 'printf']) {
    await symlink(`/usr/bin/${real}`, join(bin, real))
  }
  shell.bin = bin
  shell.out = dir
  // captureScreenshot reads only these two fields off the plan.
  return { game: 'atlas', runDirHost: dir } as unknown as LaunchPlan
}

describe('the screenshot fallback', () => {
  test('falls back to convert, which is the only imagemagick on ubuntu 24.04', async () => {
    const plan = await container(['ls', 'import', 'xwd', 'convert'])

    const host = await captureScreenshot('gamecrate-atlas-modless', plan)

    expect(shell.argv.slice(0, 2)).toEqual(['docker', 'exec'])
    expect(shell.argv.slice(3, 5)).toEqual(['sh', '-c'])
    expect(host).toBe(join(plan.runDirHost, 'atlas.png'))
    expect(await readFile(host!, 'utf8')).toBe('im6 /logs/atlas.png')
  })

  test('an image with no imagemagick says so instead of dying on an empty binary name', async () => {
    const plan = await container(['ls', 'import', 'xwd'])
    const errs: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
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
