import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseTree } from 'jsonc-parser'
import { isMap, parse as parseYaml, parseDocument } from 'yaml'

import { GamecrateError, Exit } from '../types'
import { parseJsonc } from './jsonc'

/** Probe order. yaml first: it is what `config edit` writes and what the docs show. */
export const CONFIG_SUFFIXES = ['.yml', '.yaml', '.json', '.jsonc'] as const

function isYaml(path: string): boolean {
  const suffix = extname(path).toLowerCase()
  if (suffix === '.yml' || suffix === '.yaml') return true
  if (suffix === '.json' || suffix === '.jsonc') return false
  throw new GamecrateError(
    `config is not a format gamecrate reads: ${path}`,
    Exit.Config,
    `use one of ${CONFIG_SUFFIXES.join(', ')}`,
  )
}

export function readConfigText(text: string, path: string): unknown {
  if (!isYaml(path)) {
    try {
      return parseJsonc(text)
    } catch (error) {
      if (error instanceof GamecrateError) {
        throw new GamecrateError(`${error.message}: ${path}`, error.code, error.detail)
      }
      throw error
    }
  }
  try {
    return parseYaml(text)
  } catch (error) {
    throw new GamecrateError(`config is invalid: ${path}`, Exit.Config, (error as Error).message)
  }
}

/** Undefined when the file is not there; every other read error propagates. */
export async function readConfigFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return readConfigText(text, path)
}

/**
 * Source order of the keys under one top-level object. Object.keys sorts all-integer keys
 * to the front, and NAME_PATTERN lets a profile be called 2024, so the syntax tree is the
 * only honest answer to "which profile was written first".
 */
export function orderedKeys(text: string, path: string, key: string): string[] {
  if (isYaml(path)) {
    const node = parseDocument(text).get(key, true)
    if (!isMap(node)) return []
    return node.items.map((item) => String((item.key as { value?: unknown }).value ?? item.key))
  }
  const root = parseTree(text)
  const holder = root?.children?.find((child) => child.children?.[0]?.value === key)
  const value = holder?.children?.[1]
  if (value?.type !== 'object') return []
  return (value.children ?? []).map((prop) => String(prop.children?.[0]?.value))
}
