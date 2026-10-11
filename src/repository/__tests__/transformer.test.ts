import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { types } from 'cassandra-driver';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { ColumnValidationError, InvalidQueryError } from '../../errors';
import {
    Append,
    Between,
    Contains,
    ContainsKey,
    GreaterThan,
    GreaterThanOrEqual,
    In,
    LessThan,
    LessThanOrEqual,
} from '../query-utils';

// Mock cassandra-driver
vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: the real value types (`types.Long`, `types.Uuid`, …) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

type Status = 'draft' | 'live' | 'archived';
const STATUS_TO_CODE: Record<Status, number> = { draft: 0, live: 1, archived: 2 };
const CODE_TO_STATUS = ['draft', 'live', 'archived'] as const;

// Spies, so each test can assert exactly what the transformers were (and were not) called with
const jsonTo = vi.fn((value: unknown) => JSON.stringify(value));
const jsonFrom = vi.fn((value: unknown) => JSON.parse(value as string));
const statusTo = vi.fn((value: unknown) => STATUS_TO_CODE[value as Status]);
const statusFrom = vi.fn((value: unknown) => CODE_TO_STATUS[value as number]);
const createdTo = vi.fn((value: unknown) => value);
const createdFrom = vi.fn((value: unknown) => (value as Date).toISOString());
const refFrom = vi.fn((value: unknown) => `ref:${String(value)}`);
const labelsTo = vi.fn((value: unknown) => (value as string[]).map((label) => label.toUpperCase()));
const labelsFrom = vi.fn((value: unknown) => (value as string[]).map((label) => label.toLowerCase()));
const metaTo = vi.fn((value: unknown) => ({ ...(value as object), wrapped: 'yes' }));
const keyTo = vi.fn((value: unknown) => `key:${String(value)}`);
const keyFrom = vi.fn((value: unknown) => String(value).replace(/^key:/, ''));
const codeTo = vi.fn((value: unknown) => `#${String(value)}`);
const codeValidate = vi.fn((value: unknown) => (value as string).length <= 4 || 'at most 4 characters, hash included');
const badIntTo = vi.fn((value: unknown) => String(value));

// What the beforeSave hook saw on the entity
const savedPayloads: unknown[] = [];

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

@Entity('tx_documents')
class TxDocument extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT', { transformer: { to: jsonTo, from: jsonFrom } })
    payload: unknown;

    @Column('INT', { transformer: { to: statusTo, from: statusFrom } })
    status: Status;

    @Column('TEXT')
    plain: unknown;

    @Column('TIMESTAMP', { transformer: { to: createdTo, from: createdFrom } })
    created: unknown;

    @Column('UUID', { transformer: { to: vi.fn((value: unknown) => value), from: refFrom } })
    ref: unknown;

    async beforeSave(): Promise<void> {
        savedPayloads.push(this.payload);
    }
}

@Entity('tx_collections')
class TxCollection extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('LIST', { of: 'TEXT', transformer: { to: labelsTo, from: labelsFrom } })
    labels: unknown;

    @Column('MAP', { of: ['TEXT', 'TEXT'], transformer: { to: metaTo, from: (value: unknown) => value } })
    meta: unknown;
}

@Entity('tx_keyed')
class TxKeyed extends BaseModel {
    @PrimaryKeyColumn('TEXT', { transformer: { to: keyTo, from: keyFrom } })
    key: string;

    @Column('COUNTER')
    views: number;

    @Column('TEXT')
    note: string;
}

@Entity('tx_validated')
class TxValidated extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT', { transformer: { to: codeTo, from: (value: unknown) => value }, validate: codeValidate })
    code: string;

    @Column('INT', { transformer: { to: badIntTo, from: (value: unknown) => value } })
    badInt: unknown;

    @Column('INT')
    plainInt: number;
}

@Entity('tx_untransformed')
class TxUntransformed extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('INT')
    age: number;

    @Column('TEXT')
    name: string;
}

function setup<T extends typeof BaseModel & (new () => InstanceType<T>)>(entityClass: T, rows: object[] = []) {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[] }> = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
        executed.push({ query, params });
        return rows as never;
    });

    const repo = ds.getRepository(entityClass) as Repository<InstanceType<T>>;

    return { repo, executed };
}

