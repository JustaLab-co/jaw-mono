import { expect, test, type Page } from '@playwright/test';

import { HTTPS, KEYS_URL } from './urls';

/**
 * The embedded iframe transport in a real browser: CSS compositing, the
 * iframe `color-scheme` canvas and the per-engine clickjacking guard, none of
 * which jsdom can see. Runs on chromium, firefox and webkit (about Safari).
 *
 * The guard only lets an untrusted host embed the iframe where the browser can
 * prove it is visible, through IntersectionObserver v2, which only Chromium
 * has. Firefox and WebKit fall back to the popup unless the host is trusted.
 */

const IFRAME = 'dialog[data-jaw] iframe';

// Over plain http the SDK never mounts the iframe, so every check here would
// pass without testing anything.
test.skip(!HTTPS, 'the iframe transport needs an https origin: run with JAW_E2E_HTTPS=1');

test.use({ colorScheme: 'dark', viewport: { width: 1000, height: 800 } });

test.beforeEach(async ({ page }) => {
  // OS dark, dApp forced light: theme sync must follow the dApp, not the OS.
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
});

/** The state of the keys document inside the embedded iframe. */
async function keysFrame(page: Page) {
  const frame = page.frames().find((f) => f.url().startsWith(KEYS_URL));
  return frame?.evaluate(() => ({
    embedded: document.documentElement.classList.contains('jaw-embedded'),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));
}

/** What holds on every engine once the iframe is mounted. */
async function expectSeeThroughCore(page: Page) {
  const iframe = page.locator(IFRAME);
  await expect(iframe).toBeAttached({ timeout: 15_000 });
  await expect(iframe).toHaveAttribute('src', new RegExp(`^${KEYS_URL}`));
  // Any other color-scheme makes the browser paint an opaque canvas over the dApp.
  await expect(iframe).toHaveCSS('color-scheme', 'normal');
  await expect.poll(async () => (await keysFrame(page))?.embedded, { timeout: 10_000 }).toBe(true);
}

test('the prewarmed iframe is see-through and hidden until a request', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chromium can embed an untrusted host');
  await page.goto('/wagmi', { waitUntil: 'networkidle' });

  await expectSeeThroughCore(page);
  // Theme sync is left to the unit tests: under a forced OS scheme the
  // playground's theme resolution races the prewarm and flakes in CI.
  expect((await keysFrame(page))?.bodyBackground).toBe('rgba(0, 0, 0, 0)');
  // Handshaken but not shown: the user never sees the dialog unprompted.
  await expect(page.locator(IFRAME)).toHaveCSS('visibility', 'hidden');
});

test('an untrusted host is not embedded without a visibility guarantee', async ({ page, browserName }) => {
  test.skip(browserName === 'chromium', 'Chromium can prove visibility and embeds');
  test.skip(process.env.JAW_E2E_TRUSTED === '1', 'the trusted-host run embeds on purpose');
  await page.goto('/wagmi', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5_000);

  await expect(page.locator(IFRAME)).toHaveCount(0);
});

test('an unreachable keys app never shows a broken frame and the dApp keeps working', async ({ page, context }) => {
  const keysHost = new URL(KEYS_URL).host;
  await context.route('**/*', (route) =>
    new URL(route.request().url()).host === keysHost ? route.abort() : route.continue()
  );
  await page.goto('/wagmi', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);

  const iframe = page.locator(IFRAME);
  if ((await iframe.count()) > 0) await expect(iframe).toHaveCSS('visibility', 'hidden');
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

// Needs the keys app started with JAW_TRUSTED_HOSTS=localhost, so it only runs
// when asked for. A connect is the only way the iframe mounts off Chromium.
test('a trusted host gets the see-through iframe on every engine', async ({ page, browserName }) => {
  test.skip(process.env.JAW_E2E_TRUSTED !== '1', 'set JAW_E2E_TRUSTED=1 against a keys app that trusts localhost');
  await page.goto('/wagmi', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4_000);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Execute' }).click();

  await expectSeeThroughCore(page);
  // Off Chromium the trusted iframe mounts late and its reveal timing varies.
  if (browserName === 'chromium') await expect(page.locator(IFRAME)).toHaveCSS('visibility', 'visible');
});
