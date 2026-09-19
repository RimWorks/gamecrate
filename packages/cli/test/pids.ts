/** Shared so a test needing an unused pid does not hardcode one pid_max can hand out. */
export function deadPid(): number {
  return deadPids(1)[0]!
}

/** `deadPid() - 1` is not a second dead pid: nothing looked at it. Ask for both instead. */
export function deadPids(count: number): number[] {
  const out: number[] = []
  for (let pid = 2 ** 22 - 1; pid > 2 && out.length < count; pid--) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') out.push(pid)
    }
  }
  if (out.length < count) throw new Error(`fewer than ${count} unused pids on this machine`)
  return out
}
