import { describe, it, expect } from 'vitest';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column, UserDefinedType } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { Index } from '../../decorators/IndexDecorator';
import { InvalidQueryError } from '../../errors';
import { buildCreateTypes, buildSchema, buildCreateTable } from '../SchemaBuilder';

const geo: UserDefinedType = { name: 'geo', fields: { lat: 'DOUBLE', lon: 'DOUBLE' } };
const address: UserDefinedType = {
    name: 'address',
    fields: { street: 'TEXT', geo: { type: 'UDT', udt: geo }, tags: { type: 'SET', of: 'TEXT' } },
};

/** Builds an entity with one extra column, on a given table. */
function entityWith(table: string, type: 'UDT' | 'LIST' | 'SET' | 'MAP', options?: object): typeof BaseModel {
    @Entity(table)
    class Subject extends BaseModel {
        @PrimaryKeyColumn('UUID', { partitionKey: true })
        id: string;

        @Column(type, options)
        value: unknown;
    }

    return Subject;
}

describe('buildCreateTypes()', () => {
    it('emits nested types before their dependents', () => {
        expect(buildCreateTypes(entityWith('places', 'UDT', { udt: address }))).toEqual([
            'CREATE TYPE IF NOT EXISTS geo (lat double, lon double)',
            'CREATE TYPE IF NOT EXISTS address (street text, geo frozen<geo>, tags set<text>)',
        ]);
    });

    it('dedupes one type reached twice and by case-folded name', () => {
        @Entity('twice')
        class Twice extends BaseModel {
            @PrimaryKeyColumn('UUID', { partitionKey: true })
            id: string;

            @Column('UDT', { udt: geo })
            a: unknown;

            @Column('LIST', { of: 'UDT', udt: { name: 'GEO', fields: { lat: 'DOUBLE', lon: 'DOUBLE' } } })
            b: unknown;
        }

        expect(buildCreateTypes(Twice)).toEqual(['CREATE TYPE IF NOT EXISTS geo (lat double, lon double)']);
    });

    it('rejects one name with two definitions', () => {
        @Entity('clash')
        class Clash extends BaseModel {
            @PrimaryKeyColumn('UUID', { partitionKey: true })
            id: string;

            @Column('UDT', { udt: geo })
            a: unknown;

            @Column('UDT', { udt: { name: 'geo', fields: { lat: 'INT' } } })
            b: unknown;
        }

        expect(() => buildCreateTypes(Clash)).toThrow(InvalidQueryError);
        expect(() => buildCreateTypes(Clash)).toThrow(/defined twice/);
    });

    it('treats definitions that differ only in the case of a nested type name as one', () => {
        const pin: UserDefinedType = { name: 'pin', fields: { x: 'INT' } };

        @Entity('cased')
        class Cased extends BaseModel {
            @PrimaryKeyColumn('UUID', { partitionKey: true })
            id: string;

            @Column('UDT', { udt: { name: 'spot', fields: { at: { type: 'UDT', udt: pin } } } })
            a: unknown;

            @Column('UDT', { udt: { name: 'spot', fields: { at: { type: 'UDT', udt: 'PIN' } } } })
            b: unknown;
        }

        expect(buildCreateTypes(Cased)).toEqual([
            'CREATE TYPE IF NOT EXISTS pin (x int)',
            'CREATE TYPE IF NOT EXISTS spot (at frozen<pin>)',
        ]);
    });

    it('rejects a type that reaches itself, directly or through another', () => {
        const a: UserDefinedType = { name: 'a', fields: {} };
        const b: UserDefinedType = { name: 'b', fields: { a: { type: 'UDT', udt: a } } };
        a.fields.b = { type: 'UDT', udt: b };

        expect(() => buildCreateTypes(entityWith('loop', 'UDT', { udt: a }))).toThrow(/contains itself/);

        const self: UserDefinedType = { name: 'self', fields: {} };
        self.fields.me = { type: 'LIST', of: 'UDT', udt: self };

        expect(() => buildCreateTypes(entityWith('loop2', 'UDT', { udt: self }))).toThrow(/contains itself/);
    });

    it('prefixes types with the keyspace of a qualified table', () => {
        expect(buildCreateTypes(entityWith('ks.places', 'UDT', { udt: geo }))).toEqual([
            'CREATE TYPE IF NOT EXISTS ks.geo (lat double, lon double)',
        ]);
    });

    it('rejects field names that are not lowercase snake case', () => {
        for (const field of ['camelCase', '1x', 'a-b', '_x', 'a b']) {
            const udt: UserDefinedType = { name: 'bad', fields: { [field]: 'TEXT' } };

            expect(() => buildCreateTypes(entityWith('t', 'UDT', { udt }))).toThrow(/Invalid field identifier/);
        }
    });

    it('rejects a type name that is not a schema identifier', () => {
        const udt: UserDefinedType = { name: 'a.b', fields: { x: 'TEXT' } };

        expect(() => buildCreateTypes(entityWith('t', 'UDT', { udt }))).toThrow(/Invalid type identifier/);
        expect(() => buildCreateTable(entityWith('t', 'UDT', { udt: 'a b' }))).toThrow(/Invalid type identifier/);
    });

    it('rejects a type with no fields', () => {
        expect(() => buildCreateTypes(entityWith('t', 'UDT', { udt: { name: 'empty', fields: {} } }))).toThrow(
            /declares no fields/
        );
    });

    it('rejects COUNTER, TUPLE and FROZEN fields', () => {
        for (const type of ['COUNTER', 'TUPLE', 'FROZEN'] as const) {
            const udt: UserDefinedType = { name: 'bad', fields: { x: type } };

            expect(() => buildCreateTypes(entityWith('t', 'UDT', { udt }))).toThrow(/not supported by the schema/);
        }
    });

    it('rejects a UDT field with no udt option', () => {
        const udt: UserDefinedType = { name: 'bad', fields: { x: 'UDT' } };

        expect(() => buildCreateTypes(entityWith('t', 'UDT', { udt }))).toThrow(/declares no udt option/);
    });

    it('never creates a type named by a string', () => {
        expect(buildCreateTypes(entityWith('t', 'UDT', { udt: 'external' }))).toEqual([]);
        expect(buildCreateTypes(entityWith('t', 'LIST', { of: 'UDT', udt: 'external' }))).toEqual([]);
    });

    it('creates types for LIST, SET and MAP columns of UDT', () => {
        expect(buildCreateTypes(entityWith('t', 'LIST', { of: 'UDT', udt: geo }))).toHaveLength(1);
        expect(buildCreateTypes(entityWith('t', 'SET', { of: 'UDT', udt: geo }))).toHaveLength(1);
        expect(buildCreateTypes(entityWith('t', 'MAP', { of: ['TEXT', 'UDT'], udt: geo }))).toHaveLength(1);
    });
});

