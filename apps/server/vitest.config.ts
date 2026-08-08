import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Runs the server tests INSIDE workerd — the same runtime that serves
 * production. Durable Object lifecycle, SQLite storage, WebSocket hibernation
 * and protocol validation are all exercised for real, not mocked.
 *
 * `wrangler.configPath` means the tests get the same bindings and migrations as
 * `wrangler dev`, so the DO under test is genuinely SQLite-backed rather than a
 * lookalike configured in two places.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    name: 'server',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
