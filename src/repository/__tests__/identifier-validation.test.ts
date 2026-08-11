import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from '../../data-source/DataSource';
import { Repository } from '../Repository';
import { BaseModel } from '../../model/BaseModel';
import { Entity } from '../../decorators/Entity';
import { Column } from '../../decorators/Column';
import { PrimaryKeyColumn } from '../../decorators/PrimaryKey';
import { In, GreaterThan } from '../query-utils';
import { ScyllormError, UnknownColumnError, InvalidQueryError } from '../../errors';

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

@Entity('items')
class Item extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    name: string;

    @Column('INT')
    quantity: number;
}

class Timestamped extends BaseModel {
    @Column('TIMESTAMP')
    created_at: Date;
}

@Entity('users')
class User extends Timestamped {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    email: string;
}

@Entity('collisions')
class Collision extends BaseModel {
    @PrimaryKeyColumn('UUID')
    userId: string;

    @Column('TEXT')
    userid: string;
}

@Entity('malformed')
class Malformed extends BaseModel {
    @PrimaryKeyColumn('UUID')
    id: string;

    @Column('TEXT')
    '_internal': string;
}

// A key that would end the WHERE clause and start a statement of its own
const INJECTION = 'id = 1 ALLOW FILTERING; DROP TABLE items --';

