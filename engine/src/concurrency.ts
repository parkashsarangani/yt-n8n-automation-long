/**
 * Bounded-concurrency helpers.
 *
 * Long-form work fans out wide — 40 to 80 images per video — so nothing may
 * run unbounded. The predecessor pipeline OOMed a 6 GB box by building every
 * scene at once; this exists so that failure mode cannot recur here.
 */

/** Map with at most `limit` in flight. Rejects on the first failure. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker),
  );
  return results;
}

export type Settled<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown };

/**
 * Like `mapWithConcurrency` but never throws mid-flight: every item settles, so
 * siblings are not abandoned half-finished when one fails.
 */
export async function mapSettledWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  return mapWithConcurrency(items, limit, async (item, i) => {
    try {
      return { status: "fulfilled" as const, value: await fn(item, i) };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  });
}
