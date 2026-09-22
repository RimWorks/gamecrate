import { SaxesParser } from 'saxes'
import { NAME_RE } from 'xmlchars/xml/1.0/ed5'
import type { ModManifest } from '@gamecrate/cli'

interface XmlNode {
  name: string
  children: XmlNode[]
  /** Direct character data only, entities and CDATA resolved. */
  text: string
  /** Source between the start and end tags, verbatim. */
  inner: string
}

/**
 * Strict by default: an unknown entity or a valueless attribute is an error. A DOCTYPE is
 * accepted and its external part is never fetched, because saxes resolves nothing itself.
 */
function parseDocument(text: string): XmlNode {
  const src = text.codePointAt(0) === 0xfeff ? text.slice(1) : text
  const parser = new SaxesParser({ xmlns: false, position: true })
  const stack: { node: XmlNode; innerStart: number }[] = []
  let root: XmlNode | undefined

  parser.on('error', (e) => {
    throw new Error(`malformed XML: ${e.message}`)
  })
  parser.on('opentag', (tag) => {
    const node: XmlNode = { name: tag.name, children: [], text: '', inner: '' }
    stack.at(-1)?.node.children.push(node)
    root ??= node
    if (tag.isSelfClosing) return
    stack.push({ node, innerStart: parser.position })
  })
  parser.on('closetag', (tag) => {
    if (tag.isSelfClosing) return
    const frame = stack.pop()
    if (!frame) return
    // Between innerStart and here the only '<' is the one opening this closing tag.
    frame.node.inner = src.slice(frame.innerStart, src.lastIndexOf('<', parser.position - 1))
  })
  const addText = (t: string): void => {
    const top = stack.at(-1)
    if (top) top.node.text += t
  }
  parser.on('text', addText)
  parser.on('cdata', addText)

  parser.write(src).close()
  if (root === undefined) throw new Error('malformed XML: no root element')
  return root
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  const lower = name.toLowerCase()
  return node.children.find((n) => n.name.toLowerCase() === lower)
}

function childText(node: XmlNode, name: string): string | undefined {
  const found = child(node, name)
  if (!found) return undefined
  const value = found.text.trim()
  return value === '' ? undefined : value
}

function liStrings(node: XmlNode, name: string): string[] {
  const list = child(node, name)
  if (!list) return []
  const out: string[] = []
  for (const item of list.children) {
    if (item.name.toLowerCase() !== 'li') continue
    const value = item.text.trim()
    if (value !== '') out.push(value)
  }
  return out
}

function dependencies(root: XmlNode): ModManifest['modDependencies'] {
  const list = child(root, 'modDependencies')
  if (!list) return []
  const out: ModManifest['modDependencies'] = []
  for (const item of list.children) {
    if (item.name.toLowerCase() !== 'li') continue
    const packageId = childText(item, 'packageId')
    if (packageId === undefined) continue
    const steamWorkshopUrl = childText(item, 'steamWorkshopUrl')
    out.push(steamWorkshopUrl === undefined ? { packageId } : { packageId, steamWorkshopUrl })
  }
  return out
}

/**
 * Reads the mod's OWN packageId, never a dependency's. Verified against workshop item
 * 1195427067, whose only packageId before its own belongs to a modDependencies entry.
 */
export function parseAboutXml(text: string): ModManifest | null {
  const root = parseDocument(text)
  const packageId = childText(root, 'packageId')
  if (packageId === undefined) return null
  const manifest: ModManifest = {
    packageId,
    modDependencies: dependencies(root),
    loadAfter: liStrings(root, 'loadAfter'),
    loadBefore: liStrings(root, 'loadBefore'),
    forceLoadAfter: liStrings(root, 'forceLoadAfter'),
    forceLoadBefore: liStrings(root, 'forceLoadBefore'),
    incompatibleWith: liStrings(root, 'incompatibleWith'),
  }
  const name = childText(root, 'name')
  if (name !== undefined) manifest.name = name
  return manifest
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function listBlock(name: string, items: string[]): string[] {
  if (items.length === 0) return [`  <${name} />`]
  return [`  <${name}>`, ...items.map((i) => `    <li>${escapeText(i)}</li>`), `  </${name}>`]
}

export function writeModsConfigXml(opts: {
  version: string
  activeMods: string[]
  knownExpansions: string[]
}): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ModsConfigData>',
    `  <version>${escapeText(opts.version)}</version>`,
    ...listBlock('activeMods', opts.activeMods),
    ...listBlock('knownExpansions', opts.knownExpansions),
    '</ModsConfigData>',
    '',
  ].join('\n')
}

/**
 * Values of nested keys (`devPalettePosition`, `debugActionPalette`) come back as their
 * verbatim inner XML so a merge can put them back byte for byte.
 */
export function parsePrefsXml(text: string): Map<string, string> {
  const root = parseDocument(text)
  const entries = new Map<string, string>()
  for (const node of root.children) {
    entries.set(node.name, node.children.length > 0 ? node.inner : node.text.trim())
  }
  return entries
}

function isMarkup(value: string): boolean {
  if (!value.includes('<')) return false
  try {
    const node = parseDocument(`<w>${value}</w>`)
    return node.children.length > 0 && node.text.trim() === ''
  } catch {
    return false
  }
}

export function writePrefsXml(entries: Map<string, string>): string {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<PrefsData>']
  for (const [key, value] of entries) {
    // A key becomes a tag name, so a bad one from prefsExtra fails here instead of in the file.
    if (!NAME_RE.test(key)) throw new Error(`prefs key is not an XML name: ${JSON.stringify(key)}`)
    if (value === '') lines.push(`  <${key} />`)
    else if (isMarkup(value)) lines.push(`  <${key}>${value}</${key}>`)
    else lines.push(`  <${key}>${escapeText(value)}</${key}>`)
  }
  lines.push('</PrefsData>', '')
  return lines.join('\n')
}

/** The tool owns a handful of keys, the player owns the other ~40. */
export function mergePrefsXml(existing: string | null, owned: Record<string, string>): string {
  const entries =
    existing === null || existing.trim() === '' ? new Map<string, string>() : parsePrefsXml(existing)
  for (const [key, value] of Object.entries(owned)) entries.set(key, value)
  return writePrefsXml(entries)
}
