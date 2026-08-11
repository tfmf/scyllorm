import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseModel } from '../../model/BaseModel';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../../repository/Repository';
import { Entity } from '../Entity';
import { Column } from '../Column';
import { Index } from '../IndexDecorator';
import { PrimaryKeyColumn } from '../PrimaryKey';

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

// A shared, undecorated-as-an-entity base carrying common columns
@Index('idx_timestamped_created_at', 'created_at')
class Timestamped extends BaseModel {
    @Column('TIMESTAMP', { default: () => new Date() })
    created_at: Date;
}

// Declares columns of its own — the case that silently dropped `created_at`
@Entity('users')
@Index('idx_users_name', 'name')
class User extends Timestamped {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;
}

// Declares nothing of its own
@Entity('bare')
class Bare extends Timestamped {}

// Three levels deep, with an empty class in the middle
class Middle extends Timestamped {}

@Entity('deep')
class Deep extends Middle {
    @Column('INT')
    depth: number;
}

// Redeclares an inherited column with a different type
@Entity('overrides')
class Override extends Timestamped {
    @Column('TEXT')
    created_at: never;
}

const names = (list?: Array<{ name: string }>) => (list ?? []).map((item) => item.name);

describe('Decorator metadata inheritance', () => {
    describe('columns', () => {
        it('should keep inherited columns on a subclass that declares its own', () => {
            expect(names(User.columns)).toEqual(['created_at', 'id', 'name']);
        });

        it('should inherit columns on a subclass that declares none', () => {
            expect(names(Bare.columns)).toEqual(['created_at']);
        });

        it('should inherit through an intermediate class that declares nothing', () => {
            expect(names(Deep.columns)).toEqual(['created_at', 'depth']);
        });

        it('should not mutate the parent when a subclass is decorated', () => {
            expect(names(Timestamped.columns)).toEqual(['created_at']);
        });

        it('should not share the columns array with the parent by reference', () => {
            expect(User.columns).not.toBe(Timestamped.columns);
            expect(Deep.columns).not.toBe(Timestamped.columns);
        });

        it('should replace, not duplicate, a redeclared inherited column', () => {
            expect(names(Override.columns)).toEqual(['created_at']);
            expect(Override.columns?.find((col) => col.name === 'created_at')?.type).toBe('TEXT');
        });
    });

    describe('primaryKeys', () => {
        it('should not leak a subclass primary key onto the parent', () => {
            expect(names(User.primaryKeys)).toEqual(['id']);
            expect(Timestamped.primaryKeys).toBeUndefined();
        });
    });

    describe('indexes', () => {
        it('should keep inherited indexes on a subclass that declares its own', () => {
            expect(names(User.indexes)).toEqual(['idx_timestamped_created_at', 'idx_users_name']);
        });

        it('should inherit indexes on a subclass that declares none', () => {
            expect(names(Bare.indexes)).toEqual(['idx_timestamped_created_at']);
        });

        it('should not mutate the parent indexes', () => {
            expect(names(Timestamped.indexes)).toEqual(['idx_timestamped_created_at']);
        });
    });

    describe('effect on the entity and the generated CQL', () => {
        let ds: DataSource;
        let executeSpy: ReturnType<typeof vi.fn>;

        beforeEach(async () => {
            vi.clearAllMocks();
            ds = new DataSource({
                contactPoints: ['localhost'],
                localDataCenter: 'datacenter1',
                keyspace: 'test',
            });
            await ds.initialize();
            executeSpy = vi.fn().mockResolvedValue([]);
            /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
            (ds as any).executeQuery = executeSpy;
        });

        it('should write inherited columns in the INSERT', async () => {
            const repo: Repository<User> = ds.getRepository<User>(User);
            const user = new User();
            user.id = 'abc-123';
            user.name = 'Ada';

            await repo.save(user);

            expect(executeSpy).toHaveBeenCalledTimes(1);
            expect(executeSpy.mock.calls[0][0]).toBe('INSERT INTO users (created_at, id, name) VALUES (?, ?, ?)');
            expect(executeSpy.mock.calls[0][1]).toHaveLength(3);
        });

        it('should read inherited columns back into the entity', async () => {
            const repo: Repository<User> = ds.getRepository<User>(User);
            const created = new Date('2020-01-01T00:00:00.000Z');
            executeSpy.mockResolvedValue([{ id: 'abc-123', name: 'Ada', created_at: created }]);

            const [found] = await repo.find();

            expect(found.created_at).toEqual(created);
            expect(found.name).toBe('Ada');
        });

        it('should apply defaults declared on an inherited column', () => {
            const user = new User();

            expect(user.created_at).toBeInstanceOf(Date);
        });
    });
});
