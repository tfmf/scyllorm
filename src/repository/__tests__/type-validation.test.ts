import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column, ColumnType } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { ColumnValidationError } from '../../errors';
import { validateColumnValue } from '../type-validation';

// Mock cassandra-driver
vi.mock('cassandra-driver', () => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    return {
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

const ALL_TYPES: ColumnType[] = [
    'ASCII',
    'BIGINT',
    'BLOB',
    'BOOLEAN',
    'COUNTER',
    'DATE',
    'DECIMAL',
    'DOUBLE',
    'DURATION',
    'FLOAT',
    'FROZEN',
    'INET',
    'INT',
    'LIST',
    'MAP',
    'SET',
    'SMALLINT',
    'TINYINT',
    'TIME',
    'TIMESTAMP',
    'TIMEUUID',
    'TEXT',
    'TUPLE',
    'UUID',
    'VARINT',
    'VARCHAR',
];

const CANONICAL_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('validateColumnValue()', () => {
    const cases: Array<{ type: ColumnType; accept: unknown[]; reject: unknown[] }> = [
        { type: 'ASCII', accept: ['hi'], reject: [1, true] },
        { type: 'TEXT', accept: ['hi', ''], reject: [1, true, {}, ['a']] },
        { type: 'VARCHAR', accept: ['hi'], reject: [1] },
        { type: 'BOOLEAN', accept: [true, false], reject: ['true', 1, {}] },
        { type: 'BIGINT', accept: [7, -7, 10n, '123', '-45', { low: 1, high: 0 }], reject: [1.5, 'abc', true] },
        { type: 'VARINT', accept: ['9007199254740993', 0], reject: ['1.5', 'x'] },
        { type: 'COUNTER', accept: [5, -3, 2n], reject: [2.5, 'nope'] },
        { type: 'FLOAT', accept: [1.5, -0.25, NaN, Infinity], reject: ['1.5', true, {}] },
        { type: 'DOUBLE', accept: [1.5, 0], reject: ['1.5', true] },
        { type: 'DECIMAL', accept: [1.5, '1.5', '-2', '3e10', { unscaled: 1 }], reject: ['abc', true] },
        // A plain object is accepted: the driver takes its Long type for a timestamp
        { type: 'TIMESTAMP', accept: [new Date(), 0, 1700000000000, '2024-01-01', {}], reject: [Infinity, true] },
        { type: 'DATE', accept: ['2024-01-01', new Date(), { year: 2024 }], reject: [123, true] },
        { type: 'TIME', accept: ['10:00:00', { hour: 10 }], reject: [123, true] },
        { type: 'UUID', accept: [CANONICAL_UUID, CANONICAL_UUID.toUpperCase(), {}], reject: ['abc-123', '', 123] },
        { type: 'TIMEUUID', accept: [CANONICAL_UUID], reject: ['not-a-uuid', 5] },
        { type: 'INET', accept: ['127.0.0.1', {}], reject: [123, true] },
        { type: 'BLOB', accept: [Buffer.from('x'), new Uint8Array(2)], reject: ['x', 123, {}] },
        { type: 'DURATION', accept: ['1h30m', {}], reject: [123, true] },
        { type: 'LIST', accept: [[1, 2], [], new Set()], reject: ['a', {}, 1] },
        { type: 'SET', accept: [new Set([1]), ['a']], reject: ['a', 1] },
        { type: 'MAP', accept: [new Map(), { a: 1 }], reject: [['a'], 'a', 1] },
        { type: 'TUPLE', accept: [[1, 'a'], {}], reject: ['a', 1, true] },
        { type: 'FROZEN', accept: ['x', 1, true, {}, [], new Map()], reject: [] },
    ];

    for (const { type, accept, reject } of cases) {
        it(`${type} accepts and rejects the expected shapes`, () => {
            for (const value of accept) {
                expect(() => validateColumnValue('E', 'c', type, value)).not.toThrow();
            }
            for (const value of reject) {
                expect(() => validateColumnValue('E', 'c', type, value)).toThrow(ColumnValidationError);
            }
        });
    }

    it('enforces the asymmetric range edges of INT, SMALLINT and TINYINT', () => {
        const edges: Array<[ColumnType, number, number]> = [
            ['INT', -2147483648, 2147483647],
            ['SMALLINT', -32768, 32767],
            ['TINYINT', -128, 127],
        ];

        for (const [type, min, max] of edges) {
            expect(() => validateColumnValue('E', 'c', type, max)).not.toThrow();
            expect(() => validateColumnValue('E', 'c', type, min)).not.toThrow();
            expect(() => validateColumnValue('E', 'c', type, max + 1)).toThrow(ColumnValidationError);
            expect(() => validateColumnValue('E', 'c', type, min - 1)).toThrow(ColumnValidationError);
            expect(() => validateColumnValue('E', 'c', type, 0.5)).toThrow(ColumnValidationError);
            expect(() => validateColumnValue('E', 'c', type, '1')).toThrow(ColumnValidationError);
        }
    });

    it('lets null and undefined pass for every type', () => {
        for (const type of ALL_TYPES) {
            expect(() => validateColumnValue('E', 'c', type, null)).not.toThrow();
            expect(() => validateColumnValue('E', 'c', type, undefined)).not.toThrow();
        }
    });

    it('runs the custom validator after the type check: true passes, false and string reject', () => {
        expect(() => validateColumnValue('E', 'c', 'TEXT', 'ok', () => true)).not.toThrow();
        expect(() => validateColumnValue('E', 'c', 'TEXT', 'ok', () => false)).toThrow(ColumnValidationError);
        expect(() => validateColumnValue('E', 'c', 'TEXT', 'ok', () => 'too plain')).toThrow('too plain');

        // A string reason lands on the error's expected description
        try {
            validateColumnValue('E', 'c', 'TEXT', 'ok', () => 'too plain');
            expect.fail('should have thrown');
        } catch (error) {
            expect((error as ColumnValidationError).expected).toBe('too plain');
        }
    });

    it('never calls the custom validator for null or undefined', () => {
        const validator = vi.fn().mockReturnValue(false);

        validateColumnValue('E', 'c', 'TEXT', null, validator);
        validateColumnValue('E', 'c', 'TEXT', undefined, validator);

        expect(validator).not.toHaveBeenCalled();
    });

    it('rejects a type-mismatched value before the custom validator runs', () => {
        const validator = vi.fn().mockReturnValue(true);

        expect(() => validateColumnValue('E', 'c', 'TEXT', 42, validator)).toThrow(ColumnValidationError);
        expect(validator).not.toHaveBeenCalled();
    });

    it('carries entity, column, expected and typeof — never the value itself', () => {
        const secret = 'hunter2-super-secret';

        try {
            validateColumnValue('User', 'password', 'INT', secret);
            expect.fail('should have thrown');
        } catch (error) {
            const validation = error as ColumnValidationError;

            expect(validation).toBeInstanceOf(ColumnValidationError);
            expect(validation.code).toBe('SCYLLORM_COLUMN_VALIDATION');
            expect(validation.entity).toBe('User');
            expect(validation.column).toBe('password');
            expect(validation.receivedType).toBe('string');
            expect(validation.expected).toContain('integer');
            expect(validation.message).not.toContain(secret);
            expect(JSON.stringify({ ...validation, message: validation.message })).not.toContain(secret);
        }
    });
});

@Entity('widgets')
class Widget extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('INT')
    age: number;

    @Column('TEXT', { validate: (value) => (value as string).length <= 5 || 'name is too long' })
    name: string;

    @Column('TEXT', { validate: (value) => value !== 'nope' })
    mood: string;
}

function setup<T extends typeof BaseModel & (new () => InstanceType<T>)>(entityClass: T) {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[] }> = [];

    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
        executed.push({ query, params });
        return [] as never;
    });

    const repo = ds.getRepository(entityClass) as Repository<InstanceType<T>>;

    return { repo, executed };
}

