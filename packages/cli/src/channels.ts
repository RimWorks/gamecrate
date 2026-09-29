/**
 * Who a chunk came from. A dashboard needs these in different panes, so the caller says which
 * one it is instead of a sink guessing from a file descriptor.
 */
export type Channel = 'data' | 'status' | 'game' | 'gameError'

export interface OutputSink {
  write(channel: Channel, chunk: string | Uint8Array): void
  close(): void
}

export interface OutputRedirect {
  close(): void
}

const TERMINAL: OutputSink = {
  write(channel, chunk) {
    const target = channel === 'status' || channel === 'gameError' ? process.stderr : process.stdout
    target.write(chunk as string)
  },
  close() {},
}

let base: OutputSink = TERMINAL

const BASE: OutputSink = {
  write(channel, chunk) {
    base.write(channel, chunk)
  },
  close() {},
}

let current: OutputSink = BASE

/**
 * Swap what the bottom of the chain is, leaving every decorator over it in place. Returns a
 * handle that puts the old one back.
 */
export function useBaseSink(next: OutputSink): OutputRedirect {
  const previous = base
  base = next
  let open = true
  return {
    close() {
      if (!open) return
      open = false
      base = previous
      next.close()
    },
  }
}

export function emit(channel: Channel, chunk: string | Uint8Array): void {
  current.write(channel, chunk)
}

/** The sink a decorator should delegate to, read at install time, never later. */
export function activeSink(): OutputSink {
  return current
}

export function useSink(next: OutputSink): OutputRedirect {
  const previous = current
  current = next
  let open = true
  return {
    close() {
      if (!open) return
      open = false
      current = previous
      next.close()
    },
  }
}
