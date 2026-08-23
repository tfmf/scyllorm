import { describe, it, expect, vi } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { EntityNotFoundError, InvalidQueryError, UnknownColumnError } from '../../errors';

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

let sequence = 0;

@Entity('widgets')
class Widget extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT', { default: 'pending' })
    status: string;

    @Column('INT', { default: () => 100 + sequence++ })
    priority: number;

    @Column('TEXT')
    name: string;
}

function makeRepo(): { repo: Repository<Widget>; executed: Array<{ query: string; params: unknown[] }> } {
    const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
    const executed: Array<{ query: string; params: unknown[] }> = [];
    vi.spyOn(ds, 'executeQuery').mockImplementation(async (query: string, params: unknown[]) => {
        executed.push({ query, params });
        return [] as never;
    });
    const repo = ds.getRepository(Widget);
    return { repo, executed };
}

describe('create()', () => {
    it('returns an instance with column defaults applied when called with no argument', () => {
        const { repo } = makeRepo();
        const widget = repo.create();
        expect(widget.status).toBe('pending');
        expect(typeof widget.priority).toBe('number');
    });

    it('calls a function default and applies its return value', () => {
        const { repo } = makeRepo();
        const before = sequence;
        const widget = repo.create();
        expect(widget.priority).toBe(100 + before);
    });

    it('lets plain values override defaults', () => {
        const { repo } = makeRepo();
        const widget = repo.create({ status: 'active' });
        expect(widget.status).toBe('active');
    });

    it('does not let an undefined value erase a default', () => {
        const { repo } = makeRepo();
        const widget = repo.create({ status: undefined });
        expect(widget.status).toBe('pending');
    });

    it('ignores undeclared keys (mass-assignment safety)', () => {
        const { repo } = makeRepo();
        const widget = repo.create({ isAdmin: true } as never);
        expect((widget as never as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    });

    it('ignores keys inherited from the prototype chain of plain', () => {
        const { repo } = makeRepo();
        const proto = { name: 'from-proto' };
        const plain = Object.create(proto);
        plain.status = 'active';

        const widget = repo.create(plain);
        expect(widget.status).toBe('active');
        expect(widget.name).toBeUndefined();
    });

    it('returns an object that is an instance of the entity class', () => {
        const { repo } = makeRepo();
        const widget = repo.create();
        expect(widget).toBeInstanceOf(Widget);
    });

    it('assigns declared columns present in plain', () => {
        const { repo } = makeRepo();
        const widget = repo.create({ name: 'Gizmo' });
        expect(widget.name).toBe('Gizmo');
    });

    it('does not touch the DataSource', () => {
        const { repo, executed } = makeRepo();
        repo.create({ name: 'Gizmo' });
        expect(executed.length).toBe(0);
    });
});

describe('findOneOrFail()', () => {
    it('returns the mapped entity when a row is found', async () => {
        const ds = new DataSource({ contactPoints: ['x'], localDataCenter: 'dc1' } as never);
        vi.spyOn(ds, 'executeQuery').mockImplementation(async () => {
            return [{ id: 'abc', status: 'active', priority: 1, name: 'Gizmo' }] as never;
        });
        const repo = ds.getRepository(Widget);

        const found = await repo.findOneOrFail({ id: 'abc' });
        expect(found).toBeInstanceOf(Widget);
        expect(found.name).toBe('Gizmo');
    });

    it('throws EntityNotFoundError when no row matches', async () => {
        const { repo } = makeRepo();
        await expect(repo.findOneOrFail({ id: 'SECRET_VALUE' })).rejects.toThrow(EntityNotFoundError);
    });

    it('carries entity, table and criteriaColumns, and never echoes the condition value', async () => {
        const { repo } = makeRepo();

        try {
            await repo.findOneOrFail({ id: 'SECRET_VALUE' });
            expect.unreachable('findOneOrFail() should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(EntityNotFoundError);
            const notFound = error as EntityNotFoundError;
            expect(notFound.code).toBe('SCYLLORM_ENTITY_NOT_FOUND');
            expect(notFound.entity).toBe('Widget');
            expect(notFound.table).toBe('widgets');
            expect(notFound.criteriaColumns).toEqual(['id']);
            expect(notFound.message).toContain('id');
            expect(notFound.message).not.toContain('SECRET_VALUE');
        }
    });

    it('propagates UnknownColumnError for an undeclared condition column, not EntityNotFoundError', async () => {
        const { repo, executed } = makeRepo();

        await expect(repo.findOneOrFail({ nope: 'x' } as never)).rejects.toThrow(UnknownColumnError);
        await expect(repo.findOneOrFail({ nope: 'x' } as never)).rejects.toMatchObject({
            code: 'SCYLLORM_UNKNOWN_COLUMN',
        });
        expect(executed.length).toBe(0);
    });

    it('propagates InvalidQueryError for empty conditions, not EntityNotFoundError', async () => {
        const { repo, executed } = makeRepo();

        await expect(repo.findOneOrFail({})).rejects.toThrow(InvalidQueryError);
        await expect(repo.findOneOrFail({})).rejects.toMatchObject({ code: 'SCYLLORM_INVALID_QUERY' });
        expect(executed.length).toBe(0);
    });
});

describe('clear()', () => {
    it('produces a byte-exact TRUNCATE with empty params', async () => {
        const { repo, executed } = makeRepo();

        await repo.clear();

        expect(executed.length).toBe(1);
        expect(executed[0].query).toBe('TRUNCATE widgets');
        expect(executed[0].params).toEqual([]);
    });
});
