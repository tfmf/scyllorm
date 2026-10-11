import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { types } from 'cassandra-driver';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { ColumnValidationError, InvalidQueryError } from '../../errors';
import { Append, Prepend, Remove, PutKeys, RemoveKeys, CollectionUpdate, UpdateValues } from '../query-utils';
import * as publicApi from '../../index';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: the real value types (`types.Long`, `types.Uuid`, ...) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

const validate = vi.fn(() => false);
const transformerTo = vi.fn((value: unknown) => {
    throw new Error(`transformer.to must not run on a collection operand: ${String(value)}`);
});

@Entity('collection_items')
class CollectionItem extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('LIST', { of: 'TEXT' })
    tags: string[];

    @Column('SET', { of: 'INT' })
    nums: Set<number>;

    @Column('MAP', { of: ['TEXT', 'INT'] })
    attrs: Record<string, number>;

    @Column('TEXT')
    label: string;

    @Column('FROZEN')
    frozen: unknown;

    @Column('COUNTER')
    hits: number;

    // Both hooks would blow up if a collection operand went through them
    @Column('LIST', { of: 'TEXT', validate, transformer: { to: transformerTo, from: (v: unknown) => v } })
    guarded: string[];
}

function setup() {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[]; options: Record<string, unknown> }> = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(
        async (query: string, params: unknown[], options: Record<string, unknown>) => {
            executed.push({ query, params, options });
            return [] as never;
        }
    );

    const repo = ds.getRepository(CollectionItem) as Repository<CollectionItem>;

    return { repo, executed };
}

const where = { id: 'k' };

describe('collection updates: exports', () => {
    it('exports the helpers and CollectionUpdate from the package index', () => {
        expect(publicApi.Append).toBe(Append);
        expect(publicApi.Prepend).toBe(Prepend);
        expect(publicApi.Remove).toBe(Remove);
        expect(publicApi.PutKeys).toBe(PutKeys);
        expect(publicApi.RemoveKeys).toBe(RemoveKeys);
        expect(publicApi.CollectionUpdate).toBe(CollectionUpdate);
    });

    it('builds CollectionUpdate instances carrying the operation and operand', () => {
        const operand = ['a'];

        for (const [update, operation] of [
            [Append(operand), 'Append'],
            [Prepend(operand), 'Prepend'],
            [Remove(operand), 'Remove'],
            [PutKeys({ a: 1 }), 'PutKeys'],
            [RemoveKeys(operand), 'RemoveKeys'],
        ] as const) {
            expect(update).toBeInstanceOf(CollectionUpdate);
            expect(update.operation).toBe(operation);
        }
        expect(Append(operand).value).toBe(operand);
    });
});

