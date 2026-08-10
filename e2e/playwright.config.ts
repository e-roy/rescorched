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
    /*
     * Always build and start fresh, even locally.
     *
     * `reuseExistingServer: !CI` is the usual setting and it is a trap here: the
     * webServer command is what BUILDS the client, so reusing a server means
     * reusing whatever `dist/` happened to be lying around. A client fix then
     * gets tested against the previous bundle and the suite reports on code that
     * is not the code you wrote — which cost real time on the turret fix, where
     * a correct change looked broken twice.
     *
     * Set SCORCHED_REUSE_SERVER=1 to opt back in while iterating on a test that
     * does not touch the client.
     */
    reuseExistingServer: process.env['SCORCHED_REUSE_SERVER'] === '1',
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: '..',
  },
});
