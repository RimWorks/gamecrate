import type { ParsedArgs, ProjectDefaults } from '../types'

/**
 * Not in parseArgs: filling a default there would erase the difference between a typed
 * profile and a defaulted one, which clean and fix-perms both need.
 */
export function profileOf(args: ParsedArgs, defaults: ProjectDefaults): string {
  return args.profile ?? defaults.defaultProfile ?? defaults.profileOrder?.[0] ?? 'modless'
}