describe('collection updates: rendering via update()', () => {
    beforeEach(() => {
        validate.mockClear();
        transformerTo.mockClear();
    });

    it.each([
        [
            'Append on a LIST',
            { tags: Append(['a', 'b']) },
            'UPDATE collection_items SET tags = tags + ? WHERE id = ?',
            [['a', 'b']],
        ],
        [
            'Prepend on a LIST',
            { tags: Prepend(['a']) },
            'UPDATE collection_items SET tags = ? + tags WHERE id = ?',
            [['a']],
        ],
        [
            'Remove on a LIST',
            { tags: Remove(['a']) },
            'UPDATE collection_items SET tags = tags - ? WHERE id = ?',
            [['a']],
        ],
        [
            'Append on a SET (array)',
            { nums: Append([1, 2]) },
            'UPDATE collection_items SET nums = nums + ? WHERE id = ?',
            [[1, 2]],
        ],
        [
            'Append on a SET (Set)',
            { nums: Append(new Set([1])) },
            'UPDATE collection_items SET nums = nums + ? WHERE id = ?',
            [new Set([1])],
        ],
        ['Remove on a SET', { nums: Remove([3]) }, 'UPDATE collection_items SET nums = nums - ? WHERE id = ?', [[3]]],
        [
            'PutKeys on a MAP',
            { attrs: PutKeys({ a: 1 }) },
            'UPDATE collection_items SET attrs = attrs + ? WHERE id = ?',
            [{ a: 1 }],
        ],
        [
            'RemoveKeys on a MAP (array)',
            { attrs: RemoveKeys(['a']) },
            'UPDATE collection_items SET attrs = attrs - ? WHERE id = ?',
            [['a']],
        ],
        [
            'RemoveKeys on a MAP (Set)',
            { attrs: RemoveKeys(new Set(['a'])) },
            'UPDATE collection_items SET attrs = attrs - ? WHERE id = ?',
            [new Set(['a'])],
        ],
    ])('%s', async (_name, values, query, operandParams) => {
        const { repo, executed } = setup();
        await repo.update(where, values as UpdateValues<CollectionItem>);

        expect(executed[0].query).toBe(query);
        expect(executed[0].params).toEqual([...operandParams, 'k']);
    });

    it('binds the operand by identity, unchanged', async () => {
        const { repo, executed } = setup();
        const operand = ['a'];
        await repo.update(where, { tags: Append(operand) });

        expect(executed[0].params[0]).toBe(operand);
    });

    it('allows empty operands (the server treats them as no-ops)', async () => {
        const { repo, executed } = setup();
        await repo.update(where, { tags: Append([]), nums: Remove([]), attrs: PutKeys({}) });

        expect(executed[0].query).toBe(
            'UPDATE collection_items SET tags = tags + ?, nums = nums - ?, attrs = attrs + ? WHERE id = ?'
        );
        expect(executed[0].params).toEqual([[], [], {}, 'k']);

        await repo.update(where, { attrs: RemoveKeys([]) });
        await repo.update(where, { attrs: RemoveKeys(new Set()) });
        expect(executed[1].params).toEqual([[], 'k']);
        expect(executed[2].params).toEqual([new Set(), 'k']);
    });

    it('mixes collection updates with plain assignments, in the order given', async () => {
        const { repo, executed } = setup();
        await repo.update(where, { label: 'x', tags: Prepend(['a']), nums: new Set([9]), attrs: PutKeys({ k: 2 }) });

        expect(executed[0].query).toBe(
            'UPDATE collection_items SET label = ?, tags = ? + tags, nums = ?, attrs = attrs + ? WHERE id = ?'
        );
        expect(executed[0].params).toEqual(['x', ['a'], new Set([9]), { k: 2 }, 'k']);
    });

    it('lets a plain assignment null a collection (tombstone) next to a collection update', async () => {
        const { repo, executed } = setup();
        await repo.update(where, { tags: null as never, nums: Append([1]) });

        expect(executed[0].query).toBe('UPDATE collection_items SET tags = ?, nums = nums + ? WHERE id = ?');
        expect(executed[0].params).toEqual([null, [1], 'k']);
    });

    it('puts USING TTL / TIMESTAMP params ahead of the operand', async () => {
        const { repo, executed } = setup();
        await repo.update(where, { label: 'x', tags: Append(['a']) }, { ttl: 60, timestamp: 1700000000000000 });

        expect(executed[0].query).toBe(
            'UPDATE collection_items USING TTL ? AND TIMESTAMP ? SET label = ?, tags = tags + ? WHERE id = ?'
        );
        expect(executed[0].params).toEqual([60, types.Long.fromNumber(1700000000000000), 'x', ['a'], 'k']);

        await repo.update(where, { nums: Append([1]) }, { ttl: 5 });
        expect(executed[1].query).toBe('UPDATE collection_items USING TTL ? SET nums = nums + ? WHERE id = ?');
        expect(executed[1].params).toEqual([5, [1], 'k']);
    });

    it('does not run validate or transformer.to on the operand', async () => {
        const { repo, executed } = setup();
        await repo.update(where, { guarded: Append(['a']) });

        expect(executed[0].query).toBe('UPDATE collection_items SET guarded = guarded + ? WHERE id = ?');
        expect(executed[0].params).toEqual([['a'], 'k']);
        expect(validate).not.toHaveBeenCalled();
        expect(transformerTo).not.toHaveBeenCalled();
    });

    it('still runs validate and transformer.to on a plain whole-value assignment', async () => {
        const { repo } = setup();

        // validate always returns false, transformer.to always throws: the whole-value path reaches them
        await expect(repo.update(where, { guarded: ['a'] })).rejects.toThrow('transformer.to must not run');
        expect(transformerTo).toHaveBeenCalledTimes(1);
    });
});

