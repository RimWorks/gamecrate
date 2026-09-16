import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

import { expandHome } from '../config/load'
import type { Problem, WorktreeRequest, WorktreeSource } from '../types'

/**
 * One spawn answers every question: where the tree starts, whether it is linked, and what
 * branch it is on. `gitDir !== gitCommonDir` is the exact linked-worktree test.
 */
function inspect(dir: string): { toplevel: string; gitDir: string; gitCommonDir: string; branch: string } | null {
  const r = spawnSync(
    'git',
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'],
    { encoding: 'utf8' },
  )
  if (r.status !== 0 || typeof r.stdout !== 'string') return null
  const lines = r.stdout.trim().split('\n')
  if (lines.length < 4) return null
  const [toplevel, gitDir, gitCommonDir, branch] = lines as [string, string, string, string]
  return { toplevel, gitDir, gitCommonDir, branch }
}

function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Resolves one worktree request. Returns null when `dir` is not inside a LINKED worktree,
 * which is what keeps a primary checkout, a non-repo directory and a pruned gitdir from
 * counting as a selection.
 */
export function resolveWorktree(dir: string, source: WorktreeSource, order: number): WorktreeRequest | Problem {
  const raw = expandHome(dir)
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)

  if (!existsSync(abs)) {
    return { where: abs, message: `--worktree path does not exist`, suggestion: 'check the path, or drop the flag' }
  }

  const info = inspect(abs)
  if (info === null) {
    return source === 'cwd'
      ? { where: abs, message: 'not a git repository', suggestion: 'ignored' }
      : { where: abs, message: 'not a git repository, or its gitdir has been pruned', suggestion: 'run `git worktree prune` in the parent repo' }
  }

  if (info.gitDir === info.gitCommonDir) {
    return source === 'cwd'
      ? { where: abs, message: 'primary checkout, not a linked worktree', suggestion: 'ignored' }
      : {
          where: abs,
          message: 'is the primary checkout, not a linked worktree',
          suggestion: 'nothing to promote; drop --worktree',
        }
  }

  return { root: canonical(info.toplevel), branch: info.branch, source, order }
}

/** True when `dir` is the worktree root or lives underneath it. */
export function contains(request: WorktreeRequest, dir: string): boolean {
  const target = canonical(dir)
  return target === request.root || target.startsWith(request.root + sep)
}

/**
 * Assembles every request in precedence order: explicit flags first (left to right), then the
 * env var, then cwd. Only a linked worktree survives; everything else becomes an ignorable
 * Problem so the caller can decide how loudly to say so.
 */
export function collectRequests(
  flags: string[],
  env: string | undefined,
  cwd: string,
  disabled: boolean,
): { requests: WorktreeRequest[]; problems: Problem[] } {
  if (disabled) return { requests: [], problems: [] }

  const requests: WorktreeRequest[] = []
  const problems: Problem[] = []
  let order = 0

  const add = (dir: string, source: WorktreeSource): void => {
    const got = resolveWorktree(dir, source, order)
    if ('root' in got) {
      // A directory named twice is one request, at its strongest position.
      if (!requests.some((r) => r.root === got.root)) {
        requests.push(got)
        order += 1
      }
    } else if (source !== 'cwd') {
      problems.push(got)
    }
  }

  for (const f of flags) add(f, 'flag')
  if (env !== undefined && env !== '' && env !== 'off') add(env, 'env')
  add(cwd, 'cwd')

  return { requests, problems }
}
