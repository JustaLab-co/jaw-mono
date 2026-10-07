import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  test as base,
  expect,
  type BrowserContext,
  type Frame,
  type FrameLocator,
  type Locator,
  type Page,
} from '@playwright/test';

import { HTTPS, KEYS_URL, PLAYGROUND_URL } from './urls';

export { HTTPS, KEYS_URL };

/**
 * The keys dialog: a popup over http, the embedded iframe over https. Both
 * answer getByText and getByRole, so a test reads the same either way.
 */
export type Dialog = Page | FrameLocator;
const EMBEDDED = 'dialog[data-jaw]';

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
    gone: () => boolean;
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

  /**
   * Authenticators live on a target: every page gets one, and so does the keys
   * iframe whenever Chromium runs it in a process of its own, which it may do
   * for one test and not the next.
   */
  watch(context: BrowserContext, page: Page) {
    this.attach(context, page, () => page.isClosed()).catch((error) =>
      // Otherwise it surfaces later as a WebAuthn prompt nobody answers.
      console.error(`could not attach the virtual passkey to ${page.url() || 'a new page'}:`, error)
    );
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() || !frame.url().startsWith(KEYS_URL)) return;
      // Throws for an in-process frame, which the page's authenticator covers.
      this.attach(context, frame, () => frame.isDetached()).catch(() => undefined);
    });
  }

  private async attach(context: BrowserContext, target: Page | Frame, gone: () => boolean) {
    const cdp = await context.newCDPSession(target);
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
    this.authenticators.push({ gone, cdp, id });
  }

  /** Makes the next ceremonies fail the way a user dismissing the prompt does. */
  async refuse() {
    this.refusing = true;
    for (const { gone, cdp, id } of this.authenticators) {
      if (gone()) continue;
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
  /** RPC calls answered with an error while rpcDown was set. */
  rpcFailures = 0;

  async install(context: BrowserContext) {
    await context.route('https://api.justaname.id/**', async (route) => {
      const request = route.request();
      if (!request.url().includes('/rpc') || request.method() !== 'POST') {
        return route.fulfill({ status: 404, json: {} });
      }
      if (this.rpcDown) {
        this.rpcFailures++;
        return route.fulfill({ status: 503, body: 'down' });
      }
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

  /** Runs the selected method and returns the dialog it opens. */
  async execute(): Promise<Dialog> {
    if (HTTPS) {
      await this.executeWithoutDialog();
      return this.embedded();
    }
    const [popup] = await Promise.all([
      this.context.waitForEvent('page'),
      this.page
        .getByRole('button', { name: /^Execute/ })
        .last()
        .click(),
    ]);
    return popup;
  }

  /**
   * Runs the selected method while the last flow's dialog is still closing,
   * so the request lands in it. The iframe stays mounted across flows; a popup
   * that already closed means there is nothing left to reuse, and that fails.
   */
  async executeAfter(previous: Dialog): Promise<Dialog> {
    if (HTTPS) {
      await this.executeWithoutDialog();
      return this.embedded();
    }
    if ((previous as Page).isClosed()) throw new Error('the popup closed before the request, so nothing was reused');
    await this.executeWithoutDialog();
    return previous;
  }

  /**
   * Counts reveals of the embedded dialog from the next load on. It opens in
   * this page, so a listener for new pages never sees it.
   */
  async countReveals() {
    await this.page.addInitScript((selector) => {
      const counter = window as { jawReveals?: number };
      const showModal = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () {
        if (this.matches(selector)) counter.jawReveals = (counter.jawReveals ?? 0) + 1;
        showModal.call(this);
      };
    }, EMBEDDED);
  }

  reveals(): Promise<number> {
    return this.page.evaluate(() => (window as { jawReveals?: number }).jawReveals ?? 0);
  }

  /**
   * Holds every window.close() for a few seconds, so a request sent right
   * after a flow lands while the popup's close is still pending, however slow
   * the runner. A close that was not cancelled still happens.
   */
  async holdPopupClose() {
    await this.context.addInitScript(() => {
      const close = window.close.bind(window);
      window.close = () => setTimeout(close, 5_000);
    });
  }

  /**
   * The embedded dialog, once a person could use it. On every reveal keys'
   * clickjacking guard covers the dialog with a shield that swallows clicks
   * until IntersectionObserver v2 certifies the iframe as visible, one observer
   * cycle (100ms) later. The shield only appears after the guard's first
   * reading, so an absent shield proves nothing on its own: this waits for it
   * to stay absent for longer than a cycle.
   */
  private async embedded(): Promise<Dialog> {
    // Generous: over https the apps run on `next dev`, which compiles the keys
    // page on its first load, and that alone outlasts the default on CI runners.
    await expect(this.page.locator(`${EMBEDDED}[open]`)).toBeVisible({ timeout: 15_000 });
    const keysFrame = () => this.page.frames().find((f) => f.url().startsWith(KEYS_URL));
    await expect.poll(() => !!keysFrame(), { message: 'the keys iframe never attached' }).toBe(true);
    const frame = keysFrame();
    if (!frame) throw new Error('the keys iframe detached before the guard cleared');
    await frame.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let clearSince = performance.now();
          const check = () => {
            if (document.querySelector('[data-testid="jaw-clickjacking-shield"]')) clearSince = performance.now();
            if (performance.now() - clearSince >= 400) return resolve();
            setTimeout(check, 50);
          };
          check();
        })
    );
    return this.page.frameLocator(`${EMBEDDED} iframe`);
  }

  /** Resolves once the dialog is gone, so the next request starts clean. */
  async closed(dialog: Dialog) {
    if (HTTPS) return expect(this.page.locator(`${EMBEDDED}[open]`)).toHaveCount(0);
    const popup = dialog as Page;
    if (!popup.isClosed()) await popup.waitForEvent('close');
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
  accountScreen: (dialog: Dialog) => dialog.getByText('Welcome back.'),
  account: (dialog: Dialog) => dialog.getByText('e2e', { exact: true }),
  button: (dialog: Dialog, name: 'Connect' | 'Sign' | 'Cancel') => dialog.getByRole('button', { name, exact: true }),
  close: (dialog: Dialog) => dialog.getByRole('button', { name: 'Cancel', exact: true }).first(),
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
      context.on('page', (page) => passkey.watch(context, page));
      await seedAccount(context, passkey);
      await use(passkey);
    },
    { auto: true },
  ],
  dapp: async ({ page, context }, use) => {
    // JAW_E2E_DEBUG=1 prints what the dApp, the keys iframe and any popup log.
    if (process.env.JAW_E2E_DEBUG === '1') {
      const log = (source: Page) =>
        source.on('console', (msg) =>
          console.log(`[${new URL(source.url() || 'about:blank').port || '-'}] ${msg.text()}`)
        );
      log(page);
      context.on('page', log);
      await page.addInitScript((keysOrigin) => {
        window.addEventListener('message', (event) => {
          if (event.origin !== keysOrigin) return;
          const data = event.data ?? {};
          console.log(
            `postMessage from keys: ${data.event ?? (data.content ? Object.keys(data.content)[0] : 'response')}`
          );
        });
      }, new URL(KEYS_URL).origin);
    }
    const dapp = new Dapp(page, context);
    await dapp.open();
    await use(dapp);
  },
});

export { expect };
