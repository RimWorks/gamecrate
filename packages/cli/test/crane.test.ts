import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { capture } = await import('../src/docker/run')
const {
  CRANE_IMAGE,
  checkRegistryAuthEarly,
  craneAppend,
  craneLabels,
  craneMutateLabels,
  cranePush,
  craneTag,
} = await import('../src/image/crane')
const { Exit } = await import('../src/types')
import type { GamecrateError } from '../src/types'

const FAKE = fileURLToPath(new URL('./fixtures/fake-crane.sh', import.meta.url))

let tmp = ''
const realPath = process.env.PATH

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gamecrate-crane-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

afterEach(() => {
  process.env.PATH = realPath
  delete process.env.FAKE_ARGV_FILE
  delete process.env.FAKE_CONFIG_JSON
  delete process.env.FAKE_FAIL_FIRST
  delete process.env.FAKE_EXIT
  delete process.env.DOCKER_CONFIG
  delete process.env.GAMECRATE_REGISTRY_USER
  delete process.env.GAMECRATE_REGISTRY_PASSWORD
})

/**
 * The fake on PATH under the name docker, plus the file it records into. DOCKER_CONFIG points
 * at an empty dir, so the run's own docker login never changes what these tests see.
 */
async function fakeDocker(): Promise<{ argvFile: string }> {
  const dir = await mkdtemp(join(tmp, 'bin-'))
  await copyFile(FAKE, join(dir, 'docker'))
  await chmod(join(dir, 'docker'), 0o755)
  const argvFile = join(dir, 'argv.txt')
  await writeFile(argvFile, '')
  process.env.FAKE_ARGV_FILE = argvFile
  process.env.PATH = dir
  process.env.DOCKER_CONFIG = await mkdtemp(join(tmp, 'dockercfg-'))
  return { argvFile }
}

/** The fixture fake behind a pause, so the contract check still runs after a slow docker. */
async function slowDocker(seconds: number): Promise<void> {
  const dir = await mkdtemp(join(tmp, 'slow-'))
  const path = join(dir, 'docker')
  // absolute: PATH is this dir alone, so sleep is not on it
  await writeFile(path, `#!/bin/sh\n/bin/sleep ${seconds}\nexec ${FAKE} "$@"\n`)
  await chmod(path, 0o755)
  process.env.PATH = dir
}

/** Writes a config.json into the DOCKER_CONFIG dir the current test is using. */
async function dockerConfig(body: unknown): Promise<string> {
  const dir = process.env.DOCKER_CONFIG as string
  await writeFile(join(dir, 'config.json'), JSON.stringify(body))
  return dir
}

/**
 * Everything the tool wrote to the terminal while fn ran, both streams. status() and warn() use
 * stderr, and a streamed child writes wherever captureLive sends it.
 */
