import { defineConfig } from 'vitest/config';

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
        include: ['src/**/__tests__/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov', 'json-summary'],
            reportsDirectory: './coverage',
            // `include` is set explicitly so a source file no test happens to import is reported
            // at 0% instead of vanishing from the denominator entirely. `src/example/` ships neither
            // in dist nor as tested code, so it's excluded alongside the test files themselves —
            // barrels (`index.ts`) are deliberately left in: a barrel that stops re-exporting a
            // public symbol should show up as uncovered, not disappear from the report.
            include: ['src/**/*.ts'],
            exclude: ['src/**/__tests__/**', 'src/example/**'],
            // Ratchet, not a target: these are the measured floor minus one point of cushion.
            // Raise them when real coverage rises; never lower them just to make a build pass.
            // Global only — `perFile` would fail today on DataSource.ts (69%) and BaseModel.ts
            // (67%), which want tests rather than a threshold that has to be negotiated around.
            thresholds: {
                statements: 91,
                branches: 85,
                functions: 92,
                lines: 91,
            },
        },
    },
});
