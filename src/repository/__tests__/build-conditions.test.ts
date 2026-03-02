import { describe, it, expect, vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { In, LessThan, GreaterThan, LessThanOrEqual, GreaterThanOrEqual } from '../query-utils';

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

@Entity('products')
class Product extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('INT')
    price: number;

    @Column('TEXT')
    category: string;
}

describe('buildConditionStringAndParams (via find/findBy)', () => {
    let executeSpy: ReturnType<typeof vi.fn>;
    let repo: Repository<Product>;

    beforeEach(async () => {
        const ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
        await ds.initialize();
        repo = ds.getRepository<Product>(Product);
        executeSpy = vi.fn().mockResolvedValue([]);
        (ds as any).executeQuery = executeSpy;
    });

    it('should generate simple equality condition', async () => {
        await repo.find({ where: { name: 'Widget' } });
        const query = executeSpy.mock.calls[0][0] as string;
        const params = executeSpy.mock.calls[0][1];
        expect(query).toContain('WHERE name = ?');
        expect(params).toEqual(['Widget']);
    });

    it('should generate IN condition', async () => {
        await repo.find({ where: { category: In(['A', 'B', 'C']) } });
        const query = executeSpy.mock.calls[0][0] as string;
        const params = executeSpy.mock.calls[0][1];
        expect(query).toContain('WHERE category IN (?, ?, ?)');
        expect(params).toEqual(['A', 'B', 'C']);
    });

    it('should generate LessThan condition', async () => {
        await repo.find({ where: { price: LessThan(100) } });
        const query = executeSpy.mock.calls[0][0] as string;
        const params = executeSpy.mock.calls[0][1];
        expect(query).toContain('WHERE price < ?');
        expect(params).toEqual([100]);
    });

    it('should generate GreaterThan condition', async () => {
        await repo.find({ where: { price: GreaterThan(50) } });
        const query = executeSpy.mock.calls[0][0] as string;
        expect(query).toContain('WHERE price > ?');
    });

    it('should generate LessThanOrEqual condition', async () => {
        await repo.find({ where: { price: LessThanOrEqual(100) } });
        const query = executeSpy.mock.calls[0][0] as string;
        expect(query).toContain('WHERE price <= ?');
    });

    it('should generate GreaterThanOrEqual condition', async () => {
        await repo.find({ where: { price: GreaterThanOrEqual(50) } });
        const query = executeSpy.mock.calls[0][0] as string;
        expect(query).toContain('WHERE price >= ?');
    });

    it('should combine multiple conditions with AND', async () => {
        await repo.find({ where: { name: 'Widget', price: GreaterThan(10) } });
        const query = executeSpy.mock.calls[0][0] as string;
        expect(query).toContain('WHERE name = ? AND price > ?');
    });

    it('should generate correct CQL via findBy', async () => {
        await repo.findBy({ category: 'electronics' });
        const query = executeSpy.mock.calls[0][0] as string;
        expect(query).toContain('WHERE category = ?');
    });

    it('should append ALLOW FILTERING when requested', async () => {
        await repo.find({ where: { name: 'Widget' } }, true);
        const query = executeSpy.mock.calls[0][0] as string;
        expect(query).toContain('ALLOW FILTERING');
    });
});