describe('collection updates: updateIfExists() and updateStatement()', () => {
    it('updateIfExists renders IF EXISTS after a collection assignment', async () => {
        const { repo, executed } = setup();
        await repo.updateIfExists(where, { tags: Append(['a']), label: 'x' });

        expect(executed[0].query).toBe('UPDATE collection_items SET tags = tags + ?, label = ? WHERE id = ? IF EXISTS');
        expect(executed[0].params).toEqual([['a'], 'x', 'k']);
    });

    it('updateIfExists keeps passing isIdempotent: false, for every operation', async () => {
        const { repo, executed } = setup();
        await repo.updateIfExists(where, { tags: Append(['a']) });
        await repo.updateIfExists(where, { nums: Append([1]) });
        await repo.updateIfExists(where, { attrs: PutKeys({ a: 1 }) });

        expect(executed.map((e) => e.options.isIdempotent)).toEqual([false, false, false]);
    });

    it('updateStatement renders the same CQL and params without running anything', () => {
        const { repo, executed } = setup();
        const statement = repo.updateStatement(where, { tags: Prepend(['a']) }, { ttl: 9 });

        expect(statement.query).toBe('UPDATE collection_items USING TTL ? SET tags = ? + tags WHERE id = ?');
        expect(statement.params).toEqual([9, ['a'], 'k']);
        expect(executed).toHaveLength(0);
    });

    it('rejects a bad collection update in updateStatement and updateIfExists too', async () => {
        const { repo } = setup();

        expect(() => repo.updateStatement(where, { nums: Prepend([1]) })).toThrow(InvalidQueryError);
        await expect(repo.updateIfExists(where, { label: Append(['a']) })).rejects.toThrow(InvalidQueryError);
    });
});

describe('collection updates: type matrix', () => {
    const helpers = {
        Append: (v: unknown) => Append(v as never),
        Prepend: (v: unknown) => Prepend(v as never),
        Remove: (v: unknown) => Remove(v as never),
        PutKeys: (v: unknown) => PutKeys(v as never),
        RemoveKeys: (v: unknown) => RemoveKeys(v as never),
    };
    const allowed: Record<string, string[]> = {
        Append: ['LIST', 'SET'],
        Prepend: ['LIST'],
        Remove: ['LIST', 'SET'],
        PutKeys: ['MAP'],
        RemoveKeys: ['MAP'],
    };
    const columns = { tags: 'LIST', nums: 'SET', attrs: 'MAP', label: 'TEXT', frozen: 'FROZEN' } as const;
    const phrase: Record<string, string> = {
        Append: 'applies to a LIST or SET.',
        Prepend: 'applies to a LIST.',
        Remove: 'applies to a LIST or SET.',
        PutKeys: 'applies to a MAP.',
        RemoveKeys: 'applies to a MAP.',
    };
    const cases = Object.entries(helpers).flatMap(([operation, helper]) =>
        Object.entries(columns)
            .filter(([, type]) => !allowed[operation].includes(type))
            .map(([column, type]) => [operation, column, type, helper] as const)
    );

    it.each(cases)('%s on %s (%s) is rejected before reaching the server', async (operation, column, type, helper) => {
        const { repo, executed } = setup();
        const run = () => repo.update(where, { [column]: helper([]) } as never);

        await expect(run()).rejects.toBeInstanceOf(InvalidQueryError);
        await expect(run()).rejects.toThrow(
            `Cannot apply ${operation}() to column "${column}" on entity CollectionItem`
        );
        await expect(run()).rejects.toThrow(`it is a ${type} column`);
        await expect(run()).rejects.toThrow(phrase[operation]);
        expect(executed).toHaveLength(0);
    });

    it('covers the full matrix (Prepend on SET, Append on MAP, PutKeys on LIST, anything on TEXT/FROZEN)', () => {
        const names = cases.map(([operation, column]) => `${operation}:${column}`);

        expect(names).toContain('Prepend:nums');
        expect(names).toContain('Append:attrs');
        expect(names).toContain('PutKeys:tags');
        for (const operation of Object.keys(helpers)) {
            expect(names).toContain(`${operation}:label`);
            expect(names).toContain(`${operation}:frozen`);
        }
    });

    it('checks the column type before the operand, so Append(null) on TEXT is a type error', async () => {
        const { repo } = setup();

        await expect(repo.update(where, { label: Append(null as never) })).rejects.toThrow('it is a TEXT column');
    });

    it('reports an invalidCollectionUpdate with the thrown error class from updateStatement', () => {
        const { repo } = setup();

        expect(() => repo.updateStatement(where, { attrs: Append(['a']) as never })).toThrow(
            /Cannot apply Append\(\) to column "attrs" on entity CollectionItem: it is a MAP column/
        );
    });
});