function makeDocument(): TxDocument {
    const doc = new TxDocument();
    doc.id = UUID_A;
    doc.payload = { a: 1 };
    doc.status = 'live';
    doc.plain = 'p';
    return doc;
}

const DOC_INSERT = 'INSERT INTO tx_documents (id, payload, status, plain, created, ref) VALUES (?, ?, ?, ?, ?, ?)';

beforeEach(() => {
    vi.clearAllMocks();
    savedPayloads.length = 0;
});

afterEach(() => {
    delete TxDocument.beforeUpdate;
});

describe('column transformer: writes', () => {
    it('save() binds the transformed values, in column order, and leaves unset columns untouched', async () => {
        const { repo, executed } = setup(TxDocument);
        const doc = makeDocument();

        await repo.save(doc);

        expect(executed[0].query).toBe(DOC_INSERT);
        expect(executed[0].params).toEqual([UUID_A, '{"a":1}', 1, 'p', undefined, undefined]);
        expect(jsonTo).toHaveBeenCalledTimes(1);
        expect(jsonTo).toHaveBeenCalledWith({ a: 1 });
        expect(statusTo).toHaveBeenCalledWith('live');
    });

    it('does not mutate the entity: it keeps the untransformed values after save()', async () => {
        const { repo } = setup(TxDocument);
        const doc = makeDocument();
        const payload = doc.payload;

        const saved = await repo.save(doc);

        expect(saved).toBe(doc);
        expect(doc.payload).toBe(payload);
        expect(doc.payload).toEqual({ a: 1 });
        expect(doc.status).toBe('live');
    });

    it('beforeSave sees the untransformed entity values', async () => {
        const { repo } = setup(TxDocument);

        await repo.save(makeDocument());

        expect(savedPayloads).toEqual([{ a: 1 }]);
    });

    it('never calls to() with undefined, and binds null as null', async () => {
        const { repo, executed } = setup(TxDocument);
        const doc = makeDocument();
        doc.payload = null;
        doc.status = undefined as never;

        await repo.save(doc);

        expect(executed[0].params).toEqual([UUID_A, null, undefined, 'p', undefined, undefined]);
        expect(jsonTo).not.toHaveBeenCalled();
        expect(statusTo).not.toHaveBeenCalled();
        expect(createdTo).not.toHaveBeenCalled();
    });

    it('saveStatement() binds the transformed values like save()', () => {
        const { repo } = setup(TxDocument);

        const statement = repo.saveStatement(makeDocument());

        expect(statement.query).toBe(DOC_INSERT);
        expect(statement.params).toEqual([UUID_A, '{"a":1}', 1, 'p', undefined, undefined]);
    });

    it('insertIfNotExists() binds the transformed values', async () => {
        const { repo, executed } = setup(TxDocument, [{ '[applied]': true }]);

        await expect(repo.insertIfNotExists(makeDocument())).resolves.toBe(true);

        expect(executed[0].query).toBe(`${DOC_INSERT} IF NOT EXISTS`);
        expect(executed[0].params).toEqual([UUID_A, '{"a":1}', 1, 'p', undefined, undefined]);
    });

    it('saveMany() binds the transformed values of every entity', async () => {
        const { repo, executed } = setup(TxDocument);
        const second = makeDocument();
        second.id = UUID_B;
        second.payload = [1, 2];
        second.status = 'archived';

        await repo.saveMany([makeDocument(), second]);

        expect(executed.map((call) => call.params)).toEqual([
            [UUID_A, '{"a":1}', 1, 'p', undefined, undefined],
            [UUID_B, '[1,2]', 2, 'p', undefined, undefined],
        ]);
    });

    it('update() binds transformed SET values; a null value stays a tombstone and skips to()', async () => {
        const { repo, executed } = setup(TxDocument);

        await repo.update({ id: UUID_A }, { payload: { b: 2 }, status: 'archived', plain: 'x' });
        await repo.update({ id: UUID_A }, { payload: null });

        expect(executed[0].query).toBe('UPDATE tx_documents SET payload = ?, status = ?, plain = ? WHERE id = ?');
        expect(executed[0].params).toEqual(['{"b":2}', 2, 'x', UUID_A]);
        expect(executed[1].query).toBe('UPDATE tx_documents SET payload = ? WHERE id = ?');
        expect(executed[1].params).toEqual([null, UUID_A]);
        expect(jsonTo).toHaveBeenCalledTimes(1);
    });

    it('update() rejects undefined before calling to()', async () => {
        const { repo, executed } = setup(TxDocument);

        await expect(repo.update({ id: UUID_A }, { payload: undefined })).rejects.toThrow(InvalidQueryError);

        expect(jsonTo).not.toHaveBeenCalled();
        expect(executed).toHaveLength(0);
    });

    it('updateStatement() and updateIfExists() bind transformed SET values', async () => {
        const { repo, executed } = setup(TxDocument, [{ '[applied]': true }]);

        const statement = repo.updateStatement({ id: UUID_A }, { status: 'draft' });
        await repo.updateIfExists({ id: UUID_A }, { status: 'live' });

        expect(statement).toEqual({ query: 'UPDATE tx_documents SET status = ? WHERE id = ?', params: [0, UUID_A] });
        expect(executed[0].query).toBe('UPDATE tx_documents SET status = ? WHERE id = ? IF EXISTS');
        expect(executed[0].params).toEqual([1, UUID_A]);
    });

    it('beforeUpdate sees the untransformed values, and the caller values object is not mutated', async () => {
        const { repo } = setup(TxDocument);
        const seen: unknown[] = [];
        TxDocument.beforeUpdate = (_conditions, values) => {
            seen.push({ ...values });
        };
        const values = { payload: { b: 2 }, status: 'live' as Status };

        await repo.update({ id: UUID_A }, values);

        expect(seen).toEqual([{ payload: { b: 2 }, status: 'live' }]);
        expect(values).toEqual({ payload: { b: 2 }, status: 'live' });
    });

    it('whole-value writes to a collection column go through to(); Append() operands do not', async () => {
        const { repo, executed } = setup(TxCollection);

        await repo.update({ id: 'c1' }, { labels: ['a', 'b'] });
        await repo.update({ id: 'c1' }, { labels: Append(['x']) });

        expect(executed[0].params).toEqual([['A', 'B'], 'c1']);
        expect(executed[1].query).toBe('UPDATE tx_collections SET labels = labels + ? WHERE id = ?');
        expect(executed[1].params).toEqual([['x'], 'c1']);
        expect(labelsTo).toHaveBeenCalledTimes(1);
    });

    it('propagates a throwing to() from save() without running a query', async () => {
        const { repo, executed } = setup(TxDocument);
        jsonTo.mockImplementationOnce(() => {
            throw new Error('cannot serialise');
        });

        await expect(repo.save(makeDocument())).rejects.toThrow('cannot serialise');

        expect(executed).toHaveLength(0);
    });

    it('propagates a throwing to() from update() and from a where condition', async () => {
        const { repo, executed } = setup(TxDocument);
        statusTo.mockImplementationOnce(() => {
            throw new Error('bad status');
        });
        statusTo.mockImplementationOnce(() => {
            throw new Error('bad status in where');
        });

        await expect(repo.update({ id: UUID_A }, { status: 'live' })).rejects.toThrow('bad status');
        await expect(repo.findBy({ status: 'live' })).rejects.toThrow('bad status in where');

        expect(executed).toHaveLength(0);
    });
});

