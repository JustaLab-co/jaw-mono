// @vitest-environment jsdom
// A dialog restores "the signed-in passkey" from storage (`Account.get` with no credential id), not
// the passkey that owns the account the request is for. When those differ, core refuses to sign for
// that account ("Signer is not an owner on account ..."), before any fee is estimated.
//
// Seen in the field: an account with USDC and no ETH, a stale signed-in passkey on keys.jaw.id, and
// every send link showing "Fee estimation failed" with a Retry that could never succeed. Clearing the
// site data (which drops the signed-in passkey) made the next link go through.
//
// What should happen instead: the account screen, defaulting to the requested account, and once the
// right passkey signs in, the same request carries on.
//
// `Account` is replaced by a small model of core's passkey storage and owner check. The network-bound
// preview hooks and the fee-token list are stubbed. The dialogs, the gas estimation hook, the fee row
// and the account screen are the real ones.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import type { Address } from 'viem';
import { createSiweMessage } from 'viem/siwe';

const PRODUCTMEE = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x5555555555555555555555555555555555555555' as Address;
const TO = '0x2222222222222222222222222222222222222222' as Address;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;

/** The passkeys saved on this device, each with the account it created (and so owns). */
const PASSKEYS = {
  'cred-productmee': { username: 'productmee', address: PRODUCTMEE },
  'cred-other': { username: 'other', address: OTHER },
} as const;
type CredentialId = keyof typeof PASSKEYS;

const world = {
  /** The passkey the wallet page has signed in, as `Account.get()` restores it. None after clearing site data. */
  signedIn: 'cred-other' as CredentialId | null,
  /** Passkeys saved on this device. */
  saved: ['cred-productmee', 'cred-other'] as CredentialId[],
  /** What the person picks in the browser's own passkey sheet. */
  pickInSheet: 'cred-productmee' as CredentialId,
  /** Every send that was signed, with the passkey that signed it. */
  sent: [] as Array<{ passkey: CredentialId; from?: string }>,
  /** Every message or typed data signed, with the passkey that signed it. */
  signed: [] as Array<{ passkey: CredentialId; address?: string }>,
  /** Core's owner lookup never answers, as on a slow network. */
  ownerCheckHangs: false,
  /** Core's owner lookup fails, as with no network. */
  ownerCheckFails: false,
  /** Restoring the signed-in passkey fails, as with no network. */
  restoreFails: false,
  /** Signing a chosen passkey in fails after its prompt, as with no network. */
  signInFails: false,
};

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  const owns = (passkey: CredentialId, address?: string) =>
    !address || PASSKEYS[passkey].address.toLowerCase() === address.toLowerCase();
  // The refusal core raises when the passkey is not an owner of the account (smartAccount.ts).
  const notOwner = (address?: string) =>
    actual.standardErrors.rpc.invalidParams(`Signer is not an owner on account ${address}`);
  const accountFor = (passkey: CredentialId) => ({
    address: PASSKEYS[passkey].address,
    getChain: () => ({ id: 8453 }),
    getMetadata: () => ({ username: PASSKEYS[passkey].username }),
    getSmartAccountFor: async (address?: Address) => {
      if (world.ownerCheckHangs) await new Promise(() => undefined);
      if (world.ownerCheckFails) throw new Error('fetch failed');
      if (!owns(passkey, address)) throw notOwner(address);
      return {};
    },
    // No ETH on any account, so the ETH leg can't pay the prefund.
    calculateGasCost: async (_calls: unknown, options?: { address?: Address }) => {
      if (!owns(passkey, options?.address)) throw notOwner(options?.address);
      throw new Error("AA21 didn't pay prefund");
    },
    sendCalls: async (_calls: unknown, options?: { from?: Address }) => {
      if (!owns(passkey, options?.from)) throw notOwner(options?.from);
      world.sent.push({ passkey, from: options?.from });
      return { id: '0xbatch', chainId: 8453 };
    },
    signMessage: async (_message: string, options?: { address?: Address }) => {
      if (!owns(passkey, options?.address)) throw notOwner(options?.address);
      world.signed.push({ passkey, address: options?.address });
      return '0xsig';
    },
    signTypedData: async (_typedData: unknown, options?: { address?: Address }) => {
      if (!owns(passkey, options?.address)) throw notOwner(options?.address);
      world.signed.push({ passkey, address: options?.address });
      return '0xsig';
    },
    sendTransaction: async (_calls: unknown, _paymasterUrl: unknown, _context: unknown, from?: Address) => {
      if (!owns(passkey, from)) throw notOwner(from);
      world.sent.push({ passkey, from });
      return '0xhash';
    },
  });
  const stored = (passkey: CredentialId) => ({
    credentialId: passkey,
    username: PASSKEYS[passkey].username,
    address: PASSKEYS[passkey].address,
    creationDate: new Date(2026, 0, passkey === 'cred-productmee' ? 1 : 2).toISOString(),
    isImported: false,
    publicKey: '0x04' as const,
  });
  return {
    ...actual,
    Account: {
      // With a credential id this is a passkey prompt that signs that passkey in.
      get: async (_config: unknown, credentialId?: CredentialId) => {
        if (credentialId && world.signInFails) throw new Error('fetch failed');
        if (!credentialId && world.restoreFails) throw new Error('fetch failed');
        if (credentialId) world.signedIn = credentialId;
        // What core throws when no passkey is signed in and none is asked for.
        if (!world.signedIn)
          throw new Error('Not authenticated. Please provide a credentialId to login, or create an account first.');
        return accountFor(world.signedIn);
      },
      // "Use another passkey": the browser's passkey sheet, then that passkey is signed in.
      import: async () => {
        world.signedIn = world.pickInSheet;
        if (!world.saved.includes(world.pickInSheet)) world.saved.push(world.pickInSheet);
        return accountFor(world.signedIn);
      },
      getStoredAccounts: () => world.saved.map(stored),
      getCurrentAccount: () => (world.signedIn ? stored(world.signedIn) : null),
      getAuthenticatedAddress: () => (world.signedIn ? PASSKEYS[world.signedIn].address : null),
    },
    handleGetCapabilitiesRequest: async () => ({
      '0x2105': { feeToken: { supported: true, tokens: [] } },
    }),
    estimateErc20PaymasterCosts: async () => [
      {
        tokenAddress: USDC,
        symbol: 'USDC',
        decimals: 6,
        tokenCost: 20_000n,
        tokenCostFormatted: '0.02',
        tokenCostMax: 60_000n,
        tokenCostMaxFormatted: '0.06',
        paymasterAddress: '0x4444444444444444444444444444444444444444',
        exchangeRate: 1n,
        hasSufficientBalance: true,
      },
    ],
  };
});

