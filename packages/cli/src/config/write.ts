import { chmod, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { applyEdits, modify } from 'jsonc-parser'
import type { Document } from 'yaml'
import { isMap, parseDocument } from 'yaml'

import { GamecrateError, Exit } from '../types'
import { CONFIG_SUFFIXES } from './read'

/** A value of `undefined` deletes the key rather than writing an undefined. */
export interface ConfigEdit {
  path: (string | number)[]
  value: unknown
}

/** Mirrors read.ts: a suffix the loader would refuse to parse is one the writer must refuse. */
function isYaml(path: string): boolean {
  const suffix = extname(path).toLowerCase()
  if (suffix === '.yml' || suffix === '.yaml') return true
  if (suffix === '.json' || suffix === '.jsonc') return false
  throw new GamecrateError(
    `config is not a format gamecrate writes: ${path}`,
    Exit.Config,
    `use one of ${CONFIG_SUFFIXES.join(', ')}`,
  )
}

/**
 * jsonc-parser never sniffs the file, so an inserted block lands with whatever width it is
 * handed. A file indented with tabs and edited with spaces reads as two files.
 */
export function detectIndent(text: string): { tabSize: number; insertSpaces: boolean } {
  // anchored on a quoted key, so a block comment's continuation line is not read as the indent.
  const lead = /\n([ \t]+)"/.exec(text)?.[1]
  if (lead === undefined) return { tabSize: 2, insertSpaces: true }
  return lead.startsWith('\t')
    ? { tabSize: 1, insertSpaces: false }
    : { tabSize: lead.length, insertSpaces: true }
}

export async function writeConfig(file: string, edits: ConfigEdit[]): Promise<void> {
  if (edits.length === 0) return

  // The format comes from the name the caller used, which is the name the loader parsed.
  // A .gamecrate.yml symlinked to an extensionless dotfile would otherwise be read as yaml
  // and written as json.
  const yaml = isYaml(file)

  // A dotfile-managed config is usually a symlink. Renaming over the link would replace it
  // with a regular file and detach the repo that owns it.
  const target = await realpath(file)
  const before = await readFile(target, 'utf8')
  const after = yaml ? editYaml(before, edits) : editJson(before, edits)

  const mode = (await stat(target)).mode & 0o777
  const temp = join(dirname(target), `.gamecrate-write-${process.pid}.tmp`)
  await writeFile(temp, after, { mode })
  await chmod(temp, mode)
  await rename(temp, target)
}

function editJson(text: string, edits: ConfigEdit[]): string {
  const formattingOptions = detectIndent(text)
  let out = text
  for (const edit of edits) {
    out = applyEdits(out, modify(out, edit.path, edit.value, { formattingOptions }))
  }
  return out
}

/**
 * `{}` parses as a flow map and setIn keeps that style, so a child added under it collapses the
 * whole branch onto one line. Only maps this edit passed through can have grown, so only those
 * lose the style; a hand-written inline map elsewhere in the file is left alone.
 */
function unflowGrownMaps(doc: Document, path: (string | number)[]): void {
  for (let i = 0; i <= path.length; i++) {
    const node = i === 0 ? doc.contents : doc.getIn(path.slice(0, i))
    if (isMap(node) && node.flow && node.items.length > 0) node.flow = false
  }
}

/**
 * Document.toString re-emits the whole tree from its own options, so this keeps comments,
 * values and quote style while losing the original indentation. That trade is in the spec.
 */
function editYaml(text: string, edits: ConfigEdit[]): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) throw new GamecrateError(doc.errors[0]!.message, Exit.Config)
  for (const edit of edits) {
    if (edit.value === undefined) {
      if (doc.hasIn(edit.path)) doc.deleteIn(edit.path)
    } else {
      doc.setIn(edit.path, edit.value)
      unflowGrownMaps(doc, edit.path)
    }
  }
  // `{}` would make every later write flow-style, so an emptied root empties the file, which
  // loadConfig reads as no config. cost: a leading comment goes with the last key. no json
  // branch, `''` is not valid json and jsonc-parser never reflows `{}` to one line anyway.
  if (isMap(doc.contents) && doc.contents.items.length === 0) return ''
  return String(doc)
}
