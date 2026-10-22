import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { expandHome } from '../config/load'
import { Exit, GamecrateError } from '../types'

const ROW = /^\s*\d+\s*\|/
const PUBLISHED = /^(\d+)\b/
const TAB_HEADER = 'name\tpackageId\tversion\tactive'
const TAB_HEADERS = new Set([TAB_HEADER, `${TAB_HEADER}\tworkshopId`])
const WORKSHOP_ID = /^\d+$/

/**
 * Reads a mod list dump in file order, either the clipboard dump or the tab separated
 * `ModList.txt` a log viewer writes. Both resolve a row by workshop id when it carries one.
 */
export function readModlist(file: string): string[] {
  const path = resolvePath(expandHome(file))
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new GamecrateError(`cannot read mod list ${path}`, Exit.Usage)
  }

  const lines = text.replace(/^﻿/, '').split('\n').map((line) => line.replace(/\r$/, ''))
  const out = TAB_HEADERS.has(lines[0]?.trim() ?? '') ? tabRows(path, lines) : pipeRows(path, lines)
  if (out.length === 0) throw new GamecrateError(`${path} holds no mod list rows`, Exit.Usage, PIPE_SHAPE)
  return [...new Set(out)]
}

const PIPE_SHAPE = 'each row reads "<index> | <name> | <packageId> | <workshopId>"'
const TAB_SHAPE = `each row reads "${TAB_HEADER}", separated by tabs, with an optional workshopId last`

function pipeRows(path: string, lines: string[]): string[] {
  const out: string[] = []
  for (const [i, line] of lines.entries()) {
    if (!ROW.test(line)) continue
    const fields = line.split('|').map((field) => field.trim())
    while (fields.length > 0 && fields.at(-1) === '') fields.pop()
    if (fields.length < 3) {
      throw new GamecrateError(`${path}:${i + 1} has ${fields.length} field(s)`, Exit.Usage, PIPE_SHAPE)
    }
    const last = fields.at(-1)!
    const published = PUBLISHED.exec(last)
    out.push(published === null ? last : `workshop:${published[1]!}`)
  }
  return out
}

function tabRows(path: string, lines: string[]): string[] {
  const out: string[] = []
  for (const [i, line] of lines.entries()) {
    if (i === 0 || line.trim() === '') continue
    const fields = line.split('\t')
    if (fields.length !== 4 && fields.length !== 5) {
      throw new GamecrateError(`${path}:${i + 1} has ${fields.length} column(s), not 4 or 5`, Exit.Usage, TAB_SHAPE)
    }
    if (fields[3]!.trim() !== 'true') continue
    const id = fields[1]!.trim()
    if (id === '') {
      throw new GamecrateError(`${path}:${i + 1} names no packageId`, Exit.Usage, TAB_SHAPE)
    }
    const published = fields[4]?.trim() ?? 'local'
    if (published !== 'local' && !WORKSHOP_ID.test(published)) {
      throw new GamecrateError(
        `${path}:${i + 1} has workshopId "${published}"`,
        Exit.Usage,
        'a workshopId is digits, or "local" for a mod that has none',
      )
    }
    out.push(published === 'local' ? id : `workshop:${published}`)
  }
  return out
}
