import { defineConfig } from 'vitest/config';

// The e2e suite runs against the live ScyllaDB container started by scripts/e2e.sh.
// Same transform settings as vitest.config.ts; no coverage — correctness against a
// real server is the point here, the unit suite owns the coverage ratchet.
export default defineConfig({
    oxc: {
        typescript: {
            experimentalDecorators: true,
            removeClassFieldsWithoutInitializer: true,
        },
        assumptions: {
            setPublicClassFields: true,
        },
        decorator: {
            legacy: true,
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['e2e/**/*.e2e.test.ts'],
        // First statements wait on a cold ScyllaDB; hooks create/drop the keyspace
        testTimeout: 60000,
        hookTimeout: 120000,
        // One forked process, one file at a time: the tests share a single container
        // and keyspace. `fileParallelism: false` is Vitest 4's spelling of the old
        // `poolOptions.forks.singleFork` — it pins the run to a single worker.
        pool: 'forks',
        fileParallelism: false,
    },
});
