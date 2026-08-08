import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'protocol',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
