import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/tests/**/*.test.ts', 'fixtures/tests/**/*.test.ts'],
        environment: 'node'
    }
});
