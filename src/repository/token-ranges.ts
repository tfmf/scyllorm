import { types } from 'cassandra-driver';

/** The smallest Murmur3 token; never assigned to a key, so a range starting here excludes nothing. */
const MIN_TOKEN = -(2n ** 63n);
/** The largest Murmur3 token. */
const MAX_TOKEN = 2n ** 63n - 1n;

/** One page of a task's rows, and the cursor to its next page if there is one. */
export interface TaskPage<R> {
    rows: R[];
    pageState?: string;
}

/**
 * Cut the Murmur3 token ring into contiguous ranges that together cover every token.
 *
 * Ranges are `(lo, hi]`; the first starts at the MIN token, which no key hashes to,
 * so the exclusive lower bound loses nothing.
 *
 * @param {number} splits How many ranges to cut the ring into; a positive integer.
 * @returns {Array<[types.Long, types.Long]>} The `[lo, hi]` bounds, in increasing order.
 */
export function splitTokenRing(splits: number): Array<[types.Long, types.Long]> {
    const width = 2n ** 64n;
    const count = BigInt(splits);
    const bounds: bigint[] = [];

    for (let i = 0n; i < count; i++) {
        bounds.push(MIN_TOKEN + (width * i) / count);
    }
    bounds.push(MAX_TOKEN);

    // The driver rejects a bigint as a bind value; a Long is what it takes
    const toLong = (value: bigint): types.Long => types.Long.fromString(value.toString());

    return bounds.slice(0, -1).map((lo, i) => [toLong(lo), toLong(bounds[i + 1])]);
}

/**
 * Read many tasks (each a sequence of pages) at once, yielding pages as they complete.
 *
 * At most `concurrency` tasks are active. A worker that has fetched a page waits until the
 * consumer takes it before fetching the next, so at most `concurrency` fetches are in flight
 * and pages buffered. On a fetch error or an early exit no new fetch starts; in-flight
 * fetches are awaited before the error is thrown or the generator returns.
 *
 * @param {number} taskCount How many tasks there are, numbered from 0.
 * @param {number} concurrency How many tasks to read at once; a positive integer.
 * @param {Function} fetchPage Fetches a task's page, following `pageState` from the previous page.
 * @returns {AsyncIterableIterator<R[]>} The non-empty pages, in completion order.
 * @throws {unknown} The first error a fetch threw.
 */
export async function* streamConcurrent<R>(
    taskCount: number,
    concurrency: number,
    fetchPage: (task: number, pageState: string | undefined) => Promise<TaskPage<R>>
): AsyncIterableIterator<R[]> {
    const buffer: Array<{ rows: R[]; release: () => void }> = [];
    let failure: { error: unknown } | undefined;
    let stopped = false;
    let finished = false;
    let wake: (() => void) | undefined;
    let nextTask = 0;

    const notify = (): void => {
        wake?.();
        wake = undefined;
    };

    // Frees workers parked on a page nobody will take
    const releaseAll = (): void => {
        for (const item of buffer.splice(0)) {
            item.release();
        }
    };

    const worker = async (): Promise<void> => {
        try {
            while (!stopped && nextTask < taskCount) {
                const task = nextTask++;
                let pageState: string | undefined;

                do {
                    const page = await fetchPage(task, pageState);
                    pageState = page.pageState;

                    if (stopped) {
                        return;
                    }
                    if (page.rows.length > 0) {
                        await new Promise<void>((release) => {
                            buffer.push({ rows: page.rows, release });
                            notify();
                        });
                    }
                } while (pageState && !stopped);
            }
        } catch (error) {
            failure ??= { error };
            stopped = true;
            releaseAll();
            notify();
        }
    };

    const workers = Promise.all(Array.from({ length: Math.min(concurrency, taskCount) }, worker)).then(() => {
        finished = true;
        notify();
    });

    try {
        while (!failure) {
            const item = buffer.shift();

            if (item) {
                item.release();
                yield item.rows;
            } else if (finished) {
                return;
            } else {
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        }
    } finally {
        stopped = true;
        releaseAll();
        await workers;
    }

    throw failure.error;
}