describe('write methods validate values', () => {
    it('save(), insertIfNotExists() and saveStatement() reject a type-mismatched value before any query', async () => {
        const { repo, executed } = setup(Widget);
        const entity = repo.create({ id: 'w1', age: 1.5 } as never);

        await expect(repo.save(entity)).rejects.toThrow(ColumnValidationError);
        await expect(repo.insertIfNotExists(entity)).rejects.toThrow(ColumnValidationError);
        expect(() => repo.saveStatement(entity)).toThrow(ColumnValidationError);
        expect(executed).toHaveLength(0);
    });

    it('update(), updateIfExists() and updateStatement() reject a type-mismatched value before any query', async () => {
        const { repo, executed } = setup(Widget);

        await expect(repo.update({ id: 'w1' } as never, { age: 'old' } as never)).rejects.toThrow(
            ColumnValidationError
        );
        await expect(repo.updateIfExists({ id: 'w1' } as never, { age: 'old' } as never)).rejects.toThrow(
            ColumnValidationError
        );
        expect(() => repo.updateStatement({ id: 'w1' } as never, { age: 'old' } as never)).toThrow(
            ColumnValidationError
        );
        expect(executed).toHaveLength(0);
    });

    it('the custom validator rejects on write, with its string reason on the error', async () => {
        const { repo } = setup(Widget);
        const entity = repo.create({ id: 'w1', name: 'far too long' } as never);

        await expect(repo.save(entity)).rejects.toThrow('name is too long');
        await expect(repo.update({ id: 'w1' } as never, { mood: 'nope' } as never)).rejects.toThrow(
            ColumnValidationError
        );
    });

    it('valid values, nulls and unset properties all write as before', async () => {
        const { repo, executed } = setup(Widget);

        await repo.save(repo.create({ id: 'w1', age: 42, name: 'ok' } as never));
        await repo.update({ id: 'w1' } as never, { age: null } as never);

        expect(executed[0].query).toBe('INSERT INTO widgets (id, age, name, mood) VALUES (?, ?, ?, ?)');
        expect(executed[0].params).toEqual(['w1', 42, 'ok', undefined]);
        expect(executed[1].query).toBe('UPDATE widgets SET age = ? WHERE id = ?');
        expect(executed[1].params).toEqual([null, 'w1']);
    });

    it('deletes do not validate: a value no column type accepts still binds', async () => {
        const { repo, executed } = setup(Widget);

        // age is INT; a string condition would fail write validation, but delete() binds it as supplied
        await repo.delete({ id: 'w1', age: 'not-an-int' } as never);

        expect(executed).toHaveLength(1);
        expect(executed[0].query).toBe('DELETE FROM widgets WHERE id = ? AND age = ?');
    });

    it('reads do not validate: findBy binds a mismatched value as supplied', async () => {
        const { repo, executed } = setup(Widget);

        await repo.findBy({ age: 'not-an-int' } as never, true);

        expect(executed).toHaveLength(1);
        expect(executed[0].query).toContain('SELECT * FROM widgets WHERE age = ?');
    });
});