async function onTerminal<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const chunks: string[] = []
  const write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  process.stdout.write = write
  process.stderr.write = write
  try {
    return { result: await fn(), text: chunks.join('') }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

/** Each recorded run, split into argv. The script inside one argv folds into the same array. */
async function runs(argvFile: string): Promise<string[][]> {
  const text = await readFile(argvFile, 'utf8')
  return text
    .split('@@RUN@@')
    .map((run) => run.trim())
    .filter((run) => run !== '')
    .map((run) => run.split(/\s+/))
}

describe('craneAppend', () => {
  test('the whole-game case carries both excludes and tars the staged prefix', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'linux-1.6.4871.tar')
    await craneAppend({
      gameDir,
      include: [],
      gamePath: '/game',
      base: 'ghcr.io/rimworks/gamecrate/runtime-base@sha256:abc',
      platform: 'linux/amd64',
      tag: 'ghcr.io/me/atlas:1.6.4871',
      out,
    })
    const script = await readFile(argvFile, 'utf8')
    expect(script).toContain('--exclude=game/steamapps')
    expect(script).toContain('--exclude=game/lost+found')
    expect(script).not.toContain('--transform')
    expect(script).toContain("'-C' '/stage'")
    expect(script).toContain('-b')
    expect(script).toContain('--platform')
    expect(script).toContain('linux/amd64')
    expect(script).toContain('-o')
    expect(script).toContain(out)
    expect(script).toContain("'-t' 'ghcr.io/me/atlas:1.6.4871'")
  })

  test('a base-less append still carries the tag crane requires', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'ref.tar')
    await craneAppend({
      gameDir,
      include: [],
      gamePath: '/game',
      base: null,
      platform: 'linux/amd64',
      tag: 'ghcr.io/me/atlas:1.6.4871-linux-ref',
      out,
    })
    expect(await readFile(argvFile, 'utf8')).toContain("'-t' 'ghcr.io/me/atlas:1.6.4871-linux-ref'")
  })

  test('an include list is prefixed by hand and carries no excludes', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    await mkdir(join(gameDir, 'Managed'), { recursive: true })
    await writeFile(join(gameDir, 'Version.txt'), '1.6.4871 rev598\n')
    await writeFile(join(gameDir, 'Player Log.txt'), '')
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'ref.tar')
    await craneAppend({
      gameDir,
      include: ['Managed', 'Version.txt', 'Player Log.txt'],
      gamePath: '/game',
      base: null,
      platform: 'linux/amd64',
      tag: 'ghcr.io/me/atlas:1.6.4871-linux-ref',
      out,
    })
    const script = await readFile(argvFile, 'utf8')
    expect(script).not.toContain('--transform')
    expect(script).toContain("'game/Player Log.txt'")
    expect(script).toContain("'game/Managed'")
    expect(script).not.toContain('--exclude')
    expect(script).not.toContain("'-b'")
  })

  test('a missing include path is a resolution error naming the path', async () => {
    await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'ref.tar')
    let thrown: GamecrateError | undefined
    try {
      await craneAppend({
        gameDir,
        include: ['Managed'],
        gamePath: '/game',
        base: null,
        platform: 'linux/amd64',
        tag: 'ghcr.io/me/atlas:1',
        out,
      })
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Resolution)
    expect(thrown?.message).toContain('Managed')
  })

  test('binds the game dir read-only and the output dir writable', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const outDir = await mkdtemp(join(tmp, 'layers-'))
    await craneAppend({
      gameDir,
      include: [],
      gamePath: '/game',
      base: null,
      platform: 'linux/amd64',
      tag: 'ghcr.io/me/atlas:1',
      out: join(outDir, 'x.tar'),
    })
    const [argv] = await runs(argvFile)
    expect(argv).toContain(`${gameDir}:/stage/game:ro`)
    expect(argv).toContain(`${outDir}:${outDir}`)
    expect(argv).toContain(CRANE_IMAGE)
    expect(argv![argv!.indexOf(CRANE_IMAGE) - 1]).toBe('sh')
  })

  test('two appends into one directory use two intermediate tars', async () => {
    const { argvFile } = await fakeDocker()
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const outDir = await mkdtemp(join(tmp, 'layers-'))
    const a = join(outDir, 'linux.tar')
    const b = join(outDir, 'windows.tar')
    for (const out of [a, b]) {
      await craneAppend({
        gameDir,
        include: [],
        gamePath: '/game',
        base: null,
        platform: 'linux/amd64',
        tag: 'ghcr.io/me/atlas:1',
        out,
      })
    }
    const script = await readFile(argvFile, 'utf8')
    expect(script).toContain(`${a}.layer.tar`)
    expect(script).toContain(`${b}.layer.tar`)
    expect(script).not.toContain(join(outDir, '.layer.tar'))
  })
})