describe('UDT column types', () => {
    const type = (options: object, kind: 'UDT' | 'LIST' | 'SET' | 'MAP' = 'UDT') =>
        buildCreateTable(entityWith('t', kind, options));

    it('renders frozen by default and bare when frozen is false', () => {
        expect(type({ udt: geo })).toBe('CREATE TABLE IF NOT EXISTS t (id uuid, value frozen<geo>, PRIMARY KEY (id))');
        expect(type({ udt: geo, frozen: false })).toBe(
            'CREATE TABLE IF NOT EXISTS t (id uuid, value geo, PRIMARY KEY (id))'
        );
        expect(type({ udt: 'geo', frozen: true })).toContain('value frozen<geo>');
    });

    it('renders collection elements as frozen, whatever frozen says', () => {
        expect(type({ of: 'UDT', udt: geo, frozen: false }, 'LIST')).toContain('value list<frozen<geo>>');
        expect(type({ of: 'UDT', udt: 'geo' }, 'SET')).toContain('value set<frozen<geo>>');
        expect(type({ of: ['TEXT', 'UDT'], udt: geo }, 'MAP')).toContain('value map<text, frozen<geo>>');
        expect(type({ of: ['UDT', 'INT'], udt: geo }, 'MAP')).toContain('value map<frozen<geo>, int>');
    });

    it('rejects a missing udt option', () => {
        expect(() => type({})).toThrow(InvalidQueryError);
        expect(() => type({})).toThrow(/declares no udt option/);
        expect(() => type({ of: 'UDT' }, 'LIST')).toThrow(/declares no udt option/);
        expect(() => type({ of: ['TEXT', 'UDT'] }, 'MAP')).toThrow(/declares no udt option/);
    });

    it('keeps collection element rules for other types', () => {
        expect(() => type({ of: 'LIST' }, 'LIST')).toThrow(/not supported/);
    });
});

