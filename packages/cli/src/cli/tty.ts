const CI_VARS = ['CI', 'BUILD_ID', 'BUILD_NUMBER', 'CI_NAME', 'CONTINUOUS_INTEGRATION', 'RUN_ID']

interface StdoutLike {
  isTTY?: boolean
}

interface StdinLike {
  isTTY?: boolean
}

/** `CI=false` is how someone forces the dashboard on inside a pipeline, so it beats every other var. */
export function inCi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI === 'false' || env.CI === '0') return false
  return CI_VARS.some((name) => env[name] !== undefined)
}

/** A full-screen dashboard needs a real terminal that can address the cursor, and no CI. */
export function dashboardGate(
  env: NodeJS.ProcessEnv = process.env,
  out: StdoutLike = process.stdout,
  input: StdinLike = process.stdin,
): boolean {
  if (out.isTTY !== true) return false
  if (input.isTTY !== true) return false
  if (env.TERM === undefined || env.TERM === '') return false
  if (env.TERM === 'dumb') return false
  return !inCi(env)
}

/** Colour is its own axis: a log file with `FORCE_COLOR` wants it, a TTY with `NO_COLOR` does not. */
export function colourAllowed(
  env: NodeJS.ProcessEnv = process.env,
  out: StdoutLike = process.stdout,
): boolean {
  if ('NO_COLOR' in env) return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  return out.isTTY === true
}

export interface RunShape {
  plain: boolean
  json: boolean
  quiet: boolean
  detach: boolean
  asShell: boolean
  /** A marker run is automation waiting on a string, not someone watching. */
  marker: boolean
  mode: string
}

/** Every reason a run falls back to scrolling output, in one place. */
export function dashboardFor(
  run: RunShape,
  env: NodeJS.ProcessEnv = process.env,
  out: StdoutLike = process.stdout,
  input: StdinLike = process.stdin,
): boolean {
  if (run.plain || run.asShell || run.json || run.quiet || run.detach || run.marker) return false
  if (run.mode !== 'headed') return false
  return dashboardGate(env, out, input)
}
