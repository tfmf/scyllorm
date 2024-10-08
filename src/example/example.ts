import {
    Entity,
    PrimaryKeyColumn,
    Column,
    Index,
    BaseModel,
    DataSource,
    In,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
} from 'scyllorm';

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
        await dataSource.shutdown(); // Properly shut down the DataSource
    }
}

run();