describe('column transformer: validation sees the transformed value', () => {
    it('type-checks the transformed value: a transformer producing the wrong type is rejected', async () => {
        const { repo, executed } = setup(TxValidated);
        const entity = new TxValidated();
        entity.id = 'v1';
        entity.badInt = 5;

        const error = await repo.save(entity).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ColumnValidationError);
        expect((error as ColumnValidationError).message).toContain('"badInt"');
        expect((error as ColumnValidationError).message).toContain('an integer between');
        expect((error as ColumnValidationError).receivedType).toBe('string');
        expect(badIntTo).toHaveBeenCalledWith(5);
        expect(executed).toHaveLength(0);
    });

    it('type-checks the transformed value in update() too', async () => {
        const { repo } = setup(TxValidated);

        await expect(repo.update({ id: 'v1' }, { badInt: 5 })).rejects.toThrow(ColumnValidationError);
    });

    it('hands validate() the transformed value, not the entity value', async () => {
        const { repo, executed } = setup(TxValidated);
        const entity = new TxValidated();
        entity.id = 'v1';
        entity.code = 'ab';

        await repo.save(entity);

        expect(codeValidate).toHaveBeenCalledTimes(1);
        expect(codeValidate).toHaveBeenCalledWith('#ab');
        expect(executed[0].params).toEqual(['v1', '#ab', undefined, undefined]);
    });

    it('rejects when only the transformed value breaks validate(), naming the reason', async () => {
        const { repo, executed } = setup(TxValidated);
        const entity = new TxValidated();
        entity.id = 'v1';
        // Four characters pass on their own; with the hash prefix they are five
        entity.code = 'abcd';

        const error = await repo.save(entity).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ColumnValidationError);
        expect((error as ColumnValidationError).expected).toBe('at most 4 characters, hash included');
        expect((error as ColumnValidationError).message).toContain('"code"');
        expect(executed).toHaveLength(0);
    });

    it('update() runs validate() on the transformed value as well', async () => {
        const { repo, executed } = setup(TxValidated);

        await expect(repo.update({ id: 'v1' }, { code: 'abcd' })).rejects.toThrow(ColumnValidationError);
        await repo.update({ id: 'v1' }, { code: 'ab' });

        expect(codeValidate).toHaveBeenLastCalledWith('#ab');
        expect(executed[0].params).toEqual(['#ab', 'v1']);
    });

    it('regression: a column without a transformer is still type-checked as before', async () => {
        const { repo, executed } = setup(TxValidated);
        const entity = new TxValidated();
        entity.id = 'v1';
        entity.plainInt = 7;

        await repo.save(entity);
        entity.plainInt = '7' as never;

        await expect(repo.save(entity)).rejects.toThrow(ColumnValidationError);
        expect(executed).toHaveLength(1);
        expect(executed[0].query).toBe('INSERT INTO tx_validated (id, code, badInt, plainInt) VALUES (?, ?, ?, ?)');
        expect(executed[0].params).toEqual(['v1', undefined, undefined, 7]);
    });
});

