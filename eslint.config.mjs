import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    { ignores: ['dist/', 'coverage/', '**/*.d.ts'] },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    prettier,
    {
        rules: {
            '@typescript-eslint/ban-ts-comment': 'warn',
            // ConnectionOptions and EntityOptions are deliberate extension points
            '@typescript-eslint/no-empty-object-type': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-misused-new': 'warn',
            '@typescript-eslint/no-namespace': 'warn',
            '@typescript-eslint/no-this-alias': 'warn',
            '@typescript-eslint/no-unused-vars': 'warn',
            '@typescript-eslint/no-require-imports': 'warn',
            'no-async-promise-executor': 'warn',
            'no-control-regex': 'warn',
            'no-empty': 'warn',
            'no-prototype-builtins': 'warn',
            'no-regex-spaces': 'warn',
            'prefer-const': 'warn',
            'prefer-rest-params': 'warn',
            'prefer-spread': 'warn',
        },
    },
    {
        // The example scripts are plain Node.js, not part of the typed build
        files: ['src/example/**/*.js'],
        languageOptions: {
            globals: {
                require: 'readonly',
                module: 'readonly',
                console: 'readonly',
                process: 'readonly',
                __dirname: 'readonly',
            },
        },
    }
);
