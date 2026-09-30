import { defineConfig, devices } from '@playwright/test';

const KEYS_URL = process.env.JAW_E2E_KEYS_URL ?? 'http://localhost:3001';
const PLAYGROUND_URL = process.env.JAW_E2E_PLAYGROUND_URL ?? 'http://localhost:3002';
const CI = !!process.env.CI;

// Locally the dev servers are reused if already running. CI builds both apps
// and serves the production build: `next dev` compiles each route on first hit,
// which is slower than the dialog timeouts the tests assert against.
const serve = (project: string, dir: string, port: number) =>
  CI
    ? `bunx nx build ${project} && cd apps/${dir} && bunx next start -p ${port}`
    : `bunx nx dev ${project} --port=${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  reporter: CI ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  use: {
    baseURL: PLAYGROUND_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: serve('@jaw-mono/keys-jaw-id', 'keys-jaw-id', 3001),
      cwd: '..',
      url: KEYS_URL,
      reuseExistingServer: !CI,
      timeout: 300_000,
    },
    {
      command: serve('@jaw-mono/playground', 'playground', 3002),
      cwd: '..',
      url: `${PLAYGROUND_URL}/core`,
      reuseExistingServer: !CI,
      timeout: 300_000,
      env: { NEXT_PUBLIC_KEYS_URL: KEYS_URL },
    },
  ],
});
