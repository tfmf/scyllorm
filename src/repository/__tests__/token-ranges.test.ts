import { describe, it, expect } from 'vitest';
import { types } from 'cassandra-driver';
import { splitTokenRing, streamConcurrent, TaskPage } from '../token-ranges';

const MIN = '-9223372036854775808';
const MAX = '9223372036854775807';

describe('splitTokenRing', () => {
    it.each([1, 2, 3, 7])('cuts the ring into %i contiguous increasing ranges', (splits) => {
        const ranges = splitTokenRing(splits);

        expect(ranges).toHaveLength(splits);
        expect(ranges[0][0].toString()).toBe(MIN);
        expect(ranges[splits - 1][1].toString()).toBe(MAX);
        for (const [lo, hi] of ranges) {
            expect(lo).toBeInstanceOf(types.Long);
            expect(hi).toBeInstanceOf(types.Long);
            expect(lo.lessThan(hi)).toBe(true);
        }
        for (let i = 1; i < splits; i++) {
            expect(ranges[i][0].equals(ranges[i - 1][1])).toBe(true);
        }
    });

    it('cuts 2 splits at zero', () => {
        expect(splitTokenRing(2).map(([lo, hi]) => [lo.toString(), hi.toString()])).toEqual([
            [MIN, '0'],
            ['0', MAX],
        ]);
    });

    it('cuts 1 split into the whole ring', () => {
        expect(splitTokenRing(1).map(([lo, hi]) => [lo.toString(), hi.toString()])).toEqual([[MIN, MAX]]);
    });
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

async function collect<R>(iterator: AsyncIterableIterator<R[]>): Promise<R[][]> {
    const pages: R[][] = [];
    for await (const page of iterator) {
        pages.push(page);
    }
    return pages;
}

describe('streamConcurrent', () => {
    it('yields every page of every task, following pageState sequentially', async () => {
        const seen: Array<[number, string | undefined]> = [];
        const pages = await collect(
            streamConcurrent<string>(3, 2, async (task, pageState) => {
                seen.push([task, pageState]);
                await tick();
                const n = pageState === undefined ? 0 : Number(pageState);
                return { rows: [`${task}:${n}`], pageState: n < 2 ? String(n + 1) : undefined };
            })
        );

        expect(pages.flat().sort()).toEqual(['0:0', '0:1', '0:2', '1:0', '1:1', '1:2', '2:0', '2:1', '2:2']);
        // A task's pages are requested in order, each with the previous cursor
        for (let task = 0; task < 3; task++) {
            expect(seen.filter(([t]) => t === task).map(([, s]) => s)).toEqual([undefined, '1', '2']);
        }
    });

    it('never has more than `concurrency` tasks active, and starts the next task when one ends', async () => {
        let active = 0;
        let peak = 0;
        const started: number[] = [];
        const pages = await collect(
            streamConcurrent<number>(6, 2, async (task) => {
                started.push(task);
                active++;
                peak = Math.max(peak, active);
                await tick();
                active--;
                return { rows: [task] };
            })
        );

        expect(peak).toBe(2);
        expect(started.slice(0, 2)).toEqual([0, 1]);
        expect(pages.flat().sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('does not fetch ahead of a consumer that is not taking pages', async () => {
        let fetches = 0;
        const iterator = streamConcurrent<number>(10, 2, async (task) => {
            fetches++;
            return { rows: [task], pageState: 'more' };
        });

        await iterator.next();
        await tick();
        await tick();
        // One page taken: its worker fetched once more, the other is parked on its first page
        const before = fetches;
        expect(before).toBeLessThanOrEqual(4);
        await tick();
        expect(fetches).toBe(before);
        await iterator.return?.(undefined);
    });

    it('skips empty pages but still follows their pageState', async () => {
        const pages = await collect(
            streamConcurrent<number>(2, 2, async (task, pageState) => {
                if (pageState === undefined) {
                    return { rows: [], pageState: 'next' };
                }
                return { rows: task === 0 ? [1] : [] };
            })
        );

        expect(pages).toEqual([[1]]);
    });

    it('yields nothing for zero tasks', async () => {
        expect(await collect(streamConcurrent<number>(0, 4, async () => ({ rows: [1] })))).toEqual([]);
    });

    it('awaits in-flight fetches, starts none, then throws the first error', async () => {
        const started: number[] = [];
        let slowSettled = false;
        const iterator = streamConcurrent<number>(5, 2, async (task) => {
            started.push(task);
            if (task === 0) {
                await tick();
                throw new Error('boom');
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
            slowSettled = true;
            return { rows: [task] };
        });

        await expect(iterator.next()).rejects.toThrow('boom');
        expect(slowSettled).toBe(true);
        expect(started).toEqual([0, 1]);
    });

    it('throws the first error when several fetches fail', async () => {
        const iterator = streamConcurrent<number>(2, 2, async (task) => {
            await new Promise((resolve) => setTimeout(resolve, task === 0 ? 1 : 10));
            throw new Error(`fail ${task}`);
        });

        await expect(iterator.next()).rejects.toThrow('fail 0');
    });

    it('stops cleanly on early exit, awaiting in-flight fetches', async () => {
        const started: number[] = [];
        let settled = 0;
        const fetchPage = async (task: number): Promise<TaskPage<number>> => {
            started.push(task);
            await new Promise((resolve) => setTimeout(resolve, task === 0 ? 1 : 20));
            settled++;
            return { rows: [task], pageState: 'more' };
        };

        for await (const page of streamConcurrent<number>(10, 3, fetchPage)) {
            expect(page).toEqual([0]);
            break;
        }

        // Everything started has settled by the time the loop is left, and nothing new starts
        expect(settled).toBe(started.length);
        const count = started.length;
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(started).toHaveLength(count);
    });
});
