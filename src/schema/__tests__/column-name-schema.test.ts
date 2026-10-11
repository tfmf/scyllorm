import { describe, it, expect } from 'vitest';
import { buildCreateTable, buildCreateIndexes, buildSchema } from '../SchemaBuilder';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { Index } from '../../decorators/IndexDecorator';
import { InvalidQueryError, UnknownColumnError } from '../../errors';

@Entity('cns_users')
@Index('cns_users_by_email', 'emailAddress')
@Index('cns_users_by_city', 'city')
class User extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true, name: 'user_id' })
    userId: string;

    @Column('TEXT', { name: 'email_address' })
    emailAddress: string;

    @Column('TEXT')
    city: string;

    @Column('LIST', { of: 'TEXT', name: 'nick_names' })
    nickNames: string[];

    @Column('MAP', { of: ['TEXT', 'INT'], name: 'score_map' })
    scoreMap: Map<string, number>;
}

@Entity('cns_events')
class Event extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true, name: 'tenant_id' })
    tenantId: string;

    @PrimaryKeyColumn('DATE', { partitionKey: true, name: 'event_day' })
    day: string;

    @PrimaryKeyColumn('TIMESTAMP', { clusteringKey: true, order: 'DESC', name: 'created_at' })
    createdAt: Date;

    @PrimaryKeyColumn('TIMEUUID', { clusteringKey: true, name: 'event_id' })
    eventId: string;

    @PrimaryKeyColumn('INT', { clusteringKey: true, order: 'ASC' })
    seq: number;

    @Column('TEXT', { name: 'payload_text' })
    payload: string;
}

@Entity('cns_plain')
@Index('cns_plain_by_label', 'label')
class Plain extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @PrimaryKeyColumn('TIMESTAMP', { clusteringKey: true, order: 'DESC' })
    createdAt: Date;

    @Column('TEXT')
    label: string;
}

@Entity('cns_base')
class Base extends BaseModel {
    @PrimaryKeyColumn('TEXT', { partitionKey: true, name: 'base_id' })
    id: string;

    @Column('TEXT', { name: 'label_text' })
    label: string;
}

@Entity('cns_child')
@Index('cns_child_by_label', 'label')
class Child extends Base {
    @Column('TEXT', { name: 'title_text' })
    label: string;
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

describe('buildCreateTable() with column names', () => {
    it('emits the database name in every column definition and the PRIMARY KEY', () => {
        expect(buildCreateTable(User)).toBe(
            'CREATE TABLE IF NOT EXISTS cns_users (' +
                'user_id uuid, email_address text, city text, nick_names list<text>, score_map map<text, int>, ' +
                'PRIMARY KEY (user_id))'
        );
    });

    it('emits database names for composite partition keys, clustering keys and CLUSTERING ORDER BY', () => {
        expect(buildCreateTable(Event)).toBe(
            'CREATE TABLE IF NOT EXISTS cns_events (' +
                'tenant_id uuid, event_day date, created_at timestamp, event_id timeuuid, seq int, ' +
                'payload_text text, ' +
                'PRIMARY KEY ((tenant_id, event_day), created_at, event_id, seq)) ' +
                'WITH CLUSTERING ORDER BY (created_at DESC, event_id ASC, seq ASC)'
        );
    });

    it('a single renamed partition key renders without parentheses', () => {
        const entity = fakeEntity({
            primaryKeys: [
                { name: 'id', type: 'UUID', options: { partitionKey: true, name: 'row_id' } },
                { name: 'seq', type: 'INT', options: { clusteringKey: true, name: 'seq_no', order: 'DESC' } },
            ],
            columns: [
                { name: 'id', type: 'UUID', options: { name: 'row_id' } },
                { name: 'seq', type: 'INT', options: { name: 'seq_no' } },
            ],
        });

        expect(buildCreateTable(entity)).toBe(
            'CREATE TABLE IF NOT EXISTS fake (row_id uuid, seq_no int, PRIMARY KEY (row_id, seq_no)) ' +
                'WITH CLUSTERING ORDER BY (seq_no DESC)'
        );
    });

    it('a primary key whose rename sits only on the primaryKeys entry still renders under it', () => {
        const entity = fakeEntity({
            primaryKeys: [{ name: 'id', type: 'UUID', options: { partitionKey: true, name: 'row_id' } }],
            columns: [{ name: 'id', type: 'UUID', options: { partitionKey: true, name: 'row_id' } }],
        });

        expect(buildCreateTable(entity)).toBe('CREATE TABLE IF NOT EXISTS fake (row_id uuid, PRIMARY KEY (row_id))');
    });

    it('does not leak the property name anywhere in the DDL', () => {
        const ddl = buildCreateTable(Event);

        for (const property of ['tenantId', 'createdAt', 'eventId', 'payload ']) {
            expect(ddl).not.toContain(property);
        }
    });

    it('an unrenamed camelCase property is emitted as declared, as before', () => {
        expect(buildCreateTable(Plain)).toBe(
            'CREATE TABLE IF NOT EXISTS cns_plain (id uuid, createdAt timestamp, label text, ' +
                'PRIMARY KEY (id, createdAt)) WITH CLUSTERING ORDER BY (createdAt DESC)'
        );
    });

    it('a subclass override renders its own name in the inherited position; the parent is unchanged', () => {
        expect(buildCreateTable(Child)).toBe(
            'CREATE TABLE IF NOT EXISTS cns_child (base_id text, title_text text, PRIMARY KEY (base_id))'
        );
        expect(buildCreateTable(Base)).toBe(
            'CREATE TABLE IF NOT EXISTS cns_base (base_id text, label_text text, PRIMARY KEY (base_id))'
        );
    });

    it('validates the database name as a schema identifier, not the property name', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'value', type: 'TEXT', options: { name: 'bad-name' } },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/Invalid column identifier "bad-name"/);
    });

    // CQL's unquoted identifiers start with a letter; the server rejects `_x` as a syntax error
    it.each([
        [
            'a column name',
            {
                columns: [
                    { name: 'id', type: 'UUID' },
                    { name: 'x', type: 'TEXT', options: { name: '_x' } },
                ],
            },
        ],
        [
            'a property name',
            {
                columns: [
                    { name: 'id', type: 'UUID' },
                    { name: '_x', type: 'TEXT' },
                ],
            },
        ],
    ])('rejects a leading underscore in %s, like the Repository does', (_label, metadata) => {
        const entity = fakeEntity(metadata as never);

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/Invalid column identifier "_x".*must start with a letter and/);
    });

    it('validates a renamed primary key in the PRIMARY KEY clause', () => {
        const entity = fakeEntity({
            primaryKeys: [{ name: 'id', type: 'UUID', options: { partitionKey: true, name: 'bad key' } }],
            columns: [{ name: 'id', type: 'UUID', options: { name: 'ok_key' } }],
        });

        expect(() => buildCreateTable(entity)).toThrow(/Invalid column identifier "bad key"/);
    });

    it('a rename makes an otherwise invalid property name emit validly', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'bad-prop', type: 'TEXT', options: { name: 'good_prop' } },
            ],
        });

        expect(buildCreateTable(entity)).toBe(
            'CREATE TABLE IF NOT EXISTS fake (id uuid, good_prop text, PRIMARY KEY (id))'
        );
    });

    it('reports type errors of a renamed column by property name', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'tags', type: 'LIST', options: { name: 'tag_list' } },
            ],
        });

        expect(() => buildCreateTable(entity)).toThrow(InvalidQueryError);
        expect(() => buildCreateTable(entity)).toThrow(/"tags"/);
    });
});

