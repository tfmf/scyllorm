import { describe, it, expect } from 'vitest';
import { buildCreateTable, buildCreateIndexes, buildSchema } from '../SchemaBuilder';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column, ColumnType } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { Index } from '../../decorators/IndexDecorator';
import { InvalidQueryError, UnknownColumnError } from '../../errors';

@Entity('users')
@Index('users_by_email', 'email')
class User extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('TEXT')
    email: string;

    @Column('INT')
    age: number;
}

@Entity('events')
class Event extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    tenant_id: string;

    @PrimaryKeyColumn('DATE', { partitionKey: true })
    day: string;

    @PrimaryKeyColumn('TIMESTAMP', { clusteringKey: true, order: 'DESC' })
    created_at: Date;

    @PrimaryKeyColumn('TIMEUUID', { clusteringKey: true })
    event_id: string;

    @Column('TEXT')
    payload: string;
}

@Entity('profiles')
class Profile extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('LIST', { of: 'TEXT' })
    tags: string[];

    @Column('SET', { of: 'INT' })
    codes: number[];

    @Column('MAP', { of: ['TEXT', 'INT'] })
    counts: Map<string, number>;
}

// Builds a metadata-only entity, for shapes the decorators would not produce
function fakeEntity(overrides: Partial<typeof BaseModel>): typeof BaseModel {
    class Fake extends BaseModel {}
    Object.assign(Fake, {
        tableName: 'fake',
        primaryKeys: [{ name: 'id', type: 'UUID', options: { partitionKey: true } }],
        columns: [{ name: 'id', type: 'UUID' }],
        ...overrides,
    });
    return Fake;
}

describe('buildCreateTable()', () => {
    it('builds a simple table with a single partition key', () => {
        expect(buildCreateTable(User)).toBe(
            'CREATE TABLE IF NOT EXISTS users (id uuid, email text, age int, PRIMARY KEY (id))'
        );
    });

    it('builds a composite partition key and clustering keys with clustering order', () => {
        expect(buildCreateTable(Event)).toBe(
            'CREATE TABLE IF NOT EXISTS events (' +
                'tenant_id uuid, day date, created_at timestamp, event_id timeuuid, payload text, ' +
                'PRIMARY KEY ((tenant_id, day), created_at, event_id)) ' +
                'WITH CLUSTERING ORDER BY (created_at DESC, event_id ASC)'
        );
    });

    it('omits the clustering order clause when no clustering key declares an order', () => {
        const entity = fakeEntity({
            primaryKeys: [
                { name: 'id', type: 'UUID', options: { partitionKey: true } },
                { name: 'seq', type: 'INT', options: { clusteringKey: true } },
            ],
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'seq', type: 'INT' },
            ],
        });

        expect(buildCreateTable(entity)).toBe(
            'CREATE TABLE IF NOT EXISTS fake (id uuid, seq int, PRIMARY KEY (id, seq))'
        );
    });

    it('renders collection columns from their element types', () => {
        expect(buildCreateTable(Profile)).toBe(
            'CREATE TABLE IF NOT EXISTS profiles (' +
                'id uuid, tags list<text>, codes set<int>, counts map<text, int>, PRIMARY KEY (id))'
        );
    });

    it('throws when the entity declares no partition key', () => {
        const entity = fakeEntity({
            primaryKeys: [{ name: 'id', type: 'UUID', options: { clusteringKey: true } }],
        });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/no partition key/);
    });

    it('throws on a primary key with neither role flag, instead of silently dropping it from the key', () => {
        const entity = fakeEntity({
            primaryKeys: [
                { name: 'id', type: 'UUID', options: { partitionKey: true } },
                { name: 'created_at', type: 'TIMEUUID' },
            ],
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'created_at', type: 'TIMEUUID' },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/neither a partition key nor a clustering key/);
    });

    it('throws on a primary key flagged as both partition and clustering key', () => {
        const entity = fakeEntity({
            primaryKeys: [{ name: 'id', type: 'UUID', options: { partitionKey: true, clusteringKey: true } }],
        });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/both a partition key and a clustering key/);
    });

    it('throws on a LIST column without an element type', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'tags', type: 'LIST' },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/no element type/);
    });

    it('throws on a MAP column whose element type is not a [key, value] pair', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'counts', type: 'MAP', options: { of: 'TEXT' } },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(/no element type/);
    });

    it('throws on a nested collection element type', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'tags', type: 'LIST', options: { of: 'SET' as ColumnType } },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(/not supported by the schema builder/);
    });

    it('throws on a FROZEN element type inside a collection', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'counts', type: 'MAP', options: { of: ['TEXT', 'FROZEN'] } },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(/not supported by the schema builder/);
    });

    it.each(['TUPLE', 'FROZEN'] as const)('throws on a %s column, pointing at manual creation', (type) => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'extra', type },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/Create this table manually/);
    });

    it('throws on an invalid clustering order direction', () => {
        const entity = fakeEntity({
            primaryKeys: [
                { name: 'id', type: 'UUID', options: { partitionKey: true } },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                { name: 'seq', type: 'INT', options: { clusteringKey: true, order: 'SIDEWAYS' as any } },
            ],
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'seq', type: 'INT' },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(/Invalid sort direction/);
    });

    it('rejects an injection attempt in the table name', () => {
        const entity = fakeEntity({ tableName: 'users; DROP TABLE x' });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/Invalid table identifier/);
    });

    it('rejects an injection attempt in a column name', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'age int, evil text', type: 'INT' },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(/Invalid column identifier/);
    });

    it('rejects a missing table name', () => {
        const entity = fakeEntity({ tableName: undefined });

        expect(() => buildCreateTable(entity)).toThrow(/Invalid table identifier/);
    });
});

describe('buildCreateIndexes()', () => {
    it('builds one CREATE INDEX per @Index', () => {
        expect(buildCreateIndexes(User)).toEqual(['CREATE INDEX IF NOT EXISTS users_by_email ON users (email)']);
    });

    it('returns an empty array for an entity with no indexes', () => {
        expect(buildCreateIndexes(Event)).toEqual([]);
    });

    it('throws UnknownColumnError when the index column does not exist on the entity', () => {
        const entity = fakeEntity({ indexes: [{ name: 'fake_by_ghost', column: 'ghost' }] });

        expect(() => buildCreateIndexes(entity)).toThrow(UnknownColumnError);
    });

    it('rejects an injection attempt in the index name', () => {
        const entity = fakeEntity({ indexes: [{ name: 'idx; DROP TABLE x', column: 'id' }] });

        expect(() => buildCreateIndexes(entity)).toThrow(/Invalid index identifier/);
    });
});

describe('buildSchema()', () => {
    it('returns the table statement first, then the index statements', () => {
        expect(buildSchema(User)).toEqual([
            'CREATE TABLE IF NOT EXISTS users (id uuid, email text, age int, PRIMARY KEY (id))',
            'CREATE INDEX IF NOT EXISTS users_by_email ON users (email)',
        ]);
    });
});
