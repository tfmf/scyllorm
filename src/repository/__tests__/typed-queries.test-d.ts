import { types } from 'cassandra-driver';
import { describe, expectTypeOf, test } from 'vitest';
import {
    BaseModel,
    Between,
    Column,
    ColumnKeys,
    Contains,
    DataSource,
    Entity,
    FindOptions,
    FindOptionsWhere,
    GreaterThan,
    GreaterThanOrEqual,
    In,
    LessThan,
    NestedConditions,
    PrimaryKeyColumn,
    Repository,
    ScanOptions,
} from '../../index';
import * as lib from '../../index';

// Compiled under tsconfig.typecheck.json (strict), never run: each `@ts-expect-error` is a
// compile error the 1.0 types must produce, and every other line must compile.

interface Address {
    street: string;
    city: string | null;
    lines: string[];
}

type Status = 'active' | 'banned';

class User extends BaseModel {
    id!: string;
    age?: number;
    home!: Address;
    tags!: string[];
    // A transformer column: the property holds the app type, conditions are written in it too
    status!: Status;

    fullName(): string {
        return this.id;
    }

    afterLoad(): void {}
}

declare const users: Repository<User>;
declare const address: Address;

describe('ColumnKeys', () => {
    test('is every non-function property, without methods or hooks', () => {
        expectTypeOf<ColumnKeys<User>>().toEqualTypeOf<'id' | 'age' | 'home' | 'tags' | 'status'>();
    });

    test('is string for an untyped entity', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expectTypeOf<ColumnKeys<any>>().toEqualTypeOf<string>();
    });
});

describe('find, findPaged and stream options', () => {
    test('accept column keys, own-typed values and operators', () => {
        const options: FindOptions<User> = {
            where: { id: 'a', age: GreaterThan(30), tags: Contains('x'), status: In(['active', 'banned']) },
            select: ['id', 'age'],
            orderBy: { age: 'DESC' },
            limit: 10,
        };

        users.find(options);
        users.findPaged(options);
        users.stream(options);
        users.find();
        users.find({ where: { home: address } });
    });

    test('reject an unknown key in where, select and orderBy', () => {
        // @ts-expect-error `idd` is not a column of User
        users.find({ where: { idd: 'a' } });
        // @ts-expect-error `nope` is not a column of User
        users.findPaged({ select: ['id', 'nope'] });
        // @ts-expect-error `name` is not a column of User
        users.stream({ orderBy: { name: 'ASC' } });
    });

    test('reject methods and hooks as where and orderBy keys', () => {
        // @ts-expect-error a method is not a column
        users.find({ where: { fullName: 'x' } });
        // @ts-expect-error a hook is not a column
        users.find({ where: { afterLoad: 'x' } });
        // @ts-expect-error a method is not a column
        users.find({ orderBy: { fullName: 'ASC' } });
    });

    test('select takes any key of the entity, so Repository stays castable (methods throw at runtime)', () => {
        expectTypeOf<NonNullable<FindOptions<User>['select']>>().toEqualTypeOf<(keyof User & string)[]>();
    });

    test('accept any driver scalar as an equality value, since the CQL type is checked at runtime', () => {
        users.find({ where: { id: types.Uuid.random(), age: BigInt(3) } });
        users.find({ where: { age: types.Long.fromNumber(3), status: 'active' } });
    });

    test('reject a value that is neither the property type nor a scalar', () => {
        // @ts-expect-error null is not a condition (it throws at runtime too)
        users.find({ where: { age: null } });
        // @ts-expect-error an object is only a value for a property of that type
        users.find({ where: { age: { foo: 3 } } });
    });

    test('reject an invalid direction', () => {
        // @ts-expect-error only ASC or DESC
        users.find({ orderBy: { age: 'UP' } });
    });
});

describe('condition methods', () => {
    test('accept typed conditions', () => {
        const where: FindOptionsWhere<User> = { id: 'a', age: LessThan(5) };

        users.findBy(where);
        users.count(where);
        users.count();
        users.countBy(where);
        users.existsBy(where);
        users.sum('age', where);
        users.avg('age', where);
        expectTypeOf(users.min('age', where)).resolves.toEqualTypeOf<number | undefined | null>();
        expectTypeOf(users.max('status', where)).resolves.toEqualTypeOf<Status | null>();
    });

    test('reject an unknown key', () => {
        // @ts-expect-error unknown column
        users.findBy({ idd: 'a' });
        // @ts-expect-error unknown column
        users.count({ idd: 'a' });
        // @ts-expect-error unknown column
        users.countBy({ idd: 'a' });
        // @ts-expect-error unknown column
        users.existsBy({ idd: 'a' });
        // @ts-expect-error unknown column
        users.sum('age', { idd: 'a' });
        // @ts-expect-error unknown column
        users.avg('age', { idd: 'a' });
        // @ts-expect-error unknown column
        users.min('age', { idd: 'a' });
        // @ts-expect-error unknown column
        users.max('age', { idd: 'a' });
    });

    test('leave the Partial<T> equality methods as they were', () => {
        users.findOneBy({ id: 'a' });
        users.delete({ id: 'a' });
        users.update({ id: 'a' }, { age: 3 });
    });
});

