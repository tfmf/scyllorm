import { describe, it, expect, vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';

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

@Entity('transform_test')
class TransformTestEntity extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('BIGINT')
    big_number: unknown;

    @Column('BLOB')
    data: Buffer;

    @Column('DECIMAL')
    price: unknown;

    @Column('INT')
    count: number;

    @Column('BOOLEAN')
    active: boolean;

    @Column('TEXT')
    name: string;

    @Column('UUID')
    ref_id: string;

    @Column('LIST')
    tags: string[];

    @Column('SET')
    categories: Set<string>;

    @Column('MAP')
    metadata: Map<string, string>;
}

// Access private transformValue through mapRowToEntity via the repository
function createTestRepo(): Repository<TransformTestEntity> {
    const ds = new DataSource({
        contactPoints: ['localhost'],
        localDataCenter: 'datacenter1',
        keyspace: 'test',
    });
    return ds.getRepository<TransformTestEntity>(TransformTestEntity);
}

describe('transformValue()', () => {
    // We test transformValue indirectly through mapRowToEntity by mocking executeQuery
    // to return raw rows, then checking what the repository gives back.

    it('should preserve Long objects for BIGINT (no precision loss)', async () => {
        const repo = createTestRepo();
        // Simulate a Long object from the driver
        const longValue = { low: 0, high: 1, toString: () => '4294967296' };

        const ds = (repo as any).dataSource;
        ds.executeQuery = vi.fn().mockResolvedValue([
            { id: 'test-uuid', big_number: longValue, data: null, price: null, count: null, active: null, name: null, ref_id: null, tags: null, categories: null, metadata: null },
        ]);

        const results = await repo.find();
        // The Long object should be preserved, not converted to number
        expect(results[0].big_number).toBe(longValue);
    });

    it('should preserve Buffer for BLOB (no re-encoding)', async () => {
        const repo = createTestRepo();
        const bufferValue = Buffer.from([0x00, 0xFF, 0x42]);

        const ds = (repo as any).dataSource;
        ds.executeQuery = vi.fn().mockResolvedValue([
            { id: 'test-uuid', big_number: null, data: bufferValue, price: null, count: null, active: null, name: null, ref_id: null, tags: null, categories: null, metadata: null },
        ]);

        const results = await repo.find();
        // The Buffer should be the exact same object, not re-encoded
        expect(results[0].data).toBe(bufferValue);
        expect(Buffer.compare(results[0].data, bufferValue)).toBe(0);
    });

    it('should preserve BigDecimal objects for DECIMAL (no precision loss)', async () => {
        const repo = createTestRepo();
        // Simulate a BigDecimal object from the driver
        const bigDecimalValue = { _intVal: BigInt(12345), _scale: 2, toString: () => '123.45' };

        const ds = (repo as any).dataSource;
        ds.executeQuery = vi.fn().mockResolvedValue([
            { id: 'test-uuid', big_number: null, data: null, price: bigDecimalValue, count: null, active: null, name: null, ref_id: null, tags: null, categories: null, metadata: null },
        ]);

        const results = await repo.find();
        // The BigDecimal object should be preserved
        expect(results[0].price).toBe(bigDecimalValue);
    });

    it('should pass through INT values as-is', async () => {
        const repo = createTestRepo();

        const ds = (repo as any).dataSource;
        ds.executeQuery = vi.fn().mockResolvedValue([
            { id: 'test-uuid', big_number: null, data: null, price: null, count: 42, active: null, name: null, ref_id: null, tags: null, categories: null, metadata: null },
        ]);

        const results = await repo.find();
        expect(results[0].count).toBe(42);
    });

    it('should pass through LIST/SET/MAP values without throwing', async () => {
        const repo = createTestRepo();
        const listValue = ['tag1', 'tag2'];
        const setValue = new Set(['cat1']);
        const mapValue = new Map([['key', 'value']]);

        const ds = (repo as any).dataSource;
        ds.executeQuery = vi.fn().mockResolvedValue([
            { id: 'test-uuid', big_number: null, data: null, price: null, count: null, active: null, name: null, ref_id: null, tags: listValue, categories: setValue, metadata: mapValue },
        ]);

        const results = await repo.find();
        expect(results[0].tags).toBe(listValue);
        expect(results[0].categories).toBe(setValue);
        expect(results[0].metadata).toBe(mapValue);
    });

    it('should handle null/undefined values', async () => {
        const repo = createTestRepo();

        const ds = (repo as any).dataSource;
        ds.executeQuery = vi.fn().mockResolvedValue([
            { id: 'test-uuid', big_number: null, data: undefined, price: null, count: null, active: null, name: null, ref_id: null, tags: null, categories: null, metadata: null },
        ]);

        const results = await repo.find();
        expect(results[0].big_number).toBeNull();
        expect(results[0].data).toBeUndefined();
    });

    it('should convert UUID to string', async () => {
        const repo = createTestRepo();
        const uuidObj = { toString: () => '550e8400-e29b-41d4-a716-446655440000' };

        const ds = (repo as any).dataSource;
        ds.executeQuery = vi.fn().mockResolvedValue([
            { id: uuidObj, big_number: null, data: null, price: null, count: null, active: null, name: null, ref_id: uuidObj, tags: null, categories: null, metadata: null },
        ]);

        const results = await repo.find();
        expect(results[0].id).toBe('550e8400-e29b-41d4-a716-446655440000');
        expect(typeof results[0].id).toBe('string');
    });
});
