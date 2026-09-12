import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/src/**/*.test.ts', 'fixtures/src/**/*.test.ts'],
        environment: 'node',
    },
});