describe('what the long calls say while they run', () => {
  test('an append writes the container output to the terminal and still keeps it', async () => {
    await fakeDocker()
    process.env.FAKE_FAIL_FIRST = '1'
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'x.tar')
    const { result, text } = await onTerminal(async (): Promise<GamecrateError | undefined> => {
      try {
        await craneAppend({
          gameDir,
          include: [],
          gamePath: '/game',
          base: null,
          platform: 'linux/amd64',
          tag: 'ghcr.io/me/atlas:1',
          out,
        })
        return undefined
      } catch (error) {
        return error as GamecrateError
      }
    })
    expect(text).toContain('fake: 502 from the registry')
    expect(result?.detail).toContain('fake: 502 from the registry')
  })

  test('a retrying push names the attempt and the registry complaint', async () => {
    const { argvFile } = await fakeDocker()
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'tok'
    process.env.FAKE_FAIL_FIRST = '1'
    const { text } = await onTerminal(() => cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871'))
    expect(text).toContain('ghcr.io/me/atlas:1.6.4871')
    expect(text).toContain('push attempt 1 of 3 failed: fake: 502 from the registry')
    expect(text).toContain('retrying')
    expect(await runs(argvFile)).toHaveLength(2)
  })

  test('an append with nothing to print still says how long it has been running', async () => {
    await fakeDocker()
    await slowDocker(2.5)
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const out = join(await mkdtemp(join(tmp, 'layers-')), 'slow.tar')
    const { text } = await onTerminal(() =>
      craneAppend({
        gameDir,
        include: [],
        gamePath: '/game',
        base: null,
        platform: 'linux/amd64',
        tag: 'ghcr.io/me/atlas:1',
        out,
      }),
    )
    expect(text).toContain(`crane append for ${out} (2s)`)
  })

  test('no docker on PATH is still an environment error, not a raw spawn reject', async () => {
    await fakeDocker()
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'tok'
    process.env.PATH = await mkdtemp(join(tmp, 'empty-'))
    let thrown: GamecrateError | undefined
    try {
      await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.detail).toContain('ENOENT')
  })

  test('craneLabels keeps its json off the terminal, since a caller parses it', async () => {
    await fakeDocker()
    process.env.FAKE_CONFIG_JSON = '{"config":{"Labels":{"steam.buildid":"19283746"}}}'
    const { result, text } = await onTerminal(() => craneLabels('ghcr.io/me/atlas:1.6.4871'))
    expect(result).toEqual({ 'steam.buildid': '19283746' })
    expect(text).not.toContain('19283746')
  })
})

describe('the fake docker', () => {
  test('refuses --transform, so a tar busybox would reject cannot pass here', async () => {
    await fakeDocker()
    const { code, stderr } = await capture(['docker', 'run', 'sh', '-c', 'tar --transform=s,x,y,'])
    expect(code).toBe(1)
    expect(stderr).toContain('unrecognized option')
  })

  test('refuses an append with no -t, the way crane refuses it', async () => {
    await fakeDocker()
    const script = "'crane' 'append' '--platform' 'linux/amd64' '-f' 'l.tar' '-o' 'o.tar'"
    const bare = await capture(['docker', 'run', 'sh', '-c', script])
    expect(bare.code).toBe(1)
    expect(bare.stderr).toContain('required flag(s) "new_tag" not set')

    const tagged = await capture(['docker', 'run', 'sh', '-c', `${script} '-t' 'ghcr.io/me/atlas:1'`])
    expect(tagged.code).toBe(0)
  })
})

