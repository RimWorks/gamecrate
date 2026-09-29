import { afterAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerSocket, resetGpuProbe, sampleOf, subscribeGpu, subscribeStats } from '../src/docker/stats'
import type { GpuEvent, StatsEvent, StatsFrame } from '../src/docker/stats'

const FRAME: StatsFrame = {
  cpu_stats: {
    cpu_usage: { total_usage: 1_500_000_000 },
    system_cpu_usage: 200_000_000_000,
    online_cpus: 8,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1_000_000_000 },
    system_cpu_usage: 190_000_000_000,
  },
  memory_stats: {
    usage: 1_073_741_824,
    limit: 4_000_000_000,
    stats: { inactive_file: 73_741_824 },
  },
}

const servers: Server[] = []

afterAll(() => {
  for (const server of servers) server.close()
})

function serve(handler: (path: string, res: ServerResponse) => void): Promise<string> {
  const socket = join(mkdtempSync(join(tmpdir(), 'gamecrate-stats-')), 'docker.sock')
  const server = createServer((req, res) => handler(req.url ?? '', res))
  servers.push(server)
  return new Promise((resolve) => server.listen(socket, () => resolve(socket)))
}

function collect(socketPath: string, id = 'abc123'): Promise<StatsEvent[]> {
  return new Promise((resolve) => {
    const events: StatsEvent[] = []
    subscribeStats(
      id,
      (event) => {
        events.push(event)
        if (event.kind !== 'sample') resolve(events)
      },
      { socketPath },
    )
  })
}

describe('sampleOf', () => {
  test('cpu and memory come out as rates against the previous frame', () => {
    const sample = sampleOf(FRAME)
    expect(sample.cpuPct).toBeCloseTo(40, 6)
    expect(sample.memUsed).toBe(1_000_000_000)
    expect(sample.memLimit).toBe(4_000_000_000)
    expect(sample.memPct).toBeCloseTo(25, 6)
  })

  test('a first frame with no system delta reports zero, not NaN', () => {
    const sample = sampleOf({
      cpu_stats: { cpu_usage: { total_usage: 500 }, system_cpu_usage: 1000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 10, limit: 0, stats: { inactive_file: 0 } },
    })
    expect(sample.cpuPct).toBe(0)
    expect(sample.memPct).toBe(0)
  })

  test('frame 1 omits pre.system_cpu_usage, so it reports 0 instead of cpu since boot', () => {
    const sample = sampleOf({
      cpu_stats: { cpu_usage: { total_usage: 87_297_000 }, system_cpu_usage: 1_792_400_920_000_000, online_cpus: 32 },
      precpu_stats: { cpu_usage: { total_usage: 0 } },
      memory_stats: { usage: 100, limit: 1000, stats: { inactive_file: 0 } },
    })
    expect(sample.cpuPct).toBe(0)
    expect(sample.memPct).toBeCloseTo(10, 6)
  })

  test('an empty frame reports zeroes rather than dividing by nothing', () => {
    const sample = sampleOf({})
    expect(sample).toEqual({ cpuPct: 0, memPct: 0, memUsed: 0, memLimit: 0 })
  })

  test('a missing online_cpus counts as one core', () => {
    const { cpu_stats, ...rest } = FRAME
    const sample = sampleOf({ ...rest, cpu_stats: { ...cpu_stats, online_cpus: undefined } })
    expect(sample.cpuPct).toBeCloseTo(5, 6)
  })
})

