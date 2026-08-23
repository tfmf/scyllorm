import { describe, it, expect, vi, beforeEach } from 'vitest';
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

@Entity('hooked_items')
class HookedItem extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT')
    name: string;
}

@Entity('plain_items')
class PlainItem extends BaseModel {
    @PrimaryKeyColumn('TEXT')
    id: string;

    @Column('TEXT')
    name: string;
}

describe('lifecycle hooks', () => {
    let ds: DataSource;
    let repo: Repository<HookedItem>;
    let executeSpy: ReturnType<typeof vi.fn>;
    let calls: string[];

    beforeEach(async () => {
        vi.clearAllMocks();
        // Hooks are attached per test; a leftover from a previous test must not leak
        delete HookedItem.beforeUpdate;
        delete HookedItem.afterUpdate;
        delete HookedItem.beforeDelete;
        delete HookedItem.afterDelete;

        ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
        await ds.initialize();
        repo = ds.getRepository<HookedItem>(HookedItem);
        calls = [];
        executeSpy = vi.fn().mockImplementation(async () => {
            calls.push('query');
            return [];
        });
        (ds as any).executeQuery = executeSpy;
    });

    function makeItem(): HookedItem {
        const item = new HookedItem();
        item.id = 'abc-123';
        item.name = 'Widget';
        return item;
    }

    describe('save()', () => {
        it('runs beforeSave, then the INSERT, then afterSave', async () => {
            const item = makeItem();
            item.beforeSave = () => {
                calls.push('beforeSave');
            };
            item.afterSave = () => {
                calls.push('afterSave');
            };

            const result = await repo.save(item);

            expect(calls).toEqual(['beforeSave', 'query', 'afterSave']);
            expect(executeSpy).toHaveBeenCalledTimes(1);
            expect(executeSpy.mock.calls[0][0]).toMatch(/^INSERT INTO hooked_items/);
            expect(result).toBe(item);
        });

        it('awaits an async beforeSave to completion before executing', async () => {
            const item = makeItem();
            item.beforeSave = async () => {
                calls.push('beforeSave:start');
                await Promise.resolve();
                calls.push('beforeSave:end');
            };
            item.afterSave = async () => {
                calls.push('afterSave');
            };

            await repo.save(item);

            expect(calls).toEqual(['beforeSave:start', 'beforeSave:end', 'query', 'afterSave']);
        });

        it('a throwing beforeSave aborts the save before any query runs', async () => {
            const item = makeItem();
            item.beforeSave = () => {
                throw new Error('beforeSave rejected it');
            };
            item.afterSave = vi.fn();

            await expect(repo.save(item)).rejects.toThrow('beforeSave rejected it');
            expect(executeSpy).not.toHaveBeenCalled();
            expect(item.afterSave).not.toHaveBeenCalled();
        });

        it('a throwing afterSave propagates, but the INSERT already ran', async () => {
            const item = makeItem();
            item.afterSave = async () => {
                throw new Error('afterSave failed');
            };

            await expect(repo.save(item)).rejects.toThrow('afterSave failed');
            expect(executeSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('update()', () => {
        it('runs static beforeUpdate and afterUpdate around the UPDATE, passing conditions and values', async () => {
            const beforeUpdate = vi.fn((conditions, values) => {
                calls.push('beforeUpdate');
                expect(conditions).toEqual({ id: 'abc-123' });
                expect(values).toEqual({ name: 'Renamed' });
            });
            const afterUpdate = vi.fn(async (conditions, values) => {
                calls.push('afterUpdate');
                expect(conditions).toEqual({ id: 'abc-123' });
                expect(values).toEqual({ name: 'Renamed' });
            });
            HookedItem.beforeUpdate = beforeUpdate;
            HookedItem.afterUpdate = afterUpdate;

            await repo.update({ id: 'abc-123' }, { name: 'Renamed' });

            expect(calls).toEqual(['beforeUpdate', 'query', 'afterUpdate']);
            expect(beforeUpdate).toHaveBeenCalledTimes(1);
            expect(afterUpdate).toHaveBeenCalledTimes(1);
            expect(executeSpy.mock.calls[0][0]).toMatch(/^UPDATE hooked_items SET/);
        });

        it('a throwing beforeUpdate aborts the update before any query runs', async () => {
            HookedItem.beforeUpdate = async () => {
                throw new Error('beforeUpdate rejected it');
            };
            HookedItem.afterUpdate = vi.fn();

            await expect(repo.update({ id: 'abc-123' }, { name: 'Renamed' })).rejects.toThrow(
                'beforeUpdate rejected it'
            );
            expect(executeSpy).not.toHaveBeenCalled();
            expect(HookedItem.afterUpdate).not.toHaveBeenCalled();
        });

        it('a throwing afterUpdate propagates, but the UPDATE already ran', async () => {
            HookedItem.afterUpdate = () => {
                throw new Error('afterUpdate failed');
            };

            await expect(repo.update({ id: 'abc-123' }, { name: 'Renamed' })).rejects.toThrow('afterUpdate failed');
            expect(executeSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('delete()', () => {
        it('runs static beforeDelete and afterDelete around the DELETE, passing conditions', async () => {
            const beforeDelete = vi.fn((conditions) => {
                calls.push('beforeDelete');
                expect(conditions).toEqual({ id: 'abc-123' });
            });
            const afterDelete = vi.fn(async (conditions) => {
                calls.push('afterDelete');
                expect(conditions).toEqual({ id: 'abc-123' });
            });
            HookedItem.beforeDelete = beforeDelete;
            HookedItem.afterDelete = afterDelete;

            await repo.delete({ id: 'abc-123' });

            expect(calls).toEqual(['beforeDelete', 'query', 'afterDelete']);
            expect(executeSpy.mock.calls[0][0]).toMatch(/^DELETE FROM hooked_items WHERE/);
        });

        it('a throwing beforeDelete aborts the delete before any query runs', async () => {
            HookedItem.beforeDelete = () => {
                throw new Error('beforeDelete rejected it');
            };
            HookedItem.afterDelete = vi.fn();

            await expect(repo.delete({ id: 'abc-123' })).rejects.toThrow('beforeDelete rejected it');
            expect(executeSpy).not.toHaveBeenCalled();
            expect(HookedItem.afterDelete).not.toHaveBeenCalled();
        });

        it('a throwing afterDelete propagates, but the DELETE already ran', async () => {
            HookedItem.afterDelete = () => {
                throw new Error('afterDelete failed');
            };

            await expect(repo.delete({ id: 'abc-123' })).rejects.toThrow('afterDelete failed');
            expect(executeSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('entities without hooks', () => {
        it('save, update and delete work exactly as before', async () => {
            const plainRepo = ds.getRepository<PlainItem>(PlainItem);
            const item = new PlainItem();
            item.id = 'abc-123';
            item.name = 'Widget';

            await plainRepo.save(item);
            await plainRepo.update({ id: 'abc-123' }, { name: 'Renamed' });
            await plainRepo.delete({ id: 'abc-123' });

            expect(executeSpy).toHaveBeenCalledTimes(3);
            expect(calls).toEqual(['query', 'query', 'query']);
        });
    });

    describe('statement builders', () => {
        it('never invoke any hook', async () => {
            const item = makeItem();
            item.beforeSave = vi.fn();
            item.afterSave = vi.fn();
            HookedItem.beforeUpdate = vi.fn();
            HookedItem.afterUpdate = vi.fn();
            HookedItem.beforeDelete = vi.fn();
            HookedItem.afterDelete = vi.fn();

            const insert = repo.saveStatement(item);
            const update = repo.updateStatement({ id: 'abc-123' }, { name: 'Renamed' });
            const del = repo.deleteStatement({ id: 'abc-123' });

            expect(insert.query).toMatch(/^INSERT INTO hooked_items/);
            expect(update.query).toMatch(/^UPDATE hooked_items SET/);
            expect(del.query).toMatch(/^DELETE FROM hooked_items WHERE/);
            expect(item.beforeSave).not.toHaveBeenCalled();
            expect(item.afterSave).not.toHaveBeenCalled();
            expect(HookedItem.beforeUpdate).not.toHaveBeenCalled();
            expect(HookedItem.afterUpdate).not.toHaveBeenCalled();
            expect(HookedItem.beforeDelete).not.toHaveBeenCalled();
            expect(HookedItem.afterDelete).not.toHaveBeenCalled();
        });
    });
});
