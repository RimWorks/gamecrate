import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { promisify } from 'node:util'

import { warn } from '../cli/output'

const run = promisify(execFile)

/** ChangeProperty, InternAtom, and the CARDINAL every icon is a list of. */
const CHANGE_PROPERTY = 18
const INTERN_ATOM = 16
const CARDINAL = 6

/** X pads every field to a 4-byte boundary. */
function padding(length: number): number {
  return (4 - (length % 4)) % 4
}

function displayNumber(display: string): string {
  return display.replace(/^.*:/, '').split('.')[0] ?? '0'
}

/**
 * The cookie for one display, out of the file XAUTHORITY names. Read through `xauth` rather
 * than parsed here: the file is a binary format with a host entry and a wildcard entry.
 */
async function cookieFor(display: string): Promise<Buffer | null> {
  const wanted = displayNumber(display)
  try {
    const { stdout } = await run('xauth', ['list'])
    for (const line of stdout.split('\n')) {
      const match = /^\S+:(\d+)\s+MIT-MAGIC-COOKIE-1\s+([0-9a-f]+)$/.exec(line.trim())
      if (match && match[1] === wanted) return Buffer.from(match[2]!, 'hex')
    }
  } catch {
    return null
  }
  return null
}

/** The ARGB rows _NET_WM_ICON wants, decoded by ImageMagick so no format lives in here. */
async function argbPixels(path: string, size: number): Promise<Buffer | null> {
  for (const tool of ['magick', 'convert']) {
    try {
      const { stdout } = await run(
        tool,
        [path, '-resize', `${size}x${size}!`, '-depth', '8', 'RGBA:-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      )
      if (stdout.length === size * size * 4) return stdout
    } catch {
      continue
    }
  }
  return null
}

async function openDisplay(display: string): Promise<ReturnType<typeof connect> | null> {
  const cookie = await cookieFor(display)
  if (cookie === null) return null

  const socket = connect(`/tmp/.X11-unix/X${displayNumber(display)}`)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
  } catch {
    return null
  }

  const name = Buffer.from('MIT-MAGIC-COOKIE-1')
  const head = Buffer.alloc(12)
  head.write('l', 0, 'ascii')
  head.writeUInt16LE(11, 2)
  head.writeUInt16LE(name.length, 6)
  head.writeUInt16LE(cookie.length, 8)
  socket.write(
    Buffer.concat([
      head,
      name,
      Buffer.alloc(padding(name.length)),
      cookie,
      Buffer.alloc(padding(cookie.length)),
    ]),
  )

  const reply = await new Promise<Buffer>((resolve) => socket.once('data', resolve))
  if (reply[0] !== 1) {
    socket.destroy()
    return null
  }
  return socket
}

function internAtom(socket: ReturnType<typeof connect>, name: string): Promise<number> {
  const length = 8 + name.length + padding(name.length)
  const request = Buffer.alloc(length)
  request.writeUInt8(INTERN_ATOM, 0)
  request.writeUInt16LE(length / 4, 2)
  request.writeUInt16LE(name.length, 4)
  request.write(name, 8, 'ascii')
  socket.write(request)
  return new Promise((resolve) => socket.once('data', (d: Buffer) => resolve(d.readUInt32LE(8))))
}

/** width, height, then one ARGB cardinal per pixel, which is the shape the spec asks for. */
export function iconProperty(rgba: Buffer, size: number): Buffer {
  const body = Buffer.alloc(8 + size * size * 4)
  body.writeUInt32LE(size, 0)
  body.writeUInt32LE(size, 4)
  for (let i = 0; i < size * size; i += 1) {
    const [r, g, b, a] = [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!, rgba[i * 4 + 3]!]
    body.writeUInt32LE(((a << 24) | (r << 16) | (g << 8) | b) >>> 0, 8 + i * 4)
  }
  return body
}

const ICON_SIZE = 64

/**
 * The caption is wmctrl's job; an icon is nobody's. xprop truncates a property at 64 elements
 * and one icon is thousands, so the property goes over the wire here instead.
 */
export async function setWindowIcon(windowId: string, iconPath: string): Promise<void> {
  const display = process.env.DISPLAY
  if (display === undefined || display === '') return

  const rgba = await argbPixels(iconPath, ICON_SIZE)
  if (rgba === null) {
    warn(`could not read ${iconPath}, so the window keeps its own icon`)
    return
  }

  const socket = await openDisplay(display)
  if (socket === null) {
    warn('could not reach the X server to set the window icon')
    return
  }

  try {
    const atom = await internAtom(socket, '_NET_WM_ICON')
    const body = iconProperty(rgba, ICON_SIZE)
    const request = Buffer.alloc(24)
    request.writeUInt8(CHANGE_PROPERTY, 0)
    request.writeUInt16LE((24 + body.length) / 4, 2)
    request.writeUInt32LE(Number.parseInt(windowId, 16), 4)
    request.writeUInt32LE(atom, 8)
    request.writeUInt32LE(CARDINAL, 12)
    request.writeUInt8(32, 16)
    request.writeUInt32LE(body.length / 4, 20)
    socket.write(Buffer.concat([request, body]))
    // the write is one-way, so give the server a moment before the socket closes under it
    await new Promise((resolve) => setTimeout(resolve, 100))
  } finally {
    socket.end()
  }
}
