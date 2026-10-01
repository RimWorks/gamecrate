/** Four at once: enough to hide io latency, few enough to not fan out into fd or rate limits. */
export const DEFAULT_LANES = 4

/**
 * Runs `work` over `items`, at most `lanes` at a time, and returns results in input order.
 * A `push` from inside a worker would order them by completion instead.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
  lanes = DEFAULT_LANES,
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
  const width = Math.max(1, Math.min(lanes, items.length))
  await Promise.all(Array.from({ length: width }, worker))
  return out
}
