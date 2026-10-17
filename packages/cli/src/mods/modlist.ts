import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { expandHome } from '../config/load'
import { Exit, GamecrateError } from '../types'

const ROW = /^\s*\d+\s*\|/
const PUBLISHED = /^(\d+)\b/

/**
 * Reads a mod list dump in file order. A row ending in a workshop id resolves by that id, and a
 * row without one, which is what Core, the DLC and a local mod look like, resolves by packageId.
 */
export function readModlist(file: string): string[] {
  const path = resolvePath(expandHome(file))
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new GamecrateError(`cannot read mod list ${path}`, Exit.Usage)
  }

  const shape = 'each row reads "<index> | <name> | <packageId> | <workshopId>"'
  const out: string[] = []
  for (const [i, line] of text.split('\n').entries()) {
    if (!ROW.test(line)) continue
    const fields = line.split('|').map((field) => field.trim())
    while (fields.length > 0 && fields.at(-1) === '') fields.pop()
    if (fields.length < 3) {
      throw new GamecrateError(`${path}:${i + 1} has ${fields.length} field(s)`, Exit.Usage, shape)
    }
    const last = fields.at(-1)!
    const published = PUBLISHED.exec(last)
    out.push(published === null ? last : `workshop:${published[1]!}`)
  }

  if (out.length === 0) throw new GamecrateError(`${path} holds no mod list rows`, Exit.Usage, shape)
  return [...new Set(out)]
}