describe('collection updates: operand validation', () => {
    it.each([
        ['Append', 'tags', null],
        ['Append', 'tags', undefined],
        ['Prepend', 'tags', null],
        ['Remove', 'nums', undefined],
        ['PutKeys', 'attrs', null],
        ['RemoveKeys', 'attrs', undefined],
    ])('%s(%s) on %s is a null operand', async (operation, column, operand) => {
        const { repo, executed } = setup();
        const helper = { Append, Prepend, Remove, PutKeys, RemoveKeys }[operation as 'Append'];
        const run = () => repo.update(where, { [column]: helper(operand as never) } as never);

        await expect(run()).rejects.toBeInstanceOf(InvalidQueryError);
        await expect(run()).rejects.toThrow(`${operation}() on column "${column}" on entity CollectionItem`);
        await expect(run()).rejects.toThrow('was given null or undefined');
        expect(executed).toHaveLength(0);
    });

    it.each([
        ['Append', 'tags', 'text'],
        ['Append', 'tags', { a: 1 }],
        ['Append', 'tags', 5],
        ['Prepend', 'tags', 'text'],
        ['Remove', 'tags', { a: 1 }],
        ['Append', 'nums', 'text'],
        ['Append', 'nums', { a: 1 }],
        ['Remove', 'nums', 5],
        ['PutKeys', 'attrs', ['a']],
        ['PutKeys', 'attrs', 'text'],
        ['PutKeys', 'attrs', 5],
        ['RemoveKeys', 'attrs', 'text'],
        ['RemoveKeys', 'attrs', { a: 1 }],
        ['RemoveKeys', 'attrs', 5],
    ])('%s on %s rejects the wrong operand shape %j with ColumnValidationError', async (operation, column, operand) => {
        const { repo, executed } = setup();
        const helper = { Append, Prepend, Remove, PutKeys, RemoveKeys }[operation as 'Append'];
        const run = () => repo.update(where, { [column]: helper(operand as never) } as never);

        await expect(run()).rejects.toBeInstanceOf(ColumnValidationError);
        await expect(run()).rejects.toThrow(`column "${column}"`);
        await expect(run()).rejects.toThrow('CollectionItem');
        expect(executed).toHaveLength(0);
    });

    it('accepts an Array or a Set for SET operands and for RemoveKeys', async () => {
        const { repo, executed } = setup();

        await repo.update(where, { nums: Append(new Set([1])) });
        await repo.update(where, { nums: Remove(new Set([1])) });
        await repo.update(where, { attrs: RemoveKeys(['a']) });
        await repo.update(where, { attrs: RemoveKeys(new Set(['a'])) });

        expect(executed).toHaveLength(4);
    });

    // The driver encodes a LIST from an array only, so a Set would fail a round trip away
    it.each([
        ['Append', () => Append(new Set(['a']))],
        ['Prepend', () => Prepend(new Set(['a']) as never)],
        ['Remove', () => Remove(new Set(['a']))],
    ])('rejects a Set operand for %s on a LIST with ColumnValidationError', async (_name, build) => {
        const { repo, executed } = setup();

        await expect(repo.update(where, { tags: build() })).rejects.toBeInstanceOf(ColumnValidationError);
        await expect(repo.update(where, { tags: build() })).rejects.toThrow('an Array');
        expect(() => repo.updateStatement(where, { tags: build() })).toThrow(ColumnValidationError);
        expect(executed).toHaveLength(0);
    });

    it('checks PutKeys against the MAP predicate (any non-array object), not the SET one', async () => {
        const { repo } = setup();

        await expect(repo.update(where, { attrs: PutKeys(new Set(['a']) as never) })).resolves.toBeUndefined();
    });

    it('treats a hand-built CollectionUpdate with an unknown operation as an unsupported operator', async () => {
        const { repo, executed } = setup();
        const bogus = new CollectionUpdate('Nope' as never, []);

        await expect(repo.update(where, { tags: bogus as never })).rejects.toBeInstanceOf(InvalidQueryError);
        await expect(repo.update(where, { tags: bogus as never })).rejects.toThrow(
            'Unsupported operator "Nope" on column "tags" of entity CollectionItem'
        );
        expect(() => repo.updateStatement(where, { tags: bogus as never })).toThrow(InvalidQueryError);
        expect(executed).toHaveLength(0);
    });

    it('does not resolve inherited Object.prototype names as operations', async () => {
        const { repo } = setup();

        for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
            await expect(
                repo.update(where, { tags: new CollectionUpdate(name as never, []) as never })
            ).rejects.toThrow(/Unsupported operator/);
        }
    });
});