// The account in the report: no ETH, 5.08 USDC.
vi.mock('../utils/feeTokens', () => ({
  loadFeeTokenOptions: async () => [
    {
      uid: 'eth',
      symbol: 'ETH',
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      balance: 0n,
      balanceFormatted: '0',
      isNative: true,
      isSelectable: false,
    },
    {
      uid: 'usdc',
      symbol: 'USDC',
      address: USDC,
      decimals: 6,
      balance: 5_080_000n,
      balanceFormatted: '5.08',
      isNative: false,
      isSelectable: true,
    },
  ],
}));

vi.mock('../hooks/useAssetPreview', () => ({
  useAssetPreview: () => ({
    assetsOut: [],
    assetsIn: [],
    error: false,
    loading: false,
    simulated: false,
    willRevert: false,
    revertCause: undefined,
  }),
}));
vi.mock('../hooks/usePermissionExecution', () => ({
  usePermissionExecution: () => ({ onBehalfOf: undefined, loading: false, problem: undefined }),
}));
vi.mock('../hooks/usePermissionRevocation', () => ({
  usePermissionRevocation: () => ({ permission: null, loading: false, problem: null }),
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

// Each test renders whole dialogs through sign-in, fee tokens and both estimation legs, which runs
// long when the machine is busy (the pre-push hook runs several suites at once).
vi.setConfig({ testTimeout: 20_000 });

/** Let restores, owner checks, fee tokens and both estimation legs settle. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const screenText = () => document.body.textContent ?? '';

/** Waits for `text` to be on screen, rather than for a fixed number of ticks. */
async function shows(text: string) {
  await vi.waitFor(() => expect(screenText()).toContain(text), { timeout: 10_000 });
}

/** The signing screens' own button: Sign, or Sign In for a Sign-In with Ethereum message. */
const signButtons = () =>
  Array.from(document.querySelectorAll('button')).filter((b) =>
    ['Sign', 'Sign In'].includes(b.textContent?.trim() ?? '')
  );

/** Waits for a signing screen whose Sign can be pressed. */
async function showsSignable() {
  await vi.waitFor(() => expect(signButtons().some((b) => !b.disabled)).toBe(true), { timeout: 10_000 });
}

/** Close the account screen with its X, the person declining the request. */
async function closeAccountScreen() {
  await shows('Welcome back.');
  const close = document.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
  if (!close) throw new Error(`No close button on: ${screenText()}`);
  await act(async () => close.click());
}

/** Click the last enabled button whose text contains `label`, then settle. */
async function click(label: string) {
  const button = Array.from(document.querySelectorAll('button'))
    .filter((b) => b.textContent?.includes(label) && !b.disabled)
    .pop();
  if (!button) throw new Error(`No enabled button "${label}" on: ${screenText()}`);
  await act(async () => button.click());
  await settle();
}

/** Every handler a test opened, closed after it so its dialogs stop running into the next test. */
const handlers: InstanceType<typeof ReactUIHandler>[] = [];

/** Open a request and settle it. `answer` is what the dApp gets back. */
async function open(request: unknown): Promise<{ answer: Promise<unknown> }> {
  const handler = new ReactUIHandler();
  handlers.push(handler);
  (handler as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 8453,
    paymasters: {},
    appName: 'Test app',
  };
  let answer!: Promise<unknown>;
  await act(async () => {
    answer = handler.request(request as Parameters<ReactUIHandler['request']>[0]);
    answer.catch(() => undefined);
  });
  await settle();
  // Wrapped, or awaiting `open` would wait for the request itself to settle.
  return { answer };
}

/** Both ways a dApp asks to send, each from PRODUCTMEE, with what the dApp gets back once sent. */
const SENDS = [
  {
    method: 'wallet_sendCalls',
    request: {
      id: 'req-send',
      type: 'wallet_sendCalls',
      data: { from: PRODUCTMEE, chainId: 8453, calls: [{ to: TO, value: '0x0', data: '0x' }] },
    },
    sent: { id: '0xbatch' },
  },
  {
    method: 'eth_sendTransaction',
    request: {
      id: 'req-send',
      type: 'eth_sendTransaction',
      data: { from: PRODUCTMEE, chainId: 8453, to: TO, value: '0x0', data: '0x' },
    },
    sent: '0xhash',
  },
];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  // Name lookups, chain icons and the bridge table are not what this is about.
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline in this test');
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  world.signedIn = 'cred-other';
  world.saved = ['cred-productmee', 'cred-other'];
  world.pickInSheet = 'cred-productmee';
  world.sent = [];
  world.signed = [];
  world.ownerCheckHangs = false;
  world.ownerCheckFails = false;
  world.restoreFails = false;
  world.signInFails = false;
});
afterEach(async () => {
  // Rejects and unmounts what is still open. `open` already catches the answer.
  await act(async () => handlers.splice(0).forEach((handler) => handler.dismiss()));
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(SENDS)('$method with a signed-in passkey that does not own the account', ({ request, sent }) => {
  it('control: with the owning passkey signed in, the send screen shows the USDC fee', async () => {
    world.signedIn = 'cred-productmee';
    await open(request);
    await shows('0.02 USDC');
    expect(screenText()).not.toContain('Welcome back.');
  });

  it('shows the account screen with the requested account instead of a failed fee', async () => {
    await open(request);
    await shows('Welcome back.');
    const screen = screenText();
    expect(screen).not.toContain('Fee estimation failed');
    expect(screen).toContain('Requested');
    expect(screen).toContain('productmee');
  });

  it('carries on with the same request once the requested account signs in, and signs with its passkey', async () => {
    const { answer } = await open(request);
    await click('productmee');

    expect(world.signedIn).toBe('cred-productmee');
    await shows('0.02 USDC');

    await click('Confirm');
    expect(world.sent).toEqual([{ passkey: 'cred-productmee', from: PRODUCTMEE }]);
    await expect(answer).resolves.toMatchObject({ approved: true, data: sent });
  });

  it('says it is the wrong account when the passkey picked in the sheet still does not own it', async () => {
    world.pickInSheet = 'cred-other';
    await open(request);
    await click('Show more accounts');

    await shows('Wrong account.');
    expect(screenText()).not.toContain('0.02 USDC');
    expect(world.sent).toEqual([]);

    // "Use another passkey" goes back, and the right one then carries on.
    await click('Use another passkey');
    world.pickInSheet = 'cred-productmee';
    await click('Show more accounts');
    await shows('0.02 USDC');
  });

  it('signs in through the passkey sheet when the requested account is not saved on this device', async () => {
    world.saved = ['cred-other'];
    await open(request);

    await shows('This request is for');
    expect(screenText()).not.toContain('Create');
    await click('Sign in');

    expect(world.signedIn).toBe('cred-productmee');
    await shows('0.02 USDC');
  });

  it('rejects the request as the person declining it when they close the account screen', async () => {
    const { answer } = await open(request);
    await closeAccountScreen();

    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
    expect(world.sent).toEqual([]);
  });
});

/** Granting and revoking a permission on PRODUCTMEE. */
const PERMISSIONS = [
  {
    method: 'wallet_grantPermissions',
    request: {
      id: 'req-grant',
      type: 'wallet_grantPermissions',
      data: {
        address: PRODUCTMEE,
        chainId: 8453,
        expiry: Math.floor(Date.now() / 1000) + 86_400,
        spender: TO,
        permissions: { spends: [{ token: USDC, allowance: '1000000', unit: 'day', multiplier: 1 }] },
      },
    },
  },
  {
    method: 'wallet_revokePermissions',
    request: {
      id: 'req-revoke',
      type: 'wallet_revokePermissions',
      data: { address: PRODUCTMEE, chainId: 8453, permissionId: `0x${'ab'.repeat(32)}` },
    },
  },
];

describe.each(PERMISSIONS)('$method with a signed-in passkey that does not own the account', ({ request }) => {
  it('control: with the owning passkey signed in, the permission screen opens', async () => {
    world.signedIn = 'cred-productmee';
    await open(request);
    await shows('0.02 USDC');
    expect(screenText()).not.toContain('Welcome back.');
  });

  it('shows the account screen with the requested account, then the permission screen once it signs in', async () => {
    await open(request);
    await shows('Welcome back.');
    await shows('Requested');

    await click('productmee');
    expect(world.signedIn).toBe('cred-productmee');
    await shows('0.02 USDC');
    expect(screenText()).not.toContain('Welcome back.');
  });

  it('rejects the request as the person declining it when they close the account screen', async () => {
    const { answer } = await open(request);
    await closeAccountScreen();
    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
  });
});

/** Signing for PRODUCTMEE: a message, typed data, and a Sign-In with Ethereum message. */
const SIGNS = [
  {
    method: 'personal_sign',
    request: {
      id: 'req-sign',
      type: 'personal_sign',
      data: { message: 'Hello from the test app', address: PRODUCTMEE, chainId: 8453 },
    },
  },
  {
    method: 'eth_signTypedData_v4',
    request: {
      id: 'req-typed',
      type: 'eth_signTypedData_v4',
      data: {
        address: PRODUCTMEE,
        chainId: 8453,
        typedData: JSON.stringify({
          domain: { name: 'Test', version: '1', chainId: 8453 },
          types: { Note: [{ name: 'text', type: 'string' }] },
          primaryType: 'Note',
          message: { text: 'hello' },
        }),
      },
    },
  },
  {
    method: 'personal_sign (Sign-In with Ethereum)',
    request: {
      id: 'req-siwe',
      type: 'personal_sign',
      data: {
        address: PRODUCTMEE,
        chainId: 8453,
        // From this page's own origin, so the screen raises no origin warning to acknowledge.
        message: createSiweMessage({
          domain: window.location.host,
          address: PRODUCTMEE,
          uri: window.location.origin,
          version: '1',
          chainId: 8453,
          nonce: 'abcdef12',
        }),
      },
    },
  },
];

describe.each(SIGNS)('$method with a signed-in passkey that does not own the account', ({ request }) => {
  it('control: with the owning passkey signed in, the signing screen opens', async () => {
    world.signedIn = 'cred-productmee';
    await open(request);
    await showsSignable();
    expect(screenText()).not.toContain('Welcome back.');
  });

  it('shows the account screen with the requested account, then signs with its passkey', async () => {
    const { answer } = await open(request);
    await shows('Welcome back.');
    await shows('Requested');

    await click('productmee');
    expect(world.signedIn).toBe('cred-productmee');
    await showsSignable();
    expect(screenText()).not.toContain('Welcome back.');

    await click('Sign');
    // Signed for the requested account, not merely by its passkey.
    expect(world.signed).toEqual([{ passkey: 'cred-productmee', address: PRODUCTMEE }]);
    await expect(answer).resolves.toMatchObject({ approved: true, data: '0xsig' });
  });

  it('offers nothing to sign while the passkey is still being checked against the account', async () => {
    world.ownerCheckHangs = true;
    await open(request);
    await vi.waitFor(() => expect(signButtons().length).toBeGreaterThan(0), { timeout: 10_000 });
    // Sign starts out disabled anyway. Give a check that does answer time to, so it is the hung one
    // keeping it disabled.
    await settle();
    expect(signButtons().every((b) => b.disabled)).toBe(true);
    expect(world.signed).toEqual([]);
  });

  it('rejects the request as the person declining it when they close the account screen', async () => {
    const { answer } = await open(request);
    await closeAccountScreen();
    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
    expect(world.signed).toEqual([]);
  });
});

describe.each(SENDS)('$method with no passkey signed in', ({ request }) => {
  it('shows the account screen for the requested account, then the send screen once it signs in', async () => {
    world.signedIn = null;
    await open(request);
    await shows('Welcome back.');
    await shows('productmee');

    await click('productmee');
    expect(world.signedIn).toBe('cred-productmee');
    await shows('0.02 USDC');
  });
});

describe.each(SIGNS)('$method with no passkey signed in', ({ request }) => {
  it('shows the account screen for the requested account instead of a Sign that never enables, then signs', async () => {
    world.signedIn = null;
    const { answer } = await open(request);
    await shows('Welcome back.');
    await shows('productmee');

    await click('productmee');
    await showsSignable();
    await click('Sign');
    expect(world.signed).toEqual([{ passkey: 'cred-productmee', address: PRODUCTMEE }]);
    await expect(answer).resolves.toMatchObject({ approved: true, data: '0xsig' });
  });
});

describe('the account screen when a passkey cannot be checked against the requested account', () => {
  it('says the check failed, rather than nothing happening, and lets the person try again', async () => {
    const { answer } = await open(SIGNS[0].request);
    // A passkey that would need the chain to tell whether it co-owns the account, on a dead network.
    world.pickInSheet = 'cred-other';
    world.ownerCheckFails = true;
    await click('Show more accounts');

    await shows("Couldn't check");
    expect(screenText()).not.toContain('Wrong account.');

    world.ownerCheckFails = false;
    world.pickInSheet = 'cred-productmee';
    await click('Show more accounts');
    await showsSignable();
    expect(screenText()).not.toContain("Couldn't check");
    await click('Sign');
    await expect(answer).resolves.toMatchObject({ approved: true, data: '0xsig' });
  });
});

describe('wallet_sendCalls naming no account, with no passkey signed in', () => {
  it('offers a saved passkey to sign in with, with nothing to create, then the send screen', async () => {
    world.signedIn = null;
    await open({
      id: 'req-send',
      type: 'wallet_sendCalls',
      data: { chainId: 8453, calls: [{ to: TO, value: '0x0', data: '0x' }] },
    });
    await shows('Welcome back.');
    expect(screenText()).not.toContain('Create new account');

    await click('other');
    expect(world.signedIn).toBe('cred-other');
    await shows('0.02 USDC');
  });
});

describe.each(SIGNS)('$method when the signed-in passkey cannot be restored', ({ request }) => {
  it('shows the signing screen as before, and reports the failure when Sign is pressed', async () => {
    world.signedIn = 'cred-productmee';
    world.restoreFails = true;
    const { answer } = await open(request);
    await showsSignable();
    expect(screenText()).not.toContain('Welcome back.');

    await click('Sign');
    expect(world.signed).toEqual([]);
    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: -32603 } });
  });
});

describe('personal_sign after clearing site data, with nothing saved on this device', () => {
  it('signs in through the passkey sheet for the requested account, then signs', async () => {
    world.signedIn = null;
    world.saved = [];
    const { answer } = await open(SIGNS[0].request);
    await shows('This request is for');
    expect(screenText()).not.toContain('Create');

    await click('Sign in');
    await showsSignable();
    await click('Sign');
    expect(world.signed).toEqual([{ passkey: 'cred-productmee', address: PRODUCTMEE }]);
    await expect(answer).resolves.toMatchObject({ approved: true, data: '0xsig' });
  });
});

describe('the account screen when signing a passkey in fails after its prompt', () => {
  it('says so, rather than looking like a dismissed prompt', async () => {
    await open(SIGNS[0].request);
    world.signInFails = true;
    await click('productmee');

    await shows("Couldn't sign in with this passkey");
    await shows('Welcome back.');
  });
});
