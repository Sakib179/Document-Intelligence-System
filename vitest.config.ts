import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