describe('collection updates: checks that run first', () => {
    it('rejects a primary key column before looking at the collection update', async () => {
        const { repo } = setup();

        await expect(repo.update(where, { id: Append([]) } as never)).rejects.toThrow(
            'Cannot update primary key column "id" of entity CollectionItem'
        );
    });

    it('rejects a COUNTER column before looking at the collection update', async () => {
        const { repo } = setup();

        await expect(repo.update(where, { hits: Append([]) } as never)).rejects.toThrow(
            'Cannot set counter column "hits" of entity CollectionItem'
        );
    });

    it('rejects an unknown column and an undefined sibling value as before', async () => {
        const { repo } = setup();

        await expect(repo.update(where, { nope: Append([]) } as never)).rejects.toThrow(/nope/);
        await expect(repo.update(where, { tags: Append(['a']), label: undefined })).rejects.toThrow(
            'Value for column "label" of entity CollectionItem is undefined'
        );
    });

    it('rejects an empty values object as before', async () => {
        const { repo } = setup();

        await expect(repo.update(where, {})).rejects.toBeInstanceOf(InvalidQueryError);
    });
});

describe('collection updates: plain objects are values, not updates', () => {
    it('binds { operation, value } on a MAP column as a whole-map assignment', async () => {
        const { repo, executed } = setup();
        const lookalike = { operation: 'Append', value: ['a'] };
        await repo.update(where, { attrs: lookalike as never });

        expect(executed[0].query).toBe('UPDATE collection_items SET attrs = ? WHERE id = ?');
        expect(executed[0].params).toEqual([lookalike, 'k']);
        expect(executed[0].params[0]).toBe(lookalike);
        expect(executed[0].options.isIdempotent).toBe(true);
    });

    it('does not treat the lookalike as an update on a LIST either (it fails the LIST shape check)', async () => {
        const { repo } = setup();

        await expect(
            repo.update(where, { tags: { operation: 'Append', value: ['a'] } as never })
        ).rejects.toBeInstanceOf(ColumnValidationError);
    });
});

describe('collection updates: idempotence passed to executeQuery', () => {
    it.each([
        ['Append on a LIST', { tags: Append(['a']) }, false],
        ['Prepend on a LIST', { tags: Prepend(['a']) }, false],
        ['Remove on a LIST', { tags: Remove(['a']) }, true],
        ['Append on a SET', { nums: Append([1]) }, true],
        ['Remove on a SET', { nums: Remove([1]) }, true],
        ['PutKeys on a MAP', { attrs: PutKeys({ a: 1 }) }, true],
        ['RemoveKeys on a MAP', { attrs: RemoveKeys(['a']) }, true],
        ['a plain assignment', { label: 'x' }, true],
        ['a whole-list assignment', { tags: ['a'] }, true],
        ['a plain assignment next to a SET append', { label: 'x', nums: Append([1]) }, true],
        ['a LIST append next to a plain assignment', { label: 'x', tags: Append(['a']) }, false],
        [
            'a LIST append next to MAP and SET updates',
            { nums: Append([1]), tags: Append(['a']), attrs: PutKeys({}) },
            false,
        ],
        ['a LIST prepend after a SET append', { nums: Append([1]), tags: Prepend(['a']) }, false],
    ])('update() with %s passes isIdempotent: %s', async (_name, values, expected) => {
        const { repo, executed } = setup();
        await repo.update(where, values as UpdateValues<CollectionItem>);

        expect(executed[0].options.isIdempotent).toBe(expected);
    });

    it('keeps the other write options alongside isIdempotent', async () => {
        const { repo, executed } = setup();
        await repo.update(where, { tags: Append(['a']) }, { consistency: types.consistencies.quorum });

        expect(executed[0].options).toEqual({
            prepare: true,
            consistency: types.consistencies.quorum,
            isIdempotent: false,
        });
    });

    it('updateStatement carries isIdempotent: false only for a LIST append or prepend', () => {
        const { repo } = setup();

        expect(repo.updateStatement(where, { tags: Append(['a']) })).toStrictEqual({
            query: 'UPDATE collection_items SET tags = tags + ? WHERE id = ?',
            params: [['a'], 'k'],
            isIdempotent: false,
        });
        expect(repo.updateStatement(where, { tags: Prepend(['a']) })).toStrictEqual({
            query: 'UPDATE collection_items SET tags = ? + tags WHERE id = ?',
            params: [['a'], 'k'],
            isIdempotent: false,
        });
        expect(repo.updateStatement(where, { label: 'x', tags: Append(['a']) }).isIdempotent).toBe(false);
    });

    it.each([
        ['LIST Remove', { tags: Remove(['a']) }],
        ['SET Append', { nums: Append([1]) }],
        ['SET Remove', { nums: Remove([1]) }],
        ['MAP PutKeys', { attrs: PutKeys({ a: 1 }) }],
        ['MAP RemoveKeys', { attrs: RemoveKeys(['a']) }],
        ['a plain assignment', { label: 'x' }],
        ['a whole-list assignment', { tags: ['a'] }],
    ])('updateStatement for %s has no isIdempotent key at all', (_name, values) => {
        const { repo } = setup();
        const statement = repo.updateStatement(where, values as UpdateValues<CollectionItem>);

        expect('isIdempotent' in statement).toBe(false);
        expect(Object.keys(statement).sort()).toEqual(['params', 'query']);
    });

    it('updateStatement for a plain update is byte-identical to the pre-0.8.0 shape', () => {
        const { repo } = setup();

        expect(repo.updateStatement(where, { label: 'x' }, { ttl: 3 })).toStrictEqual({
            query: 'UPDATE collection_items USING TTL ? SET label = ? WHERE id = ?',
            params: [3, 'x', 'k'],
        });
    });
});

