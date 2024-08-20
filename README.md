# Scyllorm
Scyllorm is an experimental TypeScript ORM for ScyllaDB, offering early-stage tools for seamless database interactions in Node.js. It's higlhy opinated and based on [TypeORM](https://github.com/typeorm/typeorm) and it's itendend to be easy to use and to setup. There a bunch of features missing some of them are in the backlog and some are not supported by Scylla. We use the Node.js [cassandra driver](https://github.com/datastax/nodejs-driver/) so in theory you can also use this for Cassandra (never tested). We also only implemented [Data Mapper Pattern](https://en.wikipedia.org/wiki/Data_mapper_pattern) but possible in future we will implement the [Active Record Pattern](https://en.wikipedia.org/wiki/Active_record_pattern).

## Prerequisites
- <img src="https://github.com/user-attachments/assets/9804b3c6-4be3-4741-a1c9-ff4460eef94e" alt="node" width="20" height="20"> Node.js: Needs to be installed in order to use the package
- <img src="https://github.com/user-attachments/assets/32da44a9-cc43-4987-af94-696488792995" alt="node" width="20" height="20"> Docker: Best way to run ScyllaDB locally

## Installation
```bash
npm install scyllorm
```

## Step-by-Step Guide
1. Run ScyllaDB in Docker or using Docker Compose 🐳

  Docker:

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

docker-compose:

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

3. Test your connection

- You can use DbVisualizer Free (https://www.dbvis.com/)
- Or connect directly from your terminal:
```bash
docker exec -it scylladb_server cqlsh -u cassandra -p cassandra
```

2. Create a test table

```cql
CREATE KEYSPACE test_keyspace WITH REPLICATION = {'class': 'SimpleStrategy', 'replication_factor': 1} AND durable_writes = true;

USE test_keyspace;

CREATE TABLE employees (
  id int,
  first_name text,
  last_name text,
  age int,
  city text
  created_at timestamp,
  updated_at timestamp,
  deleted_at timestamp,
  PRIMARY KEY (id, name)
);

CREATE INDEX employees_first_first_name_idx ON employees (first_name);
CREATE INDEX employees_first_last_name_idx ON employees (last_name);


```

3. Create your model
```typescript
import { BaseModel, Column, Index, PrimaryKeyColumn, Table } from 'scyllorm';

@Table({ name: 'employees' })
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

4. Setup the DataSource 🛢
```typescript
import { DataSource } from 'scyllorm';

const dataSource = new DataSource({
    contactPoints: ['localhost'], // Example contact point, adjust as needed
    localDataCenter: 'datacenter1',
    keyspace: 'test_space',
    credentials: {
        username: 'cassandra',
        password: 'cassandra',
    },
    protocolOptions: { port: 9042 },
});
```

5. Use the repository
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
        console.log(findOneById);

        const findById = await repository.findBy({ id: employeeId });
        console.log(findById);

        const findEmployee = await repository.find({ where: { id: employeeId } });
        console.log(findEmployee);

        const allEmployees = await repository.find();
        console.log(allEmployees);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await dataSource.shutdown(); // Properly shut down the DataSource
    }
}
run();
```