describe('dockerSocket', () => {
  test('a unix DOCKER_HOST resolves to its path', () => {
    expect(dockerSocket({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' })).toEqual({
      path: '/run/user/1000/docker.sock',
    })
  })

  test('no DOCKER_HOST uses the default socket', () => {
    expect(dockerSocket({})).toEqual({ path: '/var/run/docker.sock' })
    expect(dockerSocket({ DOCKER_HOST: '' })).toEqual({ path: '/var/run/docker.sock' })
  })

  test('a tcp DOCKER_HOST is refused by name, never a fallback to the local socket', () => {
    const choice = dockerSocket({ DOCKER_HOST: 'tcp://10.0.0.2:2375' })
    expect(choice).not.toHaveProperty('path')
    expect((choice as { message: string }).message).toBe(
      'DOCKER_HOST "tcp://10.0.0.2:2375" is not a unix socket, so live stats have no socket to read: unset it, or set a unix:// path',
    )
  })

  test('subscribeStats reports that refusal through the same error channel', async () => {
    const events: StatsEvent[] = []
    await new Promise<void>((resolve) => {
      subscribeStats(
        'abc123',
        (event) => {
          events.push(event)
          resolve()
        },
        { env: { DOCKER_HOST: 'ssh://box' } },
      )
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'error',
      message:
        'DOCKER_HOST "ssh://box" is not a unix socket, so live stats have no socket to read: unset it, or set a unix:// path',
    })
  })
})

describe('subscribeStats', () => {
  test('one streaming request per container, and the id lands in the path', async () => {
    const paths: string[] = []
    const socket = await serve((path, res) => {
      paths.push(path)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`${JSON.stringify(FRAME)}\n`)
    })

    const events = await collect(socket)
    expect(paths).toEqual(['/containers/abc123/stats?stream=true'])
    expect(events[0]).toMatchObject({ kind: 'sample', cpuPct: 40 })
    expect(events.at(-1)).toEqual({ kind: 'end' })
  })

  test('a JSON object split across two chunks reassembles', async () => {
    const body = `${JSON.stringify(FRAME)}\n${JSON.stringify(FRAME)}\n`
    const cut = body.indexOf('system_cpu_usage')
    const socket = await serve((_path, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(body.slice(0, cut))
      setTimeout(() => res.end(body.slice(cut)), 20)
    })

    const events = await collect(socket)
    const samples = events.filter((event) => event.kind === 'sample')
    expect(samples).toHaveLength(2)
    expect(samples.every((event) => event.kind === 'sample' && event.cpuPct === 40)).toBe(true)
  })

  test('a malformed line is skipped and the stream keeps going', async () => {
    const socket = await serve((_path, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`{"cpu_stats":\n\n${JSON.stringify(FRAME)}\n`)
    })

    const events = await collect(socket)
    expect(events.filter((event) => event.kind === 'sample')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ kind: 'end' })
  })

  test('a container gone mid-stream comes back as an error, not a throw', async () => {
    const socket = await serve((_path, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"message":"no such container"}')
    })

    const events = await collect(socket, 'ghost')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'error' })
    expect((events[0] as { message: string }).message).toContain('404')
  })

  test('a missing socket is an error value, not a rejection', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'gamecrate-stats-')), 'nope.sock')
    const events = await collect(missing)
    expect(events[0]).toMatchObject({ kind: 'error' })
  })

  test('unsubscribing stops the callback', async () => {
    const socket = await serve((_path, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(`${JSON.stringify(FRAME)}\n`)
    })

    const events: StatsEvent[] = []
    const stop = subscribeStats('abc123', (event) => events.push(event), { socketPath: socket })
    stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events).toEqual([])
  })
})

describe('subscribeGpu', () => {
  test('one persistent process, parsed a line at a time', async () => {
    resetGpuProbe()
    const bin = join(mkdtempSync(join(tmpdir(), 'gamecrate-gpu-')), 'nvidia-smi')
    writeFileSync(bin, '#!/bin/sh\necho " 37, 2048, 24564"\necho "41, 2100, 24564"\n')
    chmodSync(bin, 0o755)

    const events: GpuEvent[] = []
    await new Promise<void>((resolve) => {
      subscribeGpu((event) => {
        events.push(event)
        if (events.length === 2) resolve()
      }, { bin })
    })
    expect(events[0]).toEqual({ kind: 'sample', utilPct: 37, memUsedMb: 2048, memTotalMb: 24564 })
    expect(events[1]).toMatchObject({ utilPct: 41 })
  })

  test('a missing nvidia-smi reports unavailable once and never spawns again', async () => {
    resetGpuProbe()
    const first = await new Promise<GpuEvent>((resolve) => {
      subscribeGpu(resolve, { bin: join(tmpdir(), 'gamecrate-no-such-nvidia-smi') })
    })
    expect(first.kind).toBe('unavailable')

    const second: GpuEvent[] = []
    subscribeGpu((event) => second.push(event), { bin: '/bin/echo' })
    expect(second).toHaveLength(1)
    expect(second[0]!.kind).toBe('unavailable')
  })
})

describe('guards found by review', () => {
  test('a reported zero cpu count falls back instead of zeroing the rate', () => {
    const frame = {
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 400, online_cpus: 0 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 200 },
    }
    expect(sampleOf(frame).cpuPct).toBe(50)
  })

  test('a container restart resetting total_usage reads zero, never negative', () => {
    const frame = {
      cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 200, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 100 },
    }
    expect(sampleOf(frame).cpuPct).toBe(0)
  })

  test('inactive_file above usage reads zero, never negative', () => {
    const sample = sampleOf({ memory_stats: { usage: 100, limit: 1000, stats: { inactive_file: 200 } } })
    expect(sample.memUsed).toBe(0)
    expect(sample.memPct).toBe(0)
  })
})