describe('collection updates: hooks', () => {
    afterEach(() => {
        delete CollectionItem.beforeUpdate;
        delete CollectionItem.afterUpdate;
    });

    it('hands the CollectionUpdate objects to beforeUpdate and afterUpdate untouched', async () => {
        const { repo } = setup();
        const append = Append(['a']);
        const putKeys = PutKeys({ a: 1 });
        const seen: Array<Record<string, unknown>> = [];

        CollectionItem.beforeUpdate = (_conditions, values) => {
            seen.push(values);
        };
        CollectionItem.afterUpdate = (_conditions, values) => {
            seen.push(values);
        };
        await repo.update(where, { tags: append, attrs: putKeys, label: 'x' });

        expect(seen).toHaveLength(2);
        for (const values of seen) {
            expect(values.tags).toBe(append);
            expect(values.attrs).toBe(putKeys);
            expect(values.tags).toBeInstanceOf(CollectionUpdate);
            expect(values.label).toBe('x');
        }
    });

    it('runs beforeUpdate before validation, so a hook sees a bad update that then throws', async () => {
        const { repo, executed } = setup();
        const before = vi.fn();
        const after = vi.fn();
        CollectionItem.beforeUpdate = before;
        CollectionItem.afterUpdate = after;

        await expect(repo.update(where, { nums: Prepend([1]) })).rejects.toBeInstanceOf(InvalidQueryError);

        expect(before).toHaveBeenCalledTimes(1);
        expect(after).not.toHaveBeenCalled();
        expect(executed).toHaveLength(0);
    });

    it('updateStatement runs no hooks', () => {
        const { repo } = setup();
        const before = vi.fn();
        CollectionItem.beforeUpdate = before;

        repo.updateStatement(where, { tags: Append(['a']) });

        expect(before).not.toHaveBeenCalled();
    });
});

describe('collection updates: types', () => {
    it('keeps Partial<T> values assignable and accepts Append() for an array property', async () => {
        const { repo } = setup();
        const partial: Partial<CollectionItem> = { label: 'x', tags: ['a'] };
        const widened: UpdateValues<CollectionItem> = partial;
        const mixed: UpdateValues<CollectionItem> = {
            tags: Append(['a']),
            nums: Remove([1]),
            attrs: PutKeys({ a: 1 }),
        };

        await repo.update(where, partial);
        await repo.update(where, widened);
        await repo.update(where, mixed);
        repo.updateStatement(where, partial);
        await repo.updateIfExists(where, mixed);

        expect(widened).toBe(partial);
    });
});
