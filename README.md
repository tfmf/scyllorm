
# Scyllorm 🦑
[![NPM](https://img.shields.io/npm/v/scyllorm)](https://www.npmjs.com/package/scyllorm)
[![npm downloads](https://img.shields.io/npm/dt/scyllorm.svg)](https://www.npmjs.com/package/scyllorm)


Welcome to **Scyllorm**—an experimental TypeScript ORM for ScyllaDB that’s so fresh, it’s practically still in beta diapers. Inspired by [TypeORM](https://github.com/typeorm/typeorm), we’ve set out to simplify database interactions in Node.js. By “simplify,” we mean it’s highly opinionated, so prepare to adopt our opinions, or go find another ORM. Features? Yeah, we’ve got some—just not all of them (yet). A few are stuck in the backlog, and others are on Scylla’s “no-can-do” list. 

And by the way, we use the Node.js [Cassandra driver](https://github.com/datastax/nodejs-driver/), so theoretically, you could use this with Cassandra too... but we haven’t tested it. So if you’re feeling adventurous, go ahead and be our guinea pig.

Oh, and we’re currently rolling with the [Data Mapper Pattern](https://en.wikipedia.org/wiki/Data_mapper_pattern) because it’s what all the cool ORMs are doing. Maybe someday we’ll add the [Active Record Pattern](https://en.wikipedia.org/wiki/Active_record_pattern), but we’re still debating whether we like our records active or not.

## Prerequisites 🎒
- <img src="https://github.com/user-attachments/assets/9804b3c6-4be3-4741-a1c9-ff4460eef94e" alt="node" width="20" height="20"> **Node.js:** If you don't have this, you might be in the wrong place.
- <img src="https://github.com/user-attachments/assets/32da44a9-cc43-4987-af94-696488792995" alt="docker" width="20" height="20"> **Docker:** The easiest way to spin up ScyllaDB locally without accidentally summoning Cthulhu.

## Installation 🚀
To install Scyllorm, just hit it with the good ol’ NPM:

```bash
npm install scyllorm
```
(https://www.npmjs.com/package/scyllorm)

## Step-by-Step Guide 🛠
### 1. Summon ScyllaDB via Docker 🐳

**Docker:**

```bash
docker run -d \
  -p 9042:9042 \
  --cpus 2 \
  --memory 2g \
  scylladb/scylla:latest \
  --smp 2 \
  --memory=2G \
  --overprovisioned 1 \
  --authenticator PasswordAuthenticator \
  --authorizer CassandraAuthorizer \
  --max-clustering-key-restrictions-per-query 1500
```

**docker-compose:**

```bash
  core_scylladb:
    container_name: scylladb_server
    image: scylladb/scylla:latest
    ports:
      - "9042:9042" # CQL
    command: --smp 2 --memory=2G --overprovisioned 1 --authenticator PasswordAuthenticator --authorizer CassandraAuthorizer --max-clustering-key-restrictions-per-query 1500
    volumes:
      - ./scylladb_data:/var/lib/scylla
```

### 2. Test Your Connection 🎯
- For a friendly UI, try [DbVisualizer Free](https://www.dbvis.com/).
- Or, if you're feeling hardcore, dive into the terminal:

```bash
docker exec -it scylladb_server cqlsh -u cassandra -p cassandra
```

### 3. Create a Test Table 🛠️
Because what’s a database without a table?

```cql
CREATE KEYSPACE test_keyspace WITH REPLICATION = {'class': 'SimpleStrategy', 'replication_factor': 1} AND durable_writes = true;

USE test_keyspace;

CREATE TABLE employees (
  id int,
  first_name text,
  last_name text,
  age int,
  city text,
  created_at timestamp,
  updated_at timestamp,
  deleted_at timestamp,
  PRIMARY KEY (id, first_name)
);

CREATE INDEX employees_first_first_name_idx ON employees (first_name);
CREATE INDEX employees_first_last_name_idx ON employees (last_name);
```

### 4. Create Your Model 🎨
Now, let’s make a model:

```typescript
import { BaseModel, Column, Index, PrimaryKeyColumn, Table } from 'scyllorm';

@Entity('employees')
@Index('employees_first_first_name_idx', 'first_name')
@Index('employees_first_last_name_idx', 'last_name')
export class Employee extends BaseModel {
    @PrimaryKeyColumn('INT', { partitionKey: true })
    id: number;

    @PrimaryKeyColumn('TEXT', { clusteringKey: true })
    first_name: string;

    @Column('TEXT')
    last_name: string;

    @Column('INT', { default: 0 })
    age: number;

    @Column('TEXT', { default: 0 })
    city: string;

    @Column('TIMESTAMP', { default: () => new Date() })
    created_at: Date;

    @Column('TIMESTAMP', { default: () => new Date() })
    updated_at: Date;

    @Column('TIMESTAMP')
    deleted_at: Date | null;
}
```

### 5. Setup the DataSource 🛢
This is where the magic happens:

```typescript
import { DataSource } from 'scyllorm';

const dataSource = new DataSource({
    contactPoints: ['localhost'], // Change this if your setup is fancier
    localDataCenter: 'datacenter1',
    keyspace: 'test_keyspace',
    credentials: {
        username: 'cassandra',
        password: 'cassandra',
    },
    protocolOptions: { port: 9042 },
});
```

### 6. Use the Repository 🛠
Now, let’s put this thing to work:

```typescript
 async function run() {
    try {
        await dataSource.initialize();

        const repository = dataSource.getRepository(Employee);

        const employee = new Employee();
        employee.id = 1;
        employee.first_name = 'John';
        employee.last_name = 'Doe';
        employee.age = 30;
        employee.city = 'New York';

        const employee2 = new Employee();
        employee2.id = 2;
        employee2.first_name = 'Jane';
        employee2.last_name = 'Doe';
        employee2.age = 25;
        employee2.city = 'Los Angeles';

        await repository.save(employee);
        console.log('Employee 1 saved successfully!');

        await repository.save(employee2);
        console.log('Employee 2 saved successfully!');

        const employeeId = 1;

        const findOneById = await repository.findOneBy({ id: employeeId });
        console.log('Found by ID:', findOneById);

        const findById = await repository.findBy({ id: employeeId });
        console.log('Found by findBy:', findById);

        const findEmployee = await repository.find({ where: { id: employeeId } });
        console.log('Found by find:', findEmployee);

        const allEmployees = await repository.find();
        console.log('All Employees:', allEmployees);

        // https://www.scylladb.com/2018/08/16/upcoming-enhancements-filtering-implementation/
        const allowFiltering = true;
        const findEmployeeWithAge30And25 = await repository.find({ where: { age: In([25, 30]) } }, allowFiltering);
        console.log('Found Employees with age 30 and 25:', findEmployeeWithAge30And25);

        const findEmployeeWithAgeAbove25 = await repository.find({ where: { age: GreaterThan(25) } }, allowFiltering);
        console.log('Found Employees with age above 25:', findEmployeeWithAgeAbove25);

        const findEmployeeWithAgeAboveOrEqualTo25 = await repository.find(
            { where: { age: GreaterThanOrEqual(25) } },
            allowFiltering
        );
        console.log('Found Employees with age equal to 25 or above:', findEmployeeWithAgeAboveOrEqualTo25);

        const findEmployeeWithAgeLessThan30 = await repository.find({ where: { age: LessThan(30) } }, allowFiltering);
        console.log('Found Employees with age less than 30:', findEmployeeWithAgeLessThan30);

        const findEmployeeWithAgeLessThanOrEqual30 = await repository.find(
            { where: { age: LessThanOrEqual(30) } },
            allowFiltering
        );
        console.log(findEmployeeWithAgeLessThanOrEqual30);

        const findEmployeeWithRawQuery = await repository.runRawQuery(
            `SELECT * FROM employees WHERE id = :employee_id`,
            { employee_id: 1 }
        );
        console.log(findEmployeeWithRawQuery);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await dataSource.shutdown(); // Don’t forget to shut it down, or it might haunt you later.
    }
}
run();
```

And that’s it! If you followed along and didn’t encounter any errors, you’re officially ready to start messing with ScyllaDB using TypeScript in Node.js. Congratulations! 🎉🌊🦑💻

## Contributing
Found a bug? Want to add a feature?  We welcome all contributions! Just open a PR and we'll review it as fas as humanly possible (or not)

## Examples
You can find examples in Typescript and Javascript inside the folder [src/examples](https://github.com/tfmf/scyllorm/tree/main/src/example)

## License
GNU General Public License v3.0


