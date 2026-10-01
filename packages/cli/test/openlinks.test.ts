import { afterAll, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LinkOpener } from '../src/docker/openlinks'
import {
  allowedUrl,
  CONTAINER_OPEN_FIFO,
  OPEN_FIFO_FILE,
  OPEN_SHIM_FILE,
  startLinkOpener,
} from '../src/docker/openlinks'

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gamecrate-open-'))
  dirs.push(dir)
  return dir
}

function open(dir: string, onUrl: (url: string) => void = () => {}): LinkOpener {
  const opener = startLinkOpener(dir, onUrl)
  if (opener === undefined) throw new Error('mkfifo is missing, so the opener could not start')
  return opener
}

describe('allowedUrl', () => {
  test('passes http and https, in any case', () => {
    expect(allowedUrl('https://steamcommunity.com/app/294100')).toBe('https://steamcommunity.com/app/294100')
    expect(allowedUrl('  http://rimworldgame.com  ')).toBe('http://rimworldgame.com')
    expect(allowedUrl('HTTPS://rimworldgame.com/x')).toBe('HTTPS://rimworldgame.com/x')
  })

  test('refuses every other scheme', () => {
    expect(allowedUrl('file:///etc/passwd')).toBeNull()
    expect(allowedUrl('steam://run/294100')).toBeNull()
    expect(allowedUrl('/home/aaron/.ssh/id_ed25519')).toBeNull()
    expect(allowedUrl('')).toBeNull()
  })

  test('refuses a second argument smuggled in as whitespace', () => {
    expect(allowedUrl('https://a.test /etc/passwd')).toBeNull()
  })
})

describe('startLinkOpener', () => {
  test('writes an executable shim pointed at the fifo', async () => {
    const dir = scratch()
    const opener = open(dir)
    try {
      expect(statSync(join(dir, OPEN_FIFO_FILE)).isFIFO()).toBe(true)
      const shim = join(dir, OPEN_SHIM_FILE)
      expect(statSync(shim).mode & 0o111).toBeGreaterThan(0)
      await expect(Bun.file(shim).text()).resolves.toContain(CONTAINER_OPEN_FIFO)
    } finally {
      opener.stop()
    }
  })

  test('opens what the container writes, and only that', async () => {
    const dir = scratch()
    const opened: string[] = []
    const opener = open(dir, (url) => opened.push(url))
    try {
      await feed(join(dir, OPEN_FIFO_FILE), 'https://a.test/one\nfile:///etc/passwd\nhttps://a.test/two\n')
      await settle(() => opened.length >= 2)
      expect(opened).toEqual(['https://a.test/one', 'https://a.test/two'])
    } finally {
      opener.stop()
    }
  })

  test('keeps watching after a writer closes its end', async () => {
    const dir = scratch()
    const opened: string[] = []
    const opener = open(dir, (url) => opened.push(url))
    try {
      await feed(join(dir, OPEN_FIFO_FILE), 'https://a.test/first\n')
      await settle(() => opened.length >= 1)
      await feed(join(dir, OPEN_FIFO_FILE), 'https://b.test/second\n')
      await settle(() => opened.length >= 2)
      expect(opened).toEqual(['https://a.test/first', 'https://b.test/second'])
    } finally {
      opener.stop()
    }
  })

  test('a giant junk line does not wedge the reader', async () => {
    const dir = scratch()
    const opened: string[] = []
    const opener = open(dir, (url) => opened.push(url))
    try {
      const fifo = join(dir, OPEN_FIFO_FILE)
      await feed(fifo, 'x'.repeat(32768))
      await feed(fifo, '\nhttps://a.test/after\n')
      await settle(() => opened.length >= 1)
      expect(opened).toEqual(['https://a.test/after'])
    } finally {
      opener.stop()
    }
  })

  test('a second stop does not write into a recycled descriptor', async () => {
    const dir = scratch()
    const opener = open(dir)
    opener.stop()
    await Bun.sleep(100)

    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'important-data\n')
    const fd = openSync(victim, 'a')
    try {
      opener.stop()
    } finally {
      closeSync(fd)
    }
    expect(readFileSync(victim, 'utf8')).toBe('important-data\n')
  })
})

/** Writes the way a container does: in pieces, yielding so the reader can drain the pipe. */
async function feed(fifo: string, text: string): Promise<void> {
  for (let at = 0; at < text.length; at += 2048) {
    appendFileSync(fifo, text.slice(at, at + 2048))
    await Bun.sleep(2)
  }
}

async function settle(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    if (done()) {
      await Bun.sleep(40)
      return
    }
    await Bun.sleep(10)
  }
  throw new Error('the fifo reader never delivered anything')
}