describe('buildSchema() with UDTs', () => {
    it('puts the types first, then the table, then the indexes', () => {
        @Entity('ks.shops')
        @Index('shops_by_name', 'name')
        class Shop extends BaseModel {
            @PrimaryKeyColumn('UUID', { partitionKey: true })
            id: string;

            @Column('TEXT')
            name: string;

            @Column('UDT', { udt: geo })
            location: unknown;
        }

        expect(buildSchema(Shop)).toEqual([
            'CREATE TYPE IF NOT EXISTS ks.geo (lat double, lon double)',
            'CREATE TABLE IF NOT EXISTS ks.shops (id uuid, name text, location frozen<geo>, PRIMARY KEY (id))',
            'CREATE INDEX IF NOT EXISTS shops_by_name ON ks.shops (name)',
        ]);
    });

    it('is byte-identical for an entity without UDT objects', () => {
        @Entity('plain')
        @Index('plain_by_name', 'name')
        class Plain extends BaseModel {
            @PrimaryKeyColumn('UUID', { partitionKey: true })
            id: string;

            @Column('TEXT')
            name: string;

            @Column('LIST', { of: 'INT' })
            nums: number[];

            @Column('UDT', { udt: 'managed_elsewhere' })
            ext: unknown;
        }

        expect(buildSchema(Plain)).toEqual([
            'CREATE TABLE IF NOT EXISTS plain (id uuid, name text, nums list<int>, ext frozen<managed_elsewhere>, ' +
                'PRIMARY KEY (id))',
            'CREATE INDEX IF NOT EXISTS plain_by_name ON plain (name)',
        ]);
        expect(buildCreateTypes(Plain)).toEqual([]);
    });

    describe('round 3 guards', () => {
        it('rejects a non-frozen UDT column whose type has a collection field, before any DDL', () => {
            @Entity('nf')
            class Nf extends BaseModel {
                @PrimaryKeyColumn('INT', { partitionKey: true })
                id: number;

                @Column('UDT', {
                    udt: { name: 'nf_t', fields: { a: 'INT', tags: { type: 'LIST', of: 'TEXT' } } },
                    frozen: false,
                })
                u: unknown;
            }

            expect(() => buildSchema(Nf)).toThrow(/non-frozen UDT with a collection field/);
            expect(() => buildCreateTypes(Nf)).not.toThrow();
        });

        it('still renders a non-frozen UDT without collection fields, and a named one, bare', () => {
            @Entity('nf_ok')
            class NfOk extends BaseModel {
                @PrimaryKeyColumn('INT', { partitionKey: true })
                id: number;

                @Column('UDT', {
                    udt: { name: 'pt', fields: { x: 'INT', inner: { type: 'UDT', udt: 'other' } } },
                    frozen: false,
                })
                p: unknown;

                @Column('UDT', { udt: 'external', frozen: false })
                q: unknown;
            }

            expect(buildCreateTable(NfOk)).toBe(
                'CREATE TABLE IF NOT EXISTS nf_ok (id int, p pt, q external, PRIMARY KEY (id))'
            );
        });

        it('rejects a field named after an Object.prototype member', () => {
            @Entity('ctors')
            class Ctor extends BaseModel {
                @PrimaryKeyColumn('INT', { partitionKey: true })
                id: number;

                @Column('UDT', { udt: { name: 'ctor_t', fields: { constructor: 'TEXT', label: 'TEXT' } } })
                body: unknown;
            }

            expect(() => buildCreateTypes(Ctor)).toThrow(InvalidQueryError);
            expect(() => buildCreateTypes(Ctor)).toThrow(/constructor/);
        });
    });
});