describe('column transformer: conditions', () => {
    it('findOneBy() transforms an equality condition', async () => {
        const { repo, executed } = setup(TxDocument);

        await repo.findOneBy({ payload: { a: 1 }, status: 'live' }, true);

        expect(executed[0].query).toBe(
            'SELECT * FROM tx_documents WHERE payload = ? AND status = ? LIMIT 1 ALLOW FILTERING'
        );
        expect(executed[0].params).toEqual(['{"a":1}', 1]);
    });

    it('delete() and deleteStatement() transform an equality condition', async () => {
        const { repo, executed } = setup(TxKeyed);

        await repo.delete({ key: 'a' });
        const statement = repo.deleteStatement({ key: 'b' });

        expect(executed[0].query).toBe('DELETE FROM tx_keyed WHERE key = ?');
        expect(executed[0].params).toEqual(['key:a']);
        expect(statement).toEqual({ query: 'DELETE FROM tx_keyed WHERE key = ?', params: ['key:b'] });
    });

    it('update() transforms its conditions and the SET value independently', async () => {
        const { repo, executed } = setup(TxKeyed);

        await repo.update({ key: 'a' }, { note: 'n' });

        expect(executed[0].query).toBe('UPDATE tx_keyed SET note = ? WHERE key = ?');
        expect(executed[0].params).toEqual(['n', 'key:a']);
    });

    it('increment(), decrement() and their statements transform the conditions', async () => {
        const { repo, executed } = setup(TxKeyed);

        await repo.increment({ key: 'a' }, 'views', 3);
        await repo.decrement({ key: 'a' }, 'views');
        const statement = repo.incrementStatement({ key: 'b' }, 'views', 2);

        expect(executed[0].query).toBe('UPDATE tx_keyed SET views = views + ? WHERE key = ?');
        expect(executed[0].params).toEqual([3, 'key:a']);
        expect(executed[1].query).toBe('UPDATE tx_keyed SET views = views - ? WHERE key = ?');
        expect(executed[1].params).toEqual([1, 'key:a']);
        expect(statement.params).toEqual([2, 'key:b']);
    });

    it('findBy() transforms plain equality', async () => {
        const { repo, executed } = setup(TxDocument);

        await repo.findBy({ status: 'live' });

        expect(executed[0].query).toBe('SELECT * FROM tx_documents WHERE status = ?');
        expect(executed[0].params).toEqual([1]);
    });

    it.each([
        ['<', LessThan],
        ['<=', LessThanOrEqual],
        ['>', GreaterThan],
        ['>=', GreaterThanOrEqual],
    ] as const)('findBy() transforms the operand of %s', async (operator, build) => {
        const { repo, executed } = setup(TxDocument);

        await repo.findBy({ status: build('archived' as never) });

        expect(executed[0].query).toBe(`SELECT * FROM tx_documents WHERE status ${operator} ?`);
        expect(executed[0].params).toEqual([2]);
    });

    it('findBy() transforms every IN element, in order', async () => {
        const { repo, executed } = setup(TxDocument);

        await repo.findBy({ status: In(['archived', 'draft', 'live'] as never[]) });

        expect(executed[0].query).toBe('SELECT * FROM tx_documents WHERE status IN (?, ?, ?)');
        expect(executed[0].params).toEqual([2, 0, 1]);
        expect(statusTo).toHaveBeenCalledTimes(3);
    });

    it('findBy() transforms both BETWEEN ends', async () => {
        const { repo, executed } = setup(TxDocument);

        await repo.findBy({ status: Between('draft' as never, 'live' as never) });

        expect(executed[0].query).toBe('SELECT * FROM tx_documents WHERE status >= ? AND status <= ?');
        expect(executed[0].params).toEqual([0, 1]);
    });

    it('find({ where }) transforms conditions on the select path', async () => {
        const { repo, executed } = setup(TxDocument);

        await repo.find({ where: { status: 'live' } });

        expect(executed[0].query).toBe('SELECT * FROM tx_documents WHERE status = ?');
        expect(executed[0].params).toEqual([1]);
    });

    it('does not transform Contains() or ContainsKey() operands', async () => {
        const { repo, executed } = setup(TxCollection);

        await repo.findBy({ labels: Contains('x') }, true);
        await repo.findBy({ meta: ContainsKey('k') }, true);

        expect(executed[0].query).toBe('SELECT * FROM tx_collections WHERE labels CONTAINS ? ALLOW FILTERING');
        expect(executed[0].params).toEqual(['x']);
        expect(executed[1].query).toBe('SELECT * FROM tx_collections WHERE meta CONTAINS KEY ? ALLOW FILTERING');
        expect(executed[1].params).toEqual(['k']);
        expect(labelsTo).not.toHaveBeenCalled();
        expect(metaTo).not.toHaveBeenCalled();
    });

    it('binds a value that is only bindable after transformation: an object or a class instance', async () => {
        const { repo, executed } = setup(TxDocument);

        class Filter {
            constructor(public tag: string) {}
        }

        await repo.findBy({ payload: { a: 1 } as never });
        await repo.findBy({ payload: new Filter('t') as never });
        await repo.findBy({ payload: In([{ a: 1 }, [2]] as never[]) });
        await repo.findBy({ payload: Between({ a: 1 } as never, { a: 2 } as never) });

        expect(executed[0].params).toEqual(['{"a":1}']);
        expect(executed[1].params).toEqual(['{"tag":"t"}']);
        expect(executed[2].params).toEqual(['{"a":1}', '[2]']);
        expect(executed[3].params).toEqual(['{"a":1}', '{"a":2}']);
    });

    it('regression: the same object on a column without a transformer is still rejected', async () => {
        const { repo, executed } = setup(TxDocument);

        const error = await repo.findBy({ plain: { a: 1 } as never }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect((error as Error).message).toContain('"plain"');
        expect(executed).toHaveLength(0);
    });

    it('rejects null conditions without calling to()', async () => {
        const { repo } = setup(TxDocument);

        await expect(repo.findBy({ status: null as never })).rejects.toThrow(InvalidQueryError);
        await expect(repo.findOneBy({ status: undefined as never })).rejects.toThrow(InvalidQueryError);

        expect(statusTo).not.toHaveBeenCalled();
    });

    it('a transformer producing a non-bindable value is still rejected as a condition value', async () => {
        const { repo } = setup(TxDocument);
        statusTo.mockImplementationOnce(() => ({ not: 'bindable' }));

        const error = await repo.findBy({ status: 'live' }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect((error as Error).message).toContain('"status"');
    });
});

describe('column transformer: reads', () => {
    const row = {
        id: types.Uuid.fromString(UUID_A),
        payload: '{"a":1}',
        status: 2,
        plain: 'p',
        created: 1700000000000,
        ref: types.Uuid.fromString(UUID_B),
    };

    it('find() runs from() after the built-in conversion: a UUID arrives as a string, a TIMESTAMP as a Date', async () => {
        const { repo } = setup(TxDocument, [row]);

        const [doc] = await repo.find();

        expect(refFrom).toHaveBeenCalledTimes(1);
        expect(refFrom).toHaveBeenCalledWith(UUID_B);
        expect(typeof refFrom.mock.calls[0][0]).toBe('string');
        expect(createdFrom).toHaveBeenCalledTimes(1);
        expect(createdFrom.mock.calls[0][0]).toBeInstanceOf(Date);
        expect((createdFrom.mock.calls[0][0] as Date).getTime()).toBe(1700000000000);
        expect(doc.ref).toBe(`ref:${UUID_B}`);
        expect(doc.created).toBe('2023-11-14T22:13:20.000Z');
        expect(doc.payload).toEqual({ a: 1 });
        expect(doc.status).toBe('archived');
        // The primary key and the plain column have no transformer and keep the built-in conversion
        expect(doc.id).toBe(UUID_A);
        expect(doc.plain).toBe('p');
    });

    it('findBy() and findOneBy() map through from()', async () => {
        const { repo } = setup(TxDocument, [row]);

        const [byConditions] = await repo.findBy({ plain: 'p' });
        const one = await repo.findOneBy({ plain: 'p' });

        expect(byConditions.payload).toEqual({ a: 1 });
        expect(one?.status).toBe('archived');
    });

    it('never calls from() with null, and a column absent from the row is not read', async () => {
        const { repo } = setup(TxDocument, [{ id: types.Uuid.fromString(UUID_A), payload: null, status: null }]);

        const [doc] = await repo.find();

        expect(doc.payload).toBeNull();
        expect(doc.status).toBeNull();
        expect(doc.ref).toBeUndefined();
        expect(jsonFrom).not.toHaveBeenCalled();
        expect(statusFrom).not.toHaveBeenCalled();
        expect(refFrom).not.toHaveBeenCalled();
        expect(createdFrom).not.toHaveBeenCalled();
    });

    it('runRawQuery() maps rows through from()', async () => {
        const { repo } = setup(TxDocument, [row]);

        const [doc] = await repo.runRawQuery('SELECT * FROM tx_documents WHERE id = :id', { id: UUID_A });

        expect(doc).toBeInstanceOf(TxDocument);
        expect(doc.payload).toEqual({ a: 1 });
        expect(doc.status).toBe('archived');
        expect(refFrom).toHaveBeenCalledWith(UUID_B);
    });

    it('runRawQuery({ raw: true }) returns the rows untouched and never calls from()', async () => {
        const { repo } = setup(TxDocument, [row]);

        const rows = await repo.runRawQuery('SELECT * FROM tx_documents', {}, { raw: true });

        expect(rows).toEqual([row]);
        expect(rows[0]).toBe(row);
        expect(jsonFrom).not.toHaveBeenCalled();
        expect(statusFrom).not.toHaveBeenCalled();
        expect(refFrom).not.toHaveBeenCalled();
        expect(createdFrom).not.toHaveBeenCalled();
    });

    it('a throwing from() propagates out of find()', async () => {
        const { repo } = setup(TxDocument, [row]);
        jsonFrom.mockImplementationOnce(() => {
            throw new Error('corrupt payload');
        });

        await expect(repo.find()).rejects.toThrow('corrupt payload');
    });

    it('a throwing from() propagates out of runRawQuery() unwrapped', async () => {
        const { repo } = setup(TxDocument, [row]);
        jsonFrom.mockImplementationOnce(() => {
            throw new Error('corrupt payload');
        });

        const error = await repo.runRawQuery('SELECT * FROM tx_documents', {}).catch((caught: unknown) => caught);

        expect((error as Error).message).toBe('corrupt payload');
        expect((error as Error).name).not.toBe('QueryFailedError');
    });

    it('maps every row, each through from()', async () => {
        const { repo } = setup(TxCollection, [
            { id: 'c1', labels: ['A', 'B'], meta: { k: 'v' } },
            { id: 'c2', labels: ['C'], meta: null },
        ]);

        const docs = await repo.find();

        expect(docs.map((doc) => doc.labels)).toEqual([['a', 'b'], ['c']]);
        expect(docs[1].meta).toBeNull();
        expect(labelsFrom).toHaveBeenCalledTimes(2);
    });
});

describe('column transformer: primary key', () => {
    it('save() binds the transformed primary key', async () => {
        const { repo, executed } = setup(TxKeyed);
        const entity = new TxKeyed();
        entity.key = 'abc';
        entity.note = 'n';

        await repo.save(entity);

        expect(executed[0].query).toBe('INSERT INTO tx_keyed (key, views, note) VALUES (?, ?, ?)');
        expect(executed[0].params).toEqual(['key:abc', undefined, 'n']);
        expect(entity.key).toBe('abc');
    });

    it('a primary key from() runs on read', async () => {
        const { repo } = setup(TxKeyed, [{ key: 'key:abc', views: 3, note: 'n' }]);

        const one = await repo.findOneBy({ key: 'abc' });

        expect(one?.key).toBe('abc');
        expect(keyFrom).toHaveBeenCalledWith('key:abc');
    });

    it('a primary key transformer applies in IN conditions', async () => {
        const { repo, executed } = setup(TxKeyed);

        await repo.findBy({ key: In(['a', 'b']) });

        expect(executed[0].query).toBe('SELECT * FROM tx_keyed WHERE key IN (?, ?)');
        expect(executed[0].params).toEqual(['key:a', 'key:b']);
    });
});

describe('column transformer: regression for columns without one', () => {
    it('binds identical CQL and params on every path', async () => {
        const { repo, executed } = setup(TxUntransformed);
        const entity = new TxUntransformed();
        entity.id = 'u1';
        entity.age = 30;
        entity.name = 'Ann';

        await repo.save(entity);
        await repo.update({ id: 'u1' }, { age: 31, name: null });
        await repo.delete({ id: 'u1' });
        await repo.findBy({ age: Between(1, 2), name: In(['a', 'b']), id: 'u1' }, true);
        await repo.findOneBy({ id: 'u1', age: 30 });

        expect(executed).toEqual([
            { query: 'INSERT INTO tx_untransformed (id, age, name) VALUES (?, ?, ?)', params: ['u1', 30, 'Ann'] },
            { query: 'UPDATE tx_untransformed SET age = ?, name = ? WHERE id = ?', params: [31, null, 'u1'] },
            { query: 'DELETE FROM tx_untransformed WHERE id = ?', params: ['u1'] },
            {
                query: 'SELECT * FROM tx_untransformed WHERE age >= ? AND age <= ? AND name IN (?, ?) AND id = ? ALLOW FILTERING',
                params: [1, 2, 'a', 'b', 'u1'],
            },
            { query: 'SELECT * FROM tx_untransformed WHERE id = ? AND age = ? LIMIT 1', params: ['u1', 30] },
        ]);
    });

    it('maps rows without a transformer exactly as before', async () => {
        const { repo } = setup(TxUntransformed, [{ id: 'u1', age: 30, name: 'Ann' }]);

        const [entity] = await repo.find();

        expect(entity).toBeInstanceOf(TxUntransformed);
        expect({ id: entity.id, age: entity.age, name: entity.name }).toEqual({ id: 'u1', age: 30, name: 'Ann' });
    });

    it('transformers on one column do not touch its siblings in the same statement', async () => {
        const { repo, executed } = setup(TxDocument);

        await repo.update({ id: UUID_A }, { plain: 'untouched', status: 'live' });

        expect(executed[0].params).toEqual(['untouched', 1, UUID_A]);
        expect(statusTo).toHaveBeenCalledTimes(1);
        expect(jsonTo).not.toHaveBeenCalled();
    });
});
