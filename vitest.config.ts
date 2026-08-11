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
    },
});
