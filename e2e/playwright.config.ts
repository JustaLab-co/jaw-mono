import { defineConfig, devices } from '@playwright/test';

import { HTTPS, KEYS_URL, PLAYGROUND_URL } from './urls';

const CI = !!process.env.CI;

// Locally the dev servers are reused if already running. CI serves the
// production build over http: `next dev` compiles each route on first hit,
// which is slower than the dialog timeouts the tests assert against. https is
// dev only (`next start` has no https), with the certificate from the
// environment when given and a local one otherwise.
function serve(project: string, dir: string, port: number) {
  if (HTTPS) {
    const cert = process.env.JAW_E2E_TLS_CERT;
    const key = process.env.JAW_E2E_TLS_KEY;
    const tls = cert && key ? ` --experimental-https-cert ${cert} --experimental-https-key ${key}` : '';
    return `cd apps/${dir} && bunx next dev --experimental-https${tls} -p ${port}`;
  }
  return CI
    ? `bunx nx build ${project} && cd apps/${dir} && bunx next start -p ${port}`
    : `bunx nx dev ${project} --port=${port}`;
}

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
    ignoreHTTPSErrors: HTTPS,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // The connect flows need the virtual authenticator, which only Chromium has.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: 'iframe-transport.spec.ts' },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: 'iframe-transport.spec.ts' },
  ],
  webServer: [
    {
      command: serve('@jaw-mono/keys-jaw-id', 'keys-jaw-id', 3001),
      cwd: '..',
      url: KEYS_URL,
      ignoreHTTPSErrors: HTTPS,
      reuseExistingServer: !CI,
      timeout: 300_000,
    },
    {
      command: serve('@jaw-mono/playground', 'playground', 3002),
      cwd: '..',
      url: `${PLAYGROUND_URL}/core`,
      ignoreHTTPSErrors: HTTPS,
      reuseExistingServer: !CI,
      timeout: 300_000,
      env: { NEXT_PUBLIC_KEYS_URL: KEYS_URL },
    },
  ],
});
