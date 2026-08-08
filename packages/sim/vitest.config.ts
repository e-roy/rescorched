import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sim',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The sim is pure: no setup files, no mocks, no globals needed.
    globals: false,
  },
});