describe('UDT values', () => {
    test('an interface-typed value is an equality condition, nullable and list fields included', () => {
        users.findBy({ home: address });
        users.findBy({ home: { street: 's', city: null, lines: ['a'] } });
        users.findBy({ home: In([address]) });
    });

    test('a value missing a field is refused', () => {
        // @ts-expect-error `lines` is missing
        users.findBy({ home: { street: 's', city: null } });
    });

    test('a scalar against a UDT column compiles; the CQL type check rejects it at runtime', () => {
        users.findBy({ home: 'x' });
    });
});

describe('scan', () => {
    test('types select by the entity', () => {
        users.scan({ select: ['id', 'home'], concurrency: 4 });
        // @ts-expect-error unknown column
        users.scan({ select: ['nope'] });
    });

    test('a bare ScanOptions stays untyped', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expectTypeOf<ScanOptions['select']>().toEqualTypeOf<any[] | undefined>();
    });
});

describe('dynamic conditions', () => {
    test('a NestedConditions or Record variable still assigns for a concrete entity', () => {
        const nested: NestedConditions = { id: 'a' };
        const record: Record<string, unknown> = { id: 'a' };
        const order: { [column: string]: 'ASC' | 'DESC' } = { age: 'DESC' };

        users.findBy(nested);
        users.findBy(record);
        users.find({ where: nested, orderBy: order });
    });

    test('a bare FindOptions stays untyped and still assigns', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expectTypeOf<FindOptions['select']>().toEqualTypeOf<any[] | undefined>();

        const loose: FindOptions = { where: { anything: 1 }, select: ['id'] };

        users.find(loose);
    });

    test('a select typed string[] no longer assigns', () => {
        const columns: string[] = ['id'];

        // @ts-expect-error string[] is not ColumnKeys<User>[]
        users.find({ select: columns });
        // @ts-expect-error string[] is not ColumnKeys<User>[]
        users.scan({ select: columns });

        users.find({ select: columns as (keyof User)[] });
    });
});

describe('code generic over the entity', () => {
    test('needs the documented cast', () => {
        function byId<T extends BaseModel & { id: string }>(repository: Repository<T>, id: string) {
            // @ts-expect-error TypeScript cannot resolve the keys of an unresolved T
            repository.findBy({ id });

            return repository.findBy({ id } as unknown as FindOptionsWhere<T>);
        }

        expectTypeOf(byId(users, 'a')).resolves.toEqualTypeOf<User[]>();
    });

    test('can still cast a Repository of the base type to the entity type', () => {
        function setup<E extends BaseModel>(ds: DataSource, entityClass: typeof BaseModel) {
            const base: Repository<BaseModel> = ds.getRepository(entityClass);

            return base as Repository<E>;
        }

        expectTypeOf(setup<User>).returns.toEqualTypeOf<Repository<User>>();
    });
});

// The README's model (section 4), with `!` for strict property initialization
@Entity('employees')
class Employee extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id!: number;

    @PrimaryKeyColumn('TEXT', { clusteringKey: true })
    first_name!: string;

    @Column('TEXT')
    last_name!: string;

    @Column('INT', { default: 0 })
    age!: number;

    @Column('TEXT')
    city!: string;

    @Column('TIMESTAMP')
    deleted_at!: Date | null;
}

declare const repository: Repository<Employee>;

describe('README examples', () => {
    test('section 6 still compiles', () => {
        repository.findBy({ id: 1 });
        repository.find({ where: { id: 1 } });
        repository.find({ where: { id: 1 }, orderBy: { first_name: 'ASC' }, limit: 10 });
        repository.find({ where: { age: In([25, 30]) } }, true);
        repository.find({ where: { age: GreaterThan(25) } }, true);
        repository.find({ where: { age: Between(25, 30) } }, true);
        repository.find({ select: ['first_name', 'last_name'], where: { id: 1 } });
        repository.countBy({ age: GreaterThanOrEqual(18) }, true);
        repository.existsBy({ first_name: 'John' }, true);
    });

    test('the typed-queries section', () => {
        // @ts-expect-error a typo
        repository.find({ where: { frist_name: 'John' } });
        // @ts-expect-error a typo
        repository.find({ select: ['lastname'] });

        const where: NestedConditions = { [String('city')]: 'Berlin' };
        repository.findBy(where);

        const columns = ['first_name', 'city'] as (keyof Employee)[];
        repository.find({ select: columns });

        const options: FindOptions<Employee> = { where: { city: 'Berlin' }, orderBy: { age: 'DESC' } };
        repository.find(options);
    });
});

