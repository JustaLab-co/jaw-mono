import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const KEYS_URL = process.env.JAW_E2E_KEYS_URL ?? 'http://localhost:3001';
export const PLAYGROUND_URL = process.env.JAW_E2E_PLAYGROUND_URL ?? 'http://localhost:3002';

/** The address the mocked factory reports for the test passkey's smart account. */
export const ACCOUNT = '0x00000000000000000000000000000000000e2e01';
const CHAIN_ID = '0xaa36a7';

/**
 * A P-256 passkey the test owns. Chromium's virtual authenticator holds the
 * private key, and keys gets the matching account in its local list, so the
 * sign-in runs the real WebAuthn ceremony with nobody at the keyboard.
 */
export class Passkey {
  readonly credentialId: string;
  readonly publicKey: string;
  private readonly credential: Buffer;
  private readonly privateKey: string;
  private readonly authenticators: {
    page: Page;
    cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>;
    id: string;
  }[] = [];
  private refusing = false;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { x, y } = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.publicKey = `0x04${Buffer.from(x, 'base64url').toString('hex')}${Buffer.from(y, 'base64url').toString('hex')}`;
    this.credential = randomBytes(16);
    this.credentialId = this.credential.toString('base64url');
    this.privateKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  }

  /** Authenticators live on a target, so every keys popup gets its own. */
  async attach(context: BrowserContext, page: Page) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId: id } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: !this.refusing,
        automaticPresenceSimulation: !this.refusing,
      },
    });
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId: id,
      credential: {
        credentialId: this.credential.toString('base64'),
        isResidentCredential: false,
        rpId: new URL(KEYS_URL).hostname,
        privateKey: this.privateKey,
        signCount: 0,
      },
    });
    this.authenticators.push({ page, cdp, id });
  }

  /** Makes the next ceremonies fail the way a user dismissing the prompt does. */
  async refuse() {
    this.refusing = true;
    for (const { page, cdp, id } of this.authenticators) {
      if (page.isClosed()) continue;
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId: id, isUserVerified: false });
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: id, enabled: false });
    }
  }
}

/**
 * Everything the SDK and keys ask api.justaname.id, answered in the test. The
 * RPC answers the three calls a sign-in makes for an undeployed account; the
 * rest gets a 404, which both apps already treat as optional data missing.
 */
export class Network {
  rpcDown = false;

  async install(context: BrowserContext) {
    await context.route('https://api.justaname.id/**', async (route) => {
      const request = route.request();
      if (!request.url().includes('/rpc') || request.method() !== 'POST') {
        return route.fulfill({ status: 404, json: {} });
      }
      if (this.rpcDown) return route.fulfill({ status: 503, body: 'down' });
      const body = request.postDataJSON();
      const answer = (call: { id: number; method: string }) => ({
        jsonrpc: '2.0',
        id: call.id,
        result: rpc(call.method),
      });
      return route.fulfill({ json: Array.isArray(body) ? body.map(answer) : answer(body) });
    });
  }
}

function rpc(method: string) {
  if (method === 'eth_chainId') return CHAIN_ID;
  if (method === 'eth_getCode') return '0x';
  if (method === 'eth_call') return `0x${ACCOUNT.slice(2).padStart(64, '0')}`;
  return null;
}

/** The playground's `/core` page, driven the way a person uses it. */
export class Dapp {
  constructor(
    readonly page: Page,
    private readonly context: BrowserContext
  ) {}

  async open() {
    await this.page.goto('/core');
    await expect(this.page.getByRole('button', { name: /^Execute/ }).last()).toBeEnabled();
  }

  async select(category: string, method: string) {
    const item = this.page.getByRole('button', { name: method, exact: true });
    if (!(await item.isVisible())) await this.page.getByRole('button', { name: new RegExp(`^${category}`) }).click();
    await item.click();
  }

  /** Runs the selected method. Plain http routes every dialog to a popup. */
  async execute(): Promise<Page> {
    const [popup] = await Promise.all([
      this.context.waitForEvent('page'),
      this.page
        .getByRole('button', { name: /^Execute/ })
        .last()
        .click(),
    ]);
    return popup;
  }

  async executeWithoutDialog() {
    await this.page
      .getByRole('button', { name: /^Execute/ })
      .last()
      .click();
  }

  /** The playground's verdict for the last run: "OK · 12ms" or "Error · 12ms". */
  result(): Locator {
    return this.page.getByText(/^(OK|Error) · \d+ms$/);
  }

  response(): Locator {
    return this.page.locator('pre').last();
  }

  /** Moves the stored connection past the default 24h authTTL and reloads. */
  async expireConnection() {
    await this.page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('jawsdk.store') ?? '{}');
      raw.state.account.connectedAt = Date.now() - 25 * 3600 * 1000;
      localStorage.setItem('jawsdk.store', JSON.stringify(raw));
    });
    await this.open();
  }
}

/** Screens of the keys dialog, by what a person reads on them. */
export const keys = {
  accountScreen: (popup: Page) => popup.getByText('Welcome back.'),
  account: (popup: Page) => popup.getByText('e2e', { exact: true }),
  button: (popup: Page, name: 'Connect' | 'Sign' | 'Cancel') => popup.getByRole('button', { name, exact: true }),
  close: (popup: Page) => popup.getByRole('button', { name: 'Cancel', exact: true }).first(),
};

/** Seeds the keys origin with the account the passkey belongs to. */
async function seedAccount(context: BrowserContext, passkey: Passkey) {
  const page = await context.newPage();
  await page.goto(KEYS_URL);
  await page.evaluate(
    ({ credentialId, publicKey }) =>
      localStorage.setItem(
        'jaw:passkey:accounts',
        JSON.stringify([
          { credentialId, publicKey, username: 'e2e', creationDate: new Date().toISOString(), isImported: false },
        ])
      ),
    { credentialId: passkey.credentialId, publicKey: passkey.publicKey }
  );
  await page.close();
}

/**
 * Leaves the keys session for the playground with its keys but no signed-in
 * account. Sessions are stored under the SHA-256 of the dApp origin.
 */
export async function signOutKeysSession(context: BrowserContext) {
  const hash = createHash('sha256').update(new URL(PLAYGROUND_URL).origin).digest('hex');
  const page = await context.newPage();
  await page.goto(KEYS_URL);
  await page.evaluate((hash) => {
    const sessions = JSON.parse(localStorage.getItem('jaw:sessions:apps') ?? '{}');
    sessions[hash].authState = null;
    localStorage.setItem('jaw:sessions:apps', JSON.stringify(sessions));
  }, hash);
  await page.close();
}

// Auto fixtures run for every test before the ones it asks for, in this order:
// the network first, since seeding loads the keys app, which must not reach the
// real API.
export const test = base.extend<{ network: Network; passkey: Passkey; dapp: Dapp }>({
  network: [
    async ({ context }, use) => {
      const network = new Network();
      await network.install(context);
      await use(network);
    },
    { auto: true },
  ],
  passkey: [
    async ({ context }, use) => {
      const passkey = new Passkey();
      context.on('page', (page) => void passkey.attach(context, page));
      await seedAccount(context, passkey);
      await use(passkey);
    },
    { auto: true },
  ],
  dapp: async ({ page, context }, use) => {
    const dapp = new Dapp(page, context);
    await dapp.open();
    await use(dapp);
  },
});

export { expect };
