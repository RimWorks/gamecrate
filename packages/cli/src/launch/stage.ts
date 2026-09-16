import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { GamecrateError, Exit } from '../types'
import type { LaunchPlan, Mount } from '../types'

/**
 * Wipes and rebuilds the staging tree, returning one read-only bind per mod.
 * Never creates a symlink: a host symlink into a mod checkout dangles inside the container.
 */
export async function stageMods(plan: LaunchPlan): Promise<Mount[]> {
  await rm(plan.stageDirHost, { recursive: true, force: true })
  await mkdir(plan.stageDirHost, { recursive: true })

  const mounts: Mount[] = []
  for (const mod of plan.mods) {
    // Core and the official expansions already live inside the game-files mount.
    if (mod.kind === 'core' || mod.kind === 'official') continue
    let source: string
    try {
      source = await realpath(mod.hostDir)
    } catch {
      throw new GamecrateError(
        `mod directory for ${mod.packageId} is missing`,
        Exit.Environment,
        mod.hostDir,
      )
    }
    if (!(await stat(source)).isDirectory()) {
      throw new GamecrateError(`${mod.packageId} does not resolve to a directory`, Exit.Environment, source)
    }
    await mkdir(join(plan.stageDirHost, basename(mod.containerDir)), { recursive: true })
    mounts.push({ type: 'bind', source, target: mod.containerDir, readonly: true })
  }
  return mounts
}

/** Pre-creates the profile skeleton as the caller, before docker can create it as root. */
export async function ensureProfileTree(plan: LaunchPlan): Promise<void> {
  for (const dir of [
    plan.profileDir,
    plan.instanceDir,
    plan.dataDirHost,
    // .NET's GetFolderPath returns "" for a directory that does not exist, so an app asking
    // for LocalApplicationData on an empty HOME gets nothing back. Create them, do not just
    // point at them.
    join(plan.configDirHost, 'config'),
    join(plan.configDirHost, 'data'),
    join(plan.configDirHost, 'cache'),
    join(plan.logsDirHost, 'runs'),
    plan.stageDirHost,
    join(plan.instanceDir, '.gamecrate'),
    ...engineDirs(plan),
  ]) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * Bind-mount targets docker would otherwise create as root. A mods dir can sit inside
 * the data dir, so a missing one comes back root-owned and blocks the next run.
 */
function engineDirs(plan: LaunchPlan): string[] {
  const { dataDir, modsDir } = plan.gameConfig
  if (!modsDir.container.startsWith(`${dataDir.container}/`)) return []
  return [join(plan.dataDirHost, modsDir.container.slice(dataDir.container.length + 1))]
}


/**
 * Walks with lstat semantics, so a dangling symlink inside a mounted tree is reported
 * rather than thrown. Stops once `limit` foreign paths are found.
 */
export async function detectForeignOwnership(dir: string, uid: number, limit = 100): Promise<string[]> {
  const foreign: string[] = []
  const queue = [dir]
  while (queue.length > 0 && foreign.length < limit) {
    const current = queue.shift()!
    let info
    try {
      info = await lstat(current)
    } catch {
      continue
    }
    if (info.uid !== uid) {
      foreign.push(current)
      if (foreign.length >= limit) break
    }
    if (!info.isDirectory()) continue
    try {
      for (const entry of await readdir(current)) queue.push(join(current, entry))
    } catch {
      continue
    }
  }
  return foreign
}
