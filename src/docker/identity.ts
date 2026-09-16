import { userInfo } from 'node:os'
import type { Identity } from '../types'

/**
 * The single source of truth for `--user`, HOME, and every tmpfs uid=/gid=.
 * Out-of-sync values give a blank window with no error, so nothing else may guess.
 */
export function resolveIdentity(useRoot: boolean): Identity {
  if (useRoot) return { uid: 0, gid: 0, home: '/root', user: 'root' }

  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  return { uid, gid, home: '/tmp/home', user: hostUserName(uid) }
}

/** Neither image has a passwd entry for uid 1000, so USER/LOGNAME must be stated. */
function hostUserName(uid: number): string {
  try {
    const name = userInfo().username
    if (name) return name
  } catch {
    // No passwd entry for the caller either; fall through to the env.
  }
  return process.env.USER ?? process.env.LOGNAME ?? `uid-${uid}`
}
