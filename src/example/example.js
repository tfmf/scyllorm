const { Entity, PrimaryKeyColumn, Column, Index, BaseModel, DataSource } = require('scyllorm');

class Employee extends BaseModel {
    constructor() {
        super();
        this.id = null;
        this.first_name = null;
        this.last_name = null;
        this.age = 0;
        this.city = null;
        this.created_at = new Date();
        this.updated_at = new Date();
        this.deleted_at = null;
    }
}

// Manually applying the decorators since by default, javascript does not support decorators,
// which are still a Stage 2 proposal in ECMAScript
Entity('employees')(Employee);
Index('employees_first_first_name_idx', 'first_name')(Employee);
Index('employees_first_last_name_idx', 'last_name')(Employee);

PrimaryKeyColumn('INT', { partitionKey: true })(Employee.prototype, 'id');
PrimaryKeyColumn('TEXT', { clusteringKey: true })(Employee.prototype, 'first_name');
Column('TEXT')(Employee.prototype, 'last_name');
Column('INT', { default: 0 })(Employee.prototype, 'age');
Column('TEXT', { default: 0 })(Employee.prototype, 'city');
Column('TIMESTAMP', { default: () => new Date() })(Employee.prototype, 'created_at');
Column('TIMESTAMP', { default: () => new Date() })(Employee.prototype, 'updated_at');
Column('TIMESTAMP')(Employee.prototype, 'deleted_at');

// Create a single instance of DataSource
const dataSource = new DataSource({
    contactPoints: ['localhost'], // Example contact point, adjust as needed
    localDataCenter: 'datacenter1',
    keyspace: 'test_keyspace',
    credentials: {
        username: 'cassandra',
        password: 'cassandra',
    },
    protocolOptions: { port: 9042 },
});

// Ensure that the DataSource is initialized before any repository operation
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