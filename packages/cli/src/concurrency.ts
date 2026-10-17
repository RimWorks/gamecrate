/** Eight at once: enough to hide io latency, few enough to not fan out into fd or rate limits. */
export const DEFAULT_LANES = 8

let lanes = DEFAULT_LANES

/** Sets the fan-out width every `mapLimit` takes by default. Config's `fetchConcurrency`. */
export function setLanes(width: number | undefined): void {
  lanes = width === undefined ? DEFAULT_LANES : Math.max(1, Math.floor(width))
}

/** The current fan-out width, for a caller that has to report or cap against it. */
export function currentLanes(): number {
  return lanes
}

/**
 * Runs `work` over `items`, at most `lanes` at a time, and returns results in input order.
 * A `push` from inside a worker would order them by completion instead.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
  width = lanes,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await work(items[index]!, index)
    }
  }
  const count = Math.max(1, Math.min(width, items.length))
  await Promise.all(Array.from({ length: count }, worker))
  return out
}
