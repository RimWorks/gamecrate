import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { expandHome } from '../config/load'
import { Exit, GamecrateError } from '../types'

const ROW = /^\s*\d+\s*\|/
const TAIL = /\|\s*(\S+)\s*\|\s*(\d+)\s*$/

/**
 * Reads `<index> | <name> | <packageId> | <workshopId>` rows into `workshop:<id>` entries, in
 * file order. A mod name can hold a `|`, so the last two fields are read from the line's end.
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
    const found = TAIL.exec(line)
    if (found === null) {
      throw new GamecrateError(`${path}:${i + 1} names no packageId and workshop id`, Exit.Usage, shape)
    }
    out.push(`workshop:${found[2]!}`)
  }

  if (out.length === 0) throw new GamecrateError(`${path} holds no mod list rows`, Exit.Usage, shape)
  return [...new Set(out)]
}