describe('registry credentials', () => {
  test('both variables set log in on stdin, and the password is in no argv', async () => {
    const { argvFile } = await fakeDocker()
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'hunter2'
    await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    const text = await readFile(argvFile, 'utf8')
    expect(text).toContain("'crane' 'auth' 'login' 'ghcr.io' '-u' 'me' '--password-stdin'")
    expect(text).toContain('"$GAMECRATE_REGISTRY_PASSWORD"')
    expect(text).toContain('-e GAMECRATE_REGISTRY_PASSWORD')
    expect(text).not.toContain('hunter2')
  })

  test('an append never logs in, so its public base still pulls anonymously', async () => {
    const { argvFile } = await fakeDocker()
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'hunter2'
    const gameDir = await mkdtemp(join(tmp, 'game-'))
    const base = 'ghcr.io/rimworks/gamecrate/runtime-base@sha256:abc'
    await craneAppend({
      gameDir,
      include: [],
      gamePath: '/game',
      base,
      platform: 'linux/amd64',
      tag: 'ghcr.io/me/atlas:1',
      out: join(await mkdtemp(join(tmp, 'layers-')), 'x.tar'),
    })
    expect(await readFile(argvFile, 'utf8')).not.toContain("'crane' 'auth' 'login'")
    expect(await readFile(argvFile, 'utf8')).toContain(`'-b' '${base}'`)

    await cranePush('/layers/x.tar', 'registry.example.com/me/atlas:1')
    expect(await readFile(argvFile, 'utf8')).toContain(
      "'crane' 'auth' 'login' 'registry.example.com'",
    )
  })

  test('no variables and a plain config mount the config instead', async () => {
    const { argvFile } = await fakeDocker()
    const dir = await dockerConfig({ auths: { 'ghcr.io': { auth: 'x' } } })
    await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    const [argv] = await runs(argvFile)
    expect(argv).toContain(`${dir}:/dockercfg:ro`)
    expect(argv).toContain('DOCKER_CONFIG=/dockercfg')
    expect(await readFile(argvFile, 'utf8')).not.toContain('auth')
  })

  test('the login runs for tag, mutate and config too, not just the push', async () => {
    const { argvFile } = await fakeDocker()
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'hunter2'
    await craneTag('ghcr.io/me/atlas:1.6.4871', 'latest')
    await craneMutateLabels('ghcr.io/me/atlas:1.6.4871', { 'steam.buildid': '1' })
    await craneLabels('ghcr.io/me/atlas:1.6.4871')
    const recorded = await runs(argvFile)
    expect(recorded).toHaveLength(3)
    for (const argv of recorded) {
      expect(argv.join(' ')).toContain("'crane' 'auth' 'login' 'ghcr.io' '-u' 'me'")
      expect(argv).toContain('DOCKER_CONFIG=/tmp/gamecrate-docker')
    }
  })

  test('a credsStore config with no variables is refused before the push', async () => {
    const { argvFile } = await fakeDocker()
    await dockerConfig({ credsStore: 'pass' })
    let thrown: GamecrateError | undefined
    try {
      await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.detail).toContain('pass')
    expect(thrown?.detail).toContain('GAMECRATE_REGISTRY_USER')
    expect(thrown?.detail).toContain('GAMECRATE_REGISTRY_PASSWORD')
    expect(await runs(argvFile)).toHaveLength(0)
  })

  test('a credHelpers entry for the target registry is refused the same way', async () => {
    await fakeDocker()
    await dockerConfig({ credHelpers: { 'ghcr.io': 'pass' } })
    await expect(cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1')).rejects.toThrow(/credentials/)
  })

  test('the early check refuses a helper config and passes on real credentials', async () => {
    await fakeDocker()
    await dockerConfig({ credsStore: 'pass' })
    expect(() => checkRegistryAuthEarly('ghcr.io/me/atlas:1')).toThrow(/credentials/)
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'hunter2'
    expect(() => checkRegistryAuthEarly('ghcr.io/me/atlas:1')).not.toThrow()
  })
})

// Ka's own config: a gcloud helper for an unrelated registry beside a working ghcr.io entry.
// real crane in the crane image answers `crane auth get ghcr.io` with the token, rc=0.
const KA_CONFIG = {
  auths: { 'ghcr.io': { auth: 'YWVxdWFzaTpnaG9fdG9rZW4=' }, 'https://index.docker.io/v1/': {} },
  credHelpers: { 'us-central1-docker.pkg.dev': 'gcloud' },
}

describe('checkRegistryAuthEarly picks the target registry, not any helper', () => {
  test('env vars beat any helper, covered or not', async () => {
    await fakeDocker()
    await dockerConfig({ ...KA_CONFIG, credsStore: 'pass' })
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'hunter2'
    expect(() => checkRegistryAuthEarly('ghcr.io/me/atlas:1')).not.toThrow()
  })

  test('an auths entry passes while a helper for another registry sits beside it', async () => {
    const { argvFile } = await fakeDocker()
    await dockerConfig(KA_CONFIG)
    expect(() => checkRegistryAuthEarly('ghcr.io/rimworks/gamecrate/rimworld:1')).not.toThrow()
    await cranePush('/layers/x.tar', 'ghcr.io/rimworks/gamecrate/rimworld:1')
    expect(await runs(argvFile)).toHaveLength(1)
  })

  test('that same config still refuses the registry the helper does cover', async () => {
    await fakeDocker()
    await dockerConfig(KA_CONFIG)
    let thrown: GamecrateError | undefined
    try {
      checkRegistryAuthEarly('us-central1-docker.pkg.dev/me/atlas:1')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.message).toContain('us-central1-docker.pkg.dev')
    expect(thrown?.message).not.toContain('ghcr.io')
    expect(thrown?.detail).toContain('gcloud')
  })

  test('an empty auths entry is not credentials, so the store still refuses', async () => {
    await fakeDocker()
    await dockerConfig({ auths: { 'ghcr.io': {} }, credsStore: 'pass' })
    let thrown: GamecrateError | undefined
    try {
      checkRegistryAuthEarly('ghcr.io/me/atlas:1')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.detail).toContain('(pass)')
  })

  // a fresh CI runner has no config.json, and the action Ka ships runs on one
  test('no docker config at all refuses, rather than failing after the download', async () => {
    await fakeDocker()
    let thrown: GamecrateError | undefined
    try {
      checkRegistryAuthEarly('ghcr.io/me/atlas:1')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.message).toBe('no registry credentials for ghcr.io')
    expect(thrown?.detail).toContain('GAMECRATE_REGISTRY_USER')
  })

  test('an identitytoken counts as credentials', async () => {
    await fakeDocker()
    await dockerConfig({ auths: { 'ghcr.io': { identitytoken: 'tok' } }, credsStore: 'pass' })
    expect(() => checkRegistryAuthEarly('ghcr.io/me/atlas:1')).not.toThrow()
  })

  test('an empty config refuses and names the target registry', async () => {
    await fakeDocker()
    await dockerConfig({})
    let thrown: GamecrateError | undefined
    try {
      checkRegistryAuthEarly('ghcr.io/me/atlas:1')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.message).toBe('no registry credentials for ghcr.io')
    expect(thrown?.detail).toContain('no auths entry')
  })

  test('a hub push reads the legacy url key docker writes', async () => {
    await fakeDocker()
    await dockerConfig({ auths: { 'https://index.docker.io/v1/': { auth: 'eDp5' } } })
    expect(() => checkRegistryAuthEarly('myuser/rimworld:1')).not.toThrow()
  })

  test('a fully-qualified docker.io push reads that same legacy url key', async () => {
    await fakeDocker()
    await dockerConfig({ auths: { 'https://index.docker.io/v1/': { auth: 'eDp5' } } })
    expect(() => checkRegistryAuthEarly('docker.io/myuser/rimworld:1')).not.toThrow()
  })

  test('one variable without the other is refused, not treated as anonymous', async () => {
    const { argvFile } = await fakeDocker()
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    let thrown: GamecrateError | undefined
    try {
      await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.message).toContain('GAMECRATE_REGISTRY_PASSWORD')
    expect(await runs(argvFile)).toHaveLength(0)
  })
})

describe('the login registry', () => {
  // proved against real crane: a hub short ref resolves to index.docker.io, not to its first path part
  const cases: [string, string][] = [
    ['ghcr.io/me/x', 'ghcr.io'],
    ['myuser/rimworld', 'index.docker.io'],
    ['rimworld', 'index.docker.io'],
    ['localhost:5000/x', 'localhost:5000'],
    ['localhost/x', 'localhost'],
    ['registry.example.com:5000/me/x', 'registry.example.com:5000'],
    // `crane auth get docker.io` and `index.docker.io` both return the legacy hub key's creds
    ['docker.io/me/x', 'index.docker.io'],
    ['index.docker.io/me/x', 'index.docker.io'],
    // `crane auth login registry-1.docker.io` writes its own key, so it is a separate registry
    ['registry-1.docker.io/me/x', 'registry-1.docker.io'],
  ]
  for (const [ref, registry] of cases) {
    test(`${ref} logs in to ${registry}`, async () => {
      const { argvFile } = await fakeDocker()
      process.env.GAMECRATE_REGISTRY_USER = 'me'
      process.env.GAMECRATE_REGISTRY_PASSWORD = 'hunter2'
      await cranePush('/layers/x.tar', ref)
      expect(await readFile(argvFile, 'utf8')).toContain(
        `'crane' 'auth' 'login' '${registry}' '-u' 'me' '--password-stdin'`,
      )
    })
  }
})

describe('cranePush', () => {
  // every push needs credentials now, the way a real one does
  beforeEach(() => {
    process.env.GAMECRATE_REGISTRY_USER = 'me'
    process.env.GAMECRATE_REGISTRY_PASSWORD = 'tok'
  })

  test('sends push with the tar and the ref', async () => {
    const { argvFile } = await fakeDocker()
    await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    const [argv] = await runs(argvFile)
    expect(argv!.join(' ')).toContain(
      "'crane' 'push' '/layers/x.tar' 'ghcr.io/me/atlas:1.6.4871'",
    )
    expect(argv).toContain('/layers:/layers:ro')
  })

  test('retries a failing push and then succeeds', async () => {
    const { argvFile } = await fakeDocker()
    process.env.FAKE_FAIL_FIRST = '2'
    await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    expect(await runs(argvFile)).toHaveLength(3)
  })

  test('a push that never succeeds throws with the registry output', async () => {
    const { argvFile } = await fakeDocker()
    process.env.FAKE_FAIL_FIRST = '99'
    let thrown: GamecrateError | undefined
    try {
      await cranePush('/layers/x.tar', 'ghcr.io/me/atlas:1.6.4871')
    } catch (error) {
      thrown = error as GamecrateError
    }
    expect(thrown?.code).toBe(Exit.Environment)
    expect(thrown?.detail).toContain('502')
    expect(await runs(argvFile)).toHaveLength(3)
  })
})

describe('craneTag and craneMutateLabels', () => {
  test('tag sends the ref then the tag', async () => {
    const { argvFile } = await fakeDocker()
    await craneTag('ghcr.io/me/atlas:1.6.4871', 'latest')
    const [argv] = await runs(argvFile)
    expect(argv!.join(' ')).toContain("'crane' 'tag' 'ghcr.io/me/atlas:1.6.4871' 'latest'")
  })

  test('mutate sends one --label per entry and retags in place', async () => {
    const { argvFile } = await fakeDocker()
    await craneMutateLabels('ghcr.io/me/atlas:1.6.4871', {
      'steam.buildid': '19283746',
      'gamecrate.variant': 'linux',
      'gamecrate.launcher': 'direct',
    })
    const [argv] = await runs(argvFile)
    expect(argv!.join(' ')).toContain(
      "'crane' 'mutate' 'ghcr.io/me/atlas:1.6.4871' " +
        "'--label' 'steam.buildid=19283746' " +
        "'--label' 'gamecrate.variant=linux' " +
        "'--label' 'gamecrate.launcher=direct' " +
        "'-t' 'ghcr.io/me/atlas:1.6.4871'",
    )
  })
})

describe('craneLabels', () => {
  test('reads the labels off the config', async () => {
    await fakeDocker()
    process.env.FAKE_CONFIG_JSON = '{"config":{"Labels":{"steam.buildid":"19283746"}}}'
    expect(await craneLabels('ghcr.io/me/atlas:1.6.4871')).toEqual({ 'steam.buildid': '19283746' })
  })

  test('an image with no labels is an empty record, not null', async () => {
    await fakeDocker()
    process.env.FAKE_CONFIG_JSON = '{"config":{"Labels":null}}'
    expect(await craneLabels('ghcr.io/me/atlas:1.6.4871')).toEqual({})
  })

  test('an unreadable image is null', async () => {
    await fakeDocker()
    process.env.FAKE_EXIT = '1'
    expect(await craneLabels('ghcr.io/me/nosuch:1')).toBeNull()
  })

  test('output that is not json is null', async () => {
    await fakeDocker()
    process.env.FAKE_CONFIG_JSON = 'not json at all'
    expect(await craneLabels('ghcr.io/me/atlas:1.6.4871')).toBeNull()
  })
})
