/**
 * Valve's KeyValues text format, as Steam writes it to `appworkshop_<appid>.acf`. Steam owns
 * that file, so every failure here degrades to an empty result instead of throwing.
 */
export type AcfNode = { [key: string]: string | AcfNode }

type Installed = { manifest: string; timeupdated: number }

const MAX_DEPTH = 100

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n'
}

/** Advances past whitespace and `//` comments. */
function skip(text: string, start: number): number {
  let i = start
  for (;;) {
    while (i < text.length && isSpace(text[i]!)) i += 1
    if (!text.startsWith('//', i)) return i
    const nl = text.indexOf('\n', i)
    if (nl === -1) return text.length
    i = nl + 1
  }
}

/** Reads the quoted string at `start`. Null when it never closes. */
function quoted(text: string, start: number): { value: string; next: number } | null {
  let out = ''
  let i = start + 1
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') {
      // Only `\\` and `\"` are real escapes; anything else passes through as itself.
      if (i + 1 >= text.length) return null
      out += text[i + 1]!
      i += 2
      continue
    }
    if (c === '"') return { value: out, next: i + 1 }
    out += c
    i += 1
  }
  return null
}

function body(text: string, start: number, depth: number): { node: AcfNode; next: number } | null {
  if (depth > MAX_DEPTH) return null
  const node: AcfNode = {}
  let i = start

  for (;;) {
    i = skip(text, i)
    // EOF closes the root and nothing else, so an unterminated brace fails the whole parse.
    if (i >= text.length) return depth === 0 ? { node, next: i } : null
    // a stray close brace at the root is malformed, the same way an unterminated one is
    if (text[i] === '}' && depth === 0) return null
    if (text[i] === '}') return { node, next: i + 1 }
    if (text[i] !== '"') return null

    const next = readEntry(text, i, depth, node)
    if (next === null) return null
    i = next
  }
}

/** Reads one `"key" "value"` or `"key" { ... }` into node. Returns the index after it. */
function readEntry(text: string, start: number, depth: number, node: AcfNode): number | null {
  const key = quoted(text, start)
  if (key === null) return null
  const i = skip(text, key.next)
  if (i >= text.length) return null

  if (text[i] === '{') {
    const child = body(text, i + 1, depth + 1)
    if (child === null) return null
    node[key.value] = child.node
    return child.next
  }

  if (text[i] !== '"') return null
  const value = quoted(text, i)
  if (value === null) return null
  node[key.value] = value.value
  return value.next
}

/** Parses KeyValues text. A malformed file is an empty object, never a throw. */
export function parseAcf(text: string): AcfNode {
  return body(text, 0, 0)?.node ?? {}
}

/** Finds a section on the root itself or on one of its direct children. */
function section(root: AcfNode, name: string): AcfNode | undefined {
  const direct = root[name]
  if (typeof direct === 'object') return direct
  for (const child of Object.values(root)) {
    if (typeof child === 'object' && typeof child[name] === 'object') return child[name]
  }
  return undefined
}

/**
 * The installed workshop items, keyed by item id. Manifest ids stay strings: they run past
 * Number.MAX_SAFE_INTEGER and parsing one as a number corrupts it silently.
 */
export function installedItems(text: string): Map<string, Installed> {
  const out = new Map<string, Installed>()
  const items = section(parseAcf(text), 'WorkshopItemsInstalled')
  if (items === undefined) return out

  for (const [id, entry] of Object.entries(items)) {
    if (typeof entry !== 'object') continue
    const manifest = entry['manifest']
    if (typeof manifest !== 'string' || manifest === '') continue
    out.set(id, { manifest, timeupdated: Number(entry['timeupdated']) || 0 })
  }
  return out
}