describe('identifier validation', () => {
    let ds: DataSource;
    let repo: Repository<Item>;
    let executeSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        ds = new DataSource({
            contactPoints: ['localhost'],
            localDataCenter: 'datacenter1',
            keyspace: 'test',
        });
        await ds.initialize();
        repo = ds.getRepository<Item>(Item);
        executeSpy = vi.fn().mockResolvedValue([]);
        (ds as any).executeQuery = executeSpy;
    });

    describe('unknown columns', () => {
        it('should reject an undeclared column in find()', async () => {
            await expect(repo.find({ where: { nope: 'x' } })).rejects.toThrow(UnknownColumnError);
        });

        it('should reject an undeclared column in findBy()', async () => {
            await expect(repo.findBy({ nope: 'x' })).rejects.toThrow(UnknownColumnError);
        });

        it('should reject an undeclared column in findOneBy()', async () => {
            await expect(repo.findOneBy({ nope: 'x' } as any)).rejects.toThrow(UnknownColumnError);
        });

        it('should reject an undeclared column in delete()', async () => {
            await expect(repo.delete({ nope: 'x' } as any)).rejects.toThrow(UnknownColumnError);
        });

        it('should reject an undeclared column in orderBy', async () => {
            await expect(repo.find({ orderBy: { nope: 'ASC' } })).rejects.toThrow(UnknownColumnError);
        });

        it('should reject an undeclared column behind an operator', async () => {
            await expect(repo.findBy({ nope: GreaterThan(3) })).rejects.toThrow(UnknownColumnError);
        });

        it('should reject an undeclared column behind IN', async () => {
            await expect(repo.findBy({ nope: In(['a', 'b']) })).rejects.toThrow(UnknownColumnError);
        });

        it('should be case-sensitive, since a lookup is not a CQL identifier', async () => {
            await expect(repo.findBy({ NAME: 'Widget' })).rejects.toThrow(UnknownColumnError);
        });
    });

    describe('no query reaches the driver', () => {
        it('should not execute anything for an injection payload as a key', async () => {
            await expect(repo.findBy({ [INJECTION]: 1 })).rejects.toThrow(ScyllormError);

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should not execute anything for an undeclared column', async () => {
            await expect(repo.find({ where: { nope: 'x' } })).rejects.toThrow(ScyllormError);

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should reject a payload before the first valid key has been emitted', async () => {
            await expect(repo.findBy({ name: 'Widget', [INJECTION]: 1 })).rejects.toThrow(ScyllormError);

            expect(executeSpy).not.toHaveBeenCalled();
        });
    });

    describe('names that are not legal identifiers', () => {
        it.each([
            ['a CQL function', 'token(id)'],
            ['a quoted identifier', '"CaseSensitiveCol"'],
            ['collection access', "metadata['key']"],
            ['a leading underscore', '_internal'],
            ['a leading digit', '2fa'],
            ['an empty key', ''],
            ['an injection payload', INJECTION],
        ])('should reject %s with InvalidQueryError, not UnknownColumnError', async (_label, key) => {
            await expect(repo.findBy({ [key]: 1 })).rejects.toThrow(InvalidQueryError);
        });

        it('should point at runRawQuery as the escape hatch', async () => {
            const error = await repo.findBy({ 'token(id)': 1 }).catch((caught) => caught);

            expect(error).toBeInstanceOf(InvalidQueryError);
            expect(error.code).toBe('SCYLLORM_INVALID_QUERY');
            expect(error.message).toContain('runRawQuery()');
        });
    });

    describe('prototype keys', () => {
        // Own properties, so `Object.entries` enumerates them — this pins the
        // `Map` + `.has()` lookup and fails if anyone switches to `key in obj`
        const polluted = JSON.parse('{"__proto__":1,"constructor":2,"toString":3}');

        it('should reject every inherited-looking key', async () => {
            for (const key of Object.keys(polluted)) {
                await expect(repo.findBy({ [key]: 1 })).rejects.toThrow(ScyllormError);
            }

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should reject constructor as an unknown column, not resolve it off the prototype', async () => {
            await expect(repo.findBy({ constructor: 1 })).rejects.toThrow(UnknownColumnError);
        });

        // Computed, because `{ __proto__: 1 }` in a literal calls the prototype
        // setter and defines no own property at all
        it('should reject __proto__ as a malformed identifier', async () => {
            await expect(repo.findBy({ ['__proto__']: 1 })).rejects.toThrow(InvalidQueryError);
        });
    });

    describe('sort direction', () => {
        it.each([
            ['lowercase', 'asc'],
            ['a trailing statement', 'ASC; DROP TABLE items'],
            ['undefined', undefined],
            ['an empty string', ''],
        ])('should reject %s', async (_label, direction) => {
            await expect(repo.find({ orderBy: { name: direction } as any })).rejects.toThrow(InvalidQueryError);

            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should name the column and the accepted values', async () => {
            const error = await repo.find({ orderBy: { name: 'asc' } as any }).catch((caught) => caught);

            expect(error.message).toContain('Invalid sort direction "asc"');
            expect(error.message).toContain('column "name"');
            expect(error.message).toContain("'ASC' or 'DESC'");
        });

        it('should still accept ASC and DESC', async () => {
            await repo.find({ orderBy: { name: 'ASC', quantity: 'DESC' } });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM items ORDER BY name ASC, quantity DESC');
        });
    });

    describe('error content', () => {
        it('should carry the rejected column, the entity and the table', async () => {
            const error = await repo.findBy({ nmae: 'Widget' }).catch((caught) => caught);

            expect(error).toBeInstanceOf(UnknownColumnError);
            expect(error.code).toBe('SCYLLORM_UNKNOWN_COLUMN');
            expect(error.column).toBe('nmae');
            expect(error.entity).toBe('Item');
            expect(error.table).toBe('items');
            expect(error.knownColumns).toEqual(['id', 'name', 'quantity']);
        });

        it('should suggest the column that was probably meant', async () => {
            const error = await repo.findBy({ quantitiy: 1 }).catch((caught) => caught);

            expect(error.message).toContain('Did you mean "quantity"?');
        });

        it('should suggest the declared spelling for a case mismatch', async () => {
            const error = await repo.findBy({ NAME: 'Widget' }).catch((caught) => caught);

            expect(error.message).toContain('Did you mean "name"?');
        });

        it('should bound the message for a large key while keeping the whole one on the error', async () => {
            const column = 'a'.repeat(8192);
            const error = await repo.findBy({ [column]: 1 }).catch((caught) => caught);

            expect(error.column).toBe(column);
            expect(error.message.length).toBeLessThan(300);
        });

        it('should not let a control character in the key forge a log line', async () => {
            const error = await repo.findBy({ 'na\nme': 1 }).catch((caught) => caught);

            expect(error).toBeInstanceOf(ScyllormError);
            expect(error.message).not.toContain('\n');
        });
    });

    describe('entity metadata', () => {
        it('should reject two columns CQL cannot tell apart', async () => {
            const collisions = ds.getRepository(Collision);

            await expect(collisions.findBy({ userId: 'x' })).rejects.toThrow(/same column to CQL/);
        });

        it('should keep failing on a bad entity rather than caching the failure away', async () => {
            const collisions = ds.getRepository(Collision);

            await expect(collisions.findBy({ userId: 'x' })).rejects.toThrow(InvalidQueryError);
            await expect(collisions.findBy({ userId: 'x' })).rejects.toThrow(InvalidQueryError);
        });

        it('should reject a declared column that is not a legal identifier', async () => {
            const malformed = ds.getRepository(Malformed);

            await expect(malformed.findBy({ id: 'x' })).rejects.toThrow(InvalidQueryError);
        });

        it('should not throw when the repository is created, only when it is used', () => {
            expect(() => ds.getRepository(Collision)).not.toThrow();
        });

        it('should accept a column inherited from a base entity', async () => {
            const users = ds.getRepository(User);

            await users.findBy({ created_at: '2024-01-01' });

            expect(executeSpy.mock.calls[0][0]).toBe('SELECT * FROM users WHERE created_at = ?');
        });
    });

    describe('getColumnNames()', () => {
        it('should list the accepted names in declaration order', () => {
            expect(repo.getColumnNames()).toEqual(['id', 'name', 'quantity']);
        });

        it('should include inherited columns', () => {
            expect(ds.getRepository(User).getColumnNames()).toEqual(['created_at', 'id', 'email']);
        });

        it('should agree with what the query builders accept', async () => {
            for (const column of repo.getColumnNames()) {
                await expect(repo.findBy({ [column]: 1 })).resolves.toEqual([]);
            }
        });

        it('should not expose the cached map to mutation', () => {
            repo.getColumnNames().push('injected');

            expect(repo.getColumnNames()).toEqual(['id', 'name', 'quantity']);
        });
    });

    describe('the column map is shared per entity class', () => {
        it('should validate identically across separately created repositories', async () => {
            const first = ds.getRepository<Item>(Item);
            const second = ds.getRepository<Item>(Item);

            expect(first).not.toBe(second);
            expect(second.getColumnNames()).toEqual(first.getColumnNames());
            await expect(second.findBy({ nope: 1 })).rejects.toThrow(UnknownColumnError);
        });

        it('should not leak one entity’s columns into another', async () => {
            const users = ds.getRepository(User);

            await expect(users.findBy({ quantity: 1 })).rejects.toThrow(UnknownColumnError);
            await expect(repo.findBy({ email: 'a@b.c' })).rejects.toThrow(UnknownColumnError);
        });
    });
});
