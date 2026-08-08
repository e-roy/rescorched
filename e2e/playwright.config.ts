import { defineConfig, devices } from '@playwright/test';

/**
 * Runs the whole stack for real: the client is built by Vite, then served by
 * `wrangler dev` — the actual workerd runtime with Durable Objects, SQLite and
 * WebSockets. No mocks, no cloud account.
 */
const PORT = Number(process.env['SCORCHED_PORT'] ?? 8787);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // Build the client first so Workers Static Assets has something to serve.
    command:
      'pnpm --filter @scorched/client build && pnpm --filter @scorched/server exec wrangler dev --port ' +
      PORT,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: '..',
  },
});