describe('removed APIs', () => {
    test('are gone from the package', () => {
        expectTypeOf(lib).not.toHaveProperty('MoreThan');
        expectTypeOf(lib).not.toHaveProperty('MoreThanOrEqual');
        expectTypeOf(lib).not.toHaveProperty('Table');
        expectTypeOf(lib).toHaveProperty('GreaterThan');
    });
});

// Entities for the review-round guards
class Model extends BaseModel {
    id!: string;
    deleted_at!: Date | null;
    // The point of this property: a column filter must drop it
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    callback!: Function;
    get label(): string {
        return this.id;
    }
}

class Parent extends BaseModel {
    id!: string;
}

class Child extends Parent {
    extra!: number;
}

declare const models: Repository<Model>;
declare const children: Repository<Child>;

// A generic subclass overriding a condition method: the 1.0 parameter types compile, a 0.9
// `NestedConditions` parameter does not (TS2416), as the migration notes say
class SoftDelete<T extends BaseModel> extends Repository<T> {
    override async existsBy(conditions: FindOptionsWhere<T>, allowFiltering = false) {
        return super.existsBy(conditions, allowFiltering);
    }

    override async find(options?: FindOptions<T>, allowFiltering = false) {
        return super.find(options, allowFiltering);
    }
}

class LegacySoftDelete<T extends BaseModel> extends Repository<T> {
    // @ts-expect-error TS2416: a generic override must declare FindOptionsWhere<T>
    override async existsBy(conditions: NestedConditions, allowFiltering = false) {
        return super.existsBy(conditions as unknown as FindOptionsWhere<T>, allowFiltering);
    }
}

// A subclass of a concrete repository keeps its 0.9 signatures
class LegacyUsers extends Repository<User> {
    override async findBy(conditions: NestedConditions, allowFiltering = false) {
        return super.findBy(conditions, allowFiltering);
    }
}

describe('review fixes', () => {
    test('null is refused for a nullable column, since it throws at runtime', () => {
        // @ts-expect-error null is not a condition value
        models.findBy({ deleted_at: null });
        models.findBy({ deleted_at: new Date() });
    });

    test('a property typed Function is not a column', () => {
        expectTypeOf<ColumnKeys<Model>>().toEqualTypeOf<'id' | 'deleted_at' | 'label'>();
    });

    test('a non-object or a disjoint object is refused (weak type detection)', () => {
        // @ts-expect-error an operator is not a where object
        users.findBy(In(['a']));
        // @ts-expect-error an operator is not a where object
        users.find({ where: GreaterThan(3) });
        const typo = { idd: 'a' };
        // @ts-expect-error no key in common with the entity's columns
        users.findBy(typo);
    });

    test('generic code casts whole options to FindOptions<T>', () => {
        function latest<T extends BaseModel & { id: string }>(repository: Repository<T>, options: FindOptions) {
            return repository.find({
                ...options,
                where: { id: 'a' },
                orderBy: { id: 'DESC' },
                select: ['id'],
            } as unknown as FindOptions<T>);
        }

        expectTypeOf(latest(users, {})).resolves.toEqualTypeOf<User[]>();
    });

    test('a repository upcasts to its parent entity', () => {
        const parents: Repository<Parent> = children;
        const bases: Repository<BaseModel> = children;

        expectTypeOf(parents).toEqualTypeOf<Repository<Parent>>();
        expectTypeOf(bases).toEqualTypeOf<Repository<BaseModel>>();
    });

    test('a bare FindOptions or ScanOptions spreads into a typed call', () => {
        const options: FindOptions = { select: ['id'], where: { id: 'a' }, orderBy: { age: 'ASC' } };
        const scanOptions: ScanOptions = { select: ['id'] };
        const partial: Partial<FindOptions> = {};
        const omitted: Omit<FindOptions, 'limit'> = {};

        users.find({ ...options, limit: 100 });
        users.find({ ...partial });
        users.find({ ...omitted, where: { ...options.where, age: 3 } });
        users.scan({ ...scanOptions, concurrency: 2 });
    });

    test('subclass overrides', () => {
        expectTypeOf<SoftDelete<User>['existsBy']>().parameter(0).toEqualTypeOf<FindOptionsWhere<User>>();
        expectTypeOf<LegacySoftDelete<User>>().toHaveProperty('existsBy');
        expectTypeOf<LegacyUsers['findBy']>().parameter(0).toEqualTypeOf<NestedConditions>();
    });

    test('a bare orderBy reads back without undefined', () => {
        expectTypeOf<NonNullable<FindOptions['orderBy']>>().toEqualTypeOf<{ [column: string]: 'ASC' | 'DESC' }>();
    });
});
