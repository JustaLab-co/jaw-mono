// Usage: node tools/verify/bridge-stale-link.mjs <run-dir>
// Opens two wallet links from the hosted server's connect page. The first is
// opened while the server is up; the second after the server restarted, so
// nobody is left on its relay session. Prints what the wallet page says for each.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const run = process.argv[2];
if (!run) {
  console.error('usage: node tools/verify/bridge-stale-link.mjs <run-dir>');
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(`${run}/run.env`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(/=(.*)/s).slice(0, 2))
);
const base = new URL(env.MCP_PUBLIC_URL).origin;
const keys = new URL(env.KEYS_URL).origin;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const compose = (...args) =>
  execFileSync('docker', ['compose', '-p', env.COMPOSE_PROJECT, '-f', 'tools/verify/compose.yaml', ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString();

const browser = await chromium.launch();

/** Runs the connect page up to the wallet link and returns it without opening it. */
async function walletLink() {
  const ctx = await browser.newContext();
  let link;
  await ctx.route(`${keys}/**`, (route) => {
    link ??= route.request().url();
    return route.abort();
  });
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    client_id: 'jaw-cli',
    redirect_uri: 'http://127.0.0.1:9/callback',
    response_type: 'code',
    scope: 'wallet:read',
    state: randomBytes(8).toString('hex'),
    resource: `${base}/mcp`,
    code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
    code_challenge_method: 'S256',
  });
  await page.goto(`${base}/oauth/authorize?${params}`);
  await page.click('#open');
  for (let i = 0; i < 100 && !link; i++) await page.waitForTimeout(100);
  await ctx.close();
  if (!link) throw new Error('the connect page gave no wallet link');
  return link;
}

/** Opens a link on the real wallet page and reports what it says after `ms`. */
async function opened(link, ms) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await page.waitForTimeout(ms);
  const text = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ').trim();
  await ctx.close();
  return text;
}

const live = await walletLink();
log('link while the server is up:', live.replace(/#.*/, '#pk=...'));
log('page after 25s:', await opened(live, 25_000));

const stale = await walletLink();
log('second link:', stale.replace(/#.*/, '#pk=...'));
log('restarting the server');
compose('restart', 'mcp');
log('server restarted; opening the second link');
log('page after 25s:', await opened(stale, 25_000));

await browser.close();
