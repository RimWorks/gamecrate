import { describe, expect, test } from 'bun:test'
import { colourAllowed, dashboardFor, dashboardGate, inCi } from '../src/cli/tty'

const TTY = { isTTY: true }
const PIPE = { isTTY: false }

describe('dashboardGate', () => {
  const cases: [string, NodeJS.ProcessEnv, { isTTY?: boolean }, boolean][] = [
    ['a real terminal', { TERM: 'xterm-256color' }, TTY, true],
    ['a pipe', { TERM: 'xterm-256color' }, PIPE, false],
    ['no stdout isTTY at all', { TERM: 'xterm-256color' }, {}, false],
    ['no TERM', {}, TTY, false],
    ['an empty TERM', { TERM: '' }, TTY, false],
    ['TERM=dumb', { TERM: 'dumb' }, TTY, false],
    ['CI=true', { TERM: 'xterm', CI: 'true' }, TTY, false],
    ['CI= empty', { TERM: 'xterm', CI: '' }, TTY, false],
    ['CI=false', { TERM: 'xterm', CI: 'false' }, TTY, true],
    ['CI=0', { TERM: 'xterm', CI: '0' }, TTY, true],
    ['CI=false beating BUILD_ID', { TERM: 'xterm', CI: 'false', BUILD_ID: '42' }, TTY, true],
    ['BUILD_ID alone', { TERM: 'xterm', BUILD_ID: '42' }, TTY, false],
    ['BUILD_NUMBER alone', { TERM: 'xterm', BUILD_NUMBER: '7' }, TTY, false],
    ['CI_NAME alone', { TERM: 'xterm', CI_NAME: 'drone' }, TTY, false],
    ['CONTINUOUS_INTEGRATION alone', { TERM: 'xterm', CONTINUOUS_INTEGRATION: '1' }, TTY, false],
    ['RUN_ID alone', { TERM: 'xterm', RUN_ID: '9' }, TTY, false],
    ['no tty wins over CI', { CI: 'true' }, PIPE, false],
  ]

  for (const [name, env, out, want] of cases) {
    test(name, () => {
      expect(dashboardGate(env, out, TTY)).toBe(want)
    })
  }
})

describe('the keyboard the dashboard needs', () => {
  test('a redirected stdin means no dashboard, whatever stdout is', () => {
    expect(dashboardGate({ TERM: 'xterm' }, { isTTY: true }, { isTTY: true })).toBe(true)
    expect(dashboardGate({ TERM: 'xterm' }, { isTTY: true }, { isTTY: false })).toBe(false)
    expect(dashboardGate({ TERM: 'xterm' }, { isTTY: true }, {})).toBe(false)
  })

  test('dashboardFor carries the stdin check through', () => {
    const headed = { plain: false, json: false, quiet: false, detach: false, asShell: false, marker: false, mode: 'headed' }
    expect(dashboardFor(headed, { TERM: 'xterm' }, { isTTY: true }, { isTTY: true })).toBe(true)
    expect(dashboardFor(headed, { TERM: 'xterm' }, { isTTY: true }, { isTTY: false })).toBe(false)
  })
})

describe('inCi', () => {
  test('an empty env is not CI', () => {
    expect(inCi({})).toBe(false)
  })

  test('CI=false is a hard override, so a pipeline can force the dashboard on', () => {
    expect(inCi({ CI: 'false', RUN_ID: '9' })).toBe(false)
    expect(inCi({ CI: 'true' })).toBe(true)
  })
})

describe('colourAllowed', () => {
  const cases: [string, NodeJS.ProcessEnv, { isTTY?: boolean }, boolean][] = [
    ['a terminal', {}, TTY, true],
    ['a pipe', {}, PIPE, false],
    ['NO_COLOR empty still means off', { NO_COLOR: '' }, TTY, false],
    ['NO_COLOR=1', { NO_COLOR: '1' }, TTY, false],
    ['NO_COLOR beats FORCE_COLOR', { NO_COLOR: '', FORCE_COLOR: '1' }, TTY, false],
    ['FORCE_COLOR=1 with no tty', { FORCE_COLOR: '1' }, PIPE, true],
    ['FORCE_COLOR empty with no tty', { FORCE_COLOR: '' }, PIPE, true],
    ['FORCE_COLOR=0 with no tty', { FORCE_COLOR: '0' }, PIPE, false],
    ['FORCE_COLOR=0 on a tty follows the tty', { FORCE_COLOR: '0' }, TTY, true],
  ]

  for (const [name, env, out, want] of cases) {
    test(name, () => {
      expect(colourAllowed(env, out)).toBe(want)
    })
  }
})

describe('dashboardFor', () => {
  const tty = { isTTY: true }
  const env = { TERM: 'xterm-256color' }
  const headed = {
    plain: false, json: false, quiet: false, detach: false, asShell: false, marker: false, mode: 'headed',
  }

  test('an interactive headed run on a real terminal gets the dashboard', () => {
    expect(dashboardFor(headed, env, tty, tty)).toBe(true)
  })

  const cases: [string, Partial<typeof headed>][] = [
    ['plain', { plain: true }],
    ['shell', { asShell: true }],
    ['json', { json: true }],
    ['quiet', { quiet: true }],
    ['detach', { detach: true }],
    ['marker', { marker: true }],
    ['headless', { mode: 'headless' }],
    ['screenshot', { mode: 'screenshot' }],
  ]
  test.each(cases)('%s falls back to scrolling output', (_name, over) => {
    expect(dashboardFor({ ...headed, ...over }, env, tty, tty)).toBe(false)
  })

  test('a piped stdout falls back even when everything else is right', () => {
    expect(dashboardFor(headed, env, { isTTY: false }, tty)).toBe(false)
  })

  test('CI falls back, and CI=false still gets it', () => {
    expect(dashboardFor(headed, { ...env, CI: 'true' }, tty, tty)).toBe(false)
    expect(dashboardFor(headed, { ...env, CI: 'false' }, tty, tty)).toBe(true)
  })

  test('the flag beats the gate', () => {
    expect(dashboardFor({ ...headed, plain: true }, env, tty, tty)).toBe(false)
  })

  test('shell never gets it, even on a perfect terminal', () => {
    expect(dashboardFor({ ...headed, asShell: true }, env, tty, tty)).toBe(false)
  })
})
