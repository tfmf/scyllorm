import { describe, it, expect, vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column, UserDefinedType } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { ColumnValidationError } from '../../errors';
import { validateColumnValue } from '../type-validation';

const geo: UserDefinedType = { name: 'geo', fields: { lat: 'DOUBLE', lon: 'DOUBLE' } };

describe('UDT value validation', () => {
    const check = (value: unknown, udt?: string | UserDefinedType) =>
        validateColumnValue('E', 'loc', 'UDT', value, undefined, udt);

    it('accepts a plain object, null and undefined', () => {
        expect(() => check({ lat: 1, lon: 2 }, geo)).not.toThrow();
        expect(() => check({}, geo)).not.toThrow();
        expect(() => check(null, geo)).not.toThrow();
        expect(() => check(undefined, geo)).not.toThrow();
    });

    it('rejects arrays, Maps, Sets and primitives', () => {
        for (const value of [[1], new Map(), new Set(), 'x', 3, true]) {
            expect(() => check(value, geo)).toThrow(ColumnValidationError);
        }
    });

    it('rejects unknown keys, and miscased ones, only for object definitions', () => {
        expect(() => check({ lat: 1, alt: 3 }, geo)).toThrow(/only: lat, lon/);
        expect(() => check({ LAT: 1 }, geo)).toThrow(ColumnValidationError);
        expect(() => check({ alt: 3 }, 'geo')).not.toThrow();
        expect(() => check({ alt: 3 })).not.toThrow();
    });

    it('lets an empty undeclared key through, as a row read back from a wider live type carries', () => {
        expect(() => check({ lat: 1, lon: 2, country: null }, geo)).not.toThrow();
        expect(() => check({ lat: 1, country: undefined }, geo)).not.toThrow();
        expect(() => check({ lat: 1, country: 'PT' }, geo)).toThrow(ColumnValidationError);
    });

    it('does not put the value in the error', () => {
        expect.assertions(1);

        try {
            check({ secretkey: 'hunter2' }, geo);
        } catch (error) {
            expect((error as Error).message).not.toContain('hunter2');
        }
    });
});

@Entity('shops')
class Shop extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('UDT', {
        udt: geo,
        transformer: { to: (v) => v, from: (v) => ({ ...(v as object), seen: true }) },
    })
    loc: unknown;

    @Column('UDT', { udt: 'external' })
    other: unknown;
}

function setup(rows: object[] = []) {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const spy = vi.spyOn(ds, 'executeQuery').mockResolvedValue(rows as never);

    return { repo: ds.getRepository(Shop), spy };
}

describe('Repository with UDT columns', () => {
    it('writes a valid object and rejects an unknown key before any query', async () => {
        const { repo, spy } = setup();
        const shop = new Shop();
        shop.id = '123e4567-e89b-12d3-a456-426614174000';
        shop.loc = { lat: 1, lon: 2 };
        shop.other = { anything: 1 };
        await repo.save(shop);
        expect(spy).toHaveBeenCalled();

        spy.mockClear();
        shop.loc = { lat: 1, lng: 2 };
        await expect(repo.save(shop)).rejects.toThrow(ColumnValidationError);
        expect(spy).not.toHaveBeenCalled();
    });

    it('maps a UDT row value through, and applies transformer.from', async () => {
        const { repo } = setup([
            { id: '123e4567-e89b-12d3-a456-426614174000', loc: { lat: 1, lon: null }, other: { a: 1 } },
        ]);
        const [shop] = await repo.find();

        expect(shop.loc).toEqual({ lat: 1, lon: null, seen: true });
        expect(shop.other).toEqual({ a: 1 });
    });
});
