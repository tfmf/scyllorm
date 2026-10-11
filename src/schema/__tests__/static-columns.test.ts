import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCreateTable } from '../SchemaBuilder';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../../repository/Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { InvalidQueryError } from '../../errors';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = '123e4567-e89b-42d3-a456-426614174000';
const E = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

vi.mock('cassandra-driver', async (importOriginal) => {
    class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        shutdown = vi.fn().mockResolvedValue(undefined);
        execute = vi.fn().mockResolvedValue({ rows: [] });
    }
    // Partial mock: real value types (`types.Long`, `types.Uuid`, …) stay available
    return {
        ...(await importOriginal<typeof import('cassandra-driver')>()),
        Client: MockClient,
        errors: {
            NoHostAvailableError: class extends Error {},
            DriverInternalError: class extends Error {},
        },
    };
});

@Entity('static_basic')
class StaticBasic extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    tenant_id: string;

    @PrimaryKeyColumn('TIMEUUID', { clusteringKey: true })
    event_id: string;

    @Column('TEXT', { static: true })
    tenant_name: string;

    @Column('TEXT')
    payload: string;
}

@Entity('static_multi')
class StaticMulti extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    tenant_id: string;

    @PrimaryKeyColumn('TIMEUUID', { clusteringKey: true })
    event_id: string;

    @Column('TEXT', { static: true })
    tenant_name: string;

    @Column('INT', { static: true })
    tenant_tier: number;

    @Column('TEXT')
    payload: string;
}

@Entity('static_special')
class StaticSpecial extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    tenant_id: string;

    @PrimaryKeyColumn('TIMEUUID', { clusteringKey: true })
    event_id: string;

    @Column('LIST', { of: 'TEXT', static: true })
    tags: string[];

    @Column('TEXT', { static: true, name: 'tenant_note' })
    note: string;
}

@Entity('static_off')
class StaticOff extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    tenant_id: string;

    @PrimaryKeyColumn('TIMEUUID', { clusteringKey: true })
    event_id: string;

    @Column('TEXT', { static: false })
    off_column: string;

    @Column('TEXT')
    absent_column: string;
}

@Entity('static_no_clustering')
class StaticNoClustering extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('TEXT', { static: true })
    shared: string;
}

@Entity('static_no_clustering_false')
class StaticNoClusteringFalse extends BaseModel {
    @PrimaryKeyColumn('UUID', { partitionKey: true })
    id: string;

    @Column('TEXT', { static: false })
    shared: string;
}