describe('buildCreateIndexes() with column names', () => {
    // Class decorators apply bottom-up, so the lower @Index is declared first
    it('an index declared by property name renders the database name', () => {
        expect(buildCreateIndexes(User)).toEqual([
            'CREATE INDEX IF NOT EXISTS cns_users_by_city ON cns_users (city)',
            'CREATE INDEX IF NOT EXISTS cns_users_by_email ON cns_users (email_address)',
        ]);
    });

    it('an index on a column without a rename is unchanged', () => {
        expect(buildCreateIndexes(Plain)).toEqual([
            'CREATE INDEX IF NOT EXISTS cns_plain_by_label ON cns_plain (label)',
        ]);
    });

    it('an index declared by the database name is an UnknownColumnError listing property names', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'emailAddress', type: 'TEXT', options: { name: 'email_address' } },
            ],
            indexes: [{ name: 'by_email', column: 'email_address' }],
        });

        const error = (() => {
            try {
                buildCreateIndexes(entity);
            } catch (e) {
                return e as UnknownColumnError;
            }
        })();

        expect(error).toBeInstanceOf(UnknownColumnError);
        expect(error?.column).toBe('email_address');
        expect(error?.knownColumns).toEqual(['id', 'emailAddress']);
    });

    it('an index on an overridden column follows the subclass name', () => {
        expect(buildCreateIndexes(Child)).toEqual([
            'CREATE INDEX IF NOT EXISTS cns_child_by_label ON cns_child (title_text)',
        ]);
    });

    it('validates the database name of an indexed column', () => {
        const entity = fakeEntity({
            columns: [
                { name: 'id', type: 'UUID' },
                { name: 'value', type: 'TEXT', options: { name: 'bad-name' } },
            ],
            indexes: [{ name: 'by_value', column: 'value' }],
        });

        expect(() => buildCreateIndexes(entity)).toThrow(/Invalid column identifier "bad-name"/);
    });
});

describe('buildSchema() with column names', () => {
    it('returns the table then its indexes, all under database names', () => {
        expect(buildSchema(User)).toEqual([
            buildCreateTable(User),
            'CREATE INDEX IF NOT EXISTS cns_users_by_city ON cns_users (city)',
            'CREATE INDEX IF NOT EXISTS cns_users_by_email ON cns_users (email_address)',
        ]);
    });
});
