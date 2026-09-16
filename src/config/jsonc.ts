import { parse, printParseErrorCode } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import { GamecrateError, Exit } from '../types'

/**
 * JSON with line and block comments and trailing commas. jsonc-parser recovers from
 * syntax errors and still returns a value, so the error list is the only success signal.
 */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: false })
  const first = errors[0]
  if (first !== undefined) {
    throw new GamecrateError(
      'config is not valid JSON',
      Exit.Config,
      `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    )
  }
  return value
}
