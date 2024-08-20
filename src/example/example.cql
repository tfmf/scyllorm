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
  PRIMARY KEY(id, first_name)
);

CREATE INDEX employees_first_first_name_idx ON employees (first_name);
CREATE INDEX employees_first_last_name_idx ON employees (last_name);