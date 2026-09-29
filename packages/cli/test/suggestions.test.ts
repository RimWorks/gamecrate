import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from '../src/cli/args'

const SRC = join(import.meta.dir, '..', 'src')
// only a real offer: `gamecrate ...` inside backticks, or after `run: ` / `try: `
const OFFER = /(?:`|run: |try: )gamecrate ((?:[a-z][a-z-]*)(?: (?:[a-z][a-z-]*|\$\{[^}]+\}))*)/g

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/** Every `gamecrate ...` this codebase tells a user to run, with the interpolations stripped. */
function offers(): { where: string; argv: string[] }[] {
  const found: { where: string; argv: string[] }[] = []
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const [, shape] of text.matchAll(OFFER)) {
      // an interpolation is an argument; a bare word after one is prose, so the command ends there
      const argv: string[] = []
      let seenValue = false
      for (const word of shape!.trim().split(/\s+/)) {
        const isValue = word.startsWith('${')
        if (!isValue && seenValue) break
        seenValue ||= isValue
        argv.push(isValue ? 'x' : word)
      }
      if (argv.length > 0 && argv[0] !== '') found.push({ where: file.slice(SRC.length + 1), argv })
    }
  }
  return found
}

describe('every command the source suggests', () => {
  const all = offers()

  test('there are suggestions to check', () => {
    expect(all.length).toBeGreaterThan(5)
  })

  // regression: eight suggestions named a positional form the parser had stopped accepting
  test('parses, or fails for a reason that is not the command shape', () => {
    const broken: string[] = []
    for (const { where, argv } of all) {
      try {
        parseArgs(argv, { env: {} })
      } catch (error) {
        const message = (error as Error).message
        if (/unexpected argument|is not a subcommand|does not take/.test(message)) {
          broken.push(`${where}: gamecrate ${argv.join(' ')}  ->  ${message}`)
        }
      }
    }
    expect(broken).toEqual([])
  })
})