describe('static columns', () => {
    describe('buildCreateTable()', () => {
        it('renders STATIC after the type of a static column only', () => {
            expect(buildCreateTable(StaticBasic)).toEqual(
                'CREATE TABLE IF NOT EXISTS static_basic (' +
                    'tenant_id uuid, event_id timeuuid, tenant_name text STATIC, payload text, ' +
                    'PRIMARY KEY (tenant_id, event_id))'
            );
        });

        it('renders STATIC on every static column', () => {
            expect(buildCreateTable(StaticMulti)).toEqual(
                'CREATE TABLE IF NOT EXISTS static_multi (' +
                    'tenant_id uuid, event_id timeuuid, tenant_name text STATIC, tenant_tier int STATIC, ' +
                    'payload text, PRIMARY KEY (tenant_id, event_id))'
            );
        });

        it('renders STATIC after a collection type and after the name option', () => {
            expect(buildCreateTable(StaticSpecial)).toEqual(
                'CREATE TABLE IF NOT EXISTS static_special (' +
                    'tenant_id uuid, event_id timeuuid, tags list<text> STATIC, tenant_note text STATIC, ' +
                    'PRIMARY KEY (tenant_id, event_id))'
            );
        });

        it('renders static: false and an absent flag exactly as before', () => {
            const query = buildCreateTable(StaticOff);

            expect(query).toEqual(
                'CREATE TABLE IF NOT EXISTS static_off (' +
                    'tenant_id uuid, event_id timeuuid, off_column text, absent_column text, ' +
                    'PRIMARY KEY (tenant_id, event_id))'
            );
            expect(query).not.toContain('STATIC');
        });

        it('throws staticWithoutClustering when the entity has no clustering key', () => {
            const build = () => buildCreateTable(StaticNoClustering);

            expect(build).toThrow(InvalidQueryError);
            expect(build).toThrow(/Column "shared" on entity StaticNoClustering is static/);
            expect(build).toThrow(/no clustering key/);
        });

        it('reports the property name, not the name option, in the error', () => {
            @Entity('static_no_clustering_named')
            class Named extends BaseModel {
                @PrimaryKeyColumn('UUID', { partitionKey: true })
                id: string;

                @Column('TEXT', { static: true, name: 'db_shared' })
                sharedProp: string;
            }

            expect(() => buildCreateTable(Named)).toThrow(/Column "sharedProp" on entity Named is static/);
        });

        it('still builds a clustering-less table when no column is static', () => {
            expect(buildCreateTable(StaticNoClusteringFalse)).toEqual(
                'CREATE TABLE IF NOT EXISTS static_no_clustering_false (id uuid, shared text, PRIMARY KEY (id))'
            );
        });
    });

    describe('DataSource.synchronize()', () => {
        let ds: DataSource;

        beforeEach(async () => {
            vi.clearAllMocks();
            ds = new DataSource({ contactPoints: ['localhost'], localDataCenter: 'datacenter1', keyspace: 'test' });
            await ds.initialize();
        });

        it('sends the STATIC DDL', async () => {
            await ds.synchronize([StaticBasic]);

            const execute = (ds as any).client.execute;
            expect(execute.mock.calls.map((call: unknown[]) => call[0])).toEqual([
                'CREATE TABLE IF NOT EXISTS static_basic (' +
                    'tenant_id uuid, event_id timeuuid, tenant_name text STATIC, payload text, ' +
                    'PRIMARY KEY (tenant_id, event_id))',
            ]);
        });

        it('rejects on the failing entity, running none of its statements', async () => {
            await expect(ds.synchronize([StaticBasic, StaticNoClustering])).rejects.toThrow(InvalidQueryError);

            // The first entity's DDL ran; the failing entity ran nothing
            const sent = (ds as any).client.execute.mock.calls.map((call: unknown[]) => call[0]);
            expect(sent.some((query: string) => query.includes('static_no_clustering'))).toBe(false);
        });

        it('sends nothing when the failing entity is the only one', async () => {
            await expect(ds.synchronize([StaticNoClustering])).rejects.toThrow(/no clustering key/);

            expect((ds as any).client.execute).not.toHaveBeenCalled();
        });
    });

    describe('reads and writes are unchanged for a static column', () => {
        let repo: Repository<StaticBasic>;
        let executeSpy: ReturnType<typeof vi.fn>;

        beforeEach(async () => {
            vi.clearAllMocks();
            const ds = new DataSource({
                contactPoints: ['localhost'],
                localDataCenter: 'datacenter1',
                keyspace: 'test',
            });
            await ds.initialize();
            repo = ds.getRepository<StaticBasic>(StaticBasic);
            executeSpy = vi.fn().mockResolvedValue([]);
            (ds as any).executeQuery = executeSpy;
        });

        it('save() inserts the static column like any other', async () => {
            const entity = repo.create({ tenant_id: T, event_id: E, tenant_name: 'Acme', payload: 'p' });

            await repo.save(entity);

            expect(executeSpy.mock.calls[0][0]).toEqual(
                'INSERT INTO static_basic (tenant_id, event_id, tenant_name, payload) VALUES (?, ?, ?, ?)'
            );
            expect(executeSpy.mock.calls[0][1]).toEqual([T, E, 'Acme', 'p']);
        });

        it('update() sets the static column like any other', async () => {
            await repo.update({ tenant_id: T, event_id: E }, { tenant_name: 'Acme' });

            expect(executeSpy.mock.calls[0][0]).toEqual(
                'UPDATE static_basic SET tenant_name = ? WHERE tenant_id = ? AND event_id = ?'
            );
            expect(executeSpy.mock.calls[0][1]).toEqual(['Acme', T, E]);
        });

        it('find() filters and selects the static column like any other', async () => {
            await repo.find({ where: { tenant_name: 'Acme' }, select: ['tenant_name'] }, true);

            expect(executeSpy.mock.calls[0][0]).toEqual(
                'SELECT tenant_name FROM static_basic WHERE tenant_name = ? ALLOW FILTERING'
            );
            expect(executeSpy.mock.calls[0][1]).toEqual(['Acme']);
        });
    });
});
