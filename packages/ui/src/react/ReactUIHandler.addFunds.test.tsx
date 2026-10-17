// @vitest-environment jsdom
// A request blocked on funds offers Add funds in the same dialog. Leaving that
// view ends the request with 4001 and ADD_FUNDS_REJECTION, so the caller
// retries after the deposit, and nothing is ever signed from it.
//
// The account and the estimates are stubbed: what is under test is which
// button the wrapper offers and how the request settles, not the fee math.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { Address } from 'viem';
import type {
  AddFundsUIRequest,
  PermissionUIRequest,
  RevokePermissionUIRequest,
  SendTransactionUIRequest,
  TransactionUIRequest,
  UIRequest,
  UIResponse,
} from '@jaw.id/core';

const ALICE = '0x00000000000000000000000000000000000A11cE';
const BOB = '0x0000000000000000000000000000000000000B0b';

const signer = {
  address: ALICE,
  sendCalls: vi.fn(),
  sendTransaction: vi.fn(),
  grantPermissions: vi.fn(),
  revokePermission: vi.fn(),
};

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return { ...actual, Account: { get: async () => signer }, handleGetCapabilitiesRequest: async () => ({}) };
});
vi.mock('../hooks/useGasEstimation', () => ({
  useGasEstimation: () => ({
    gasFee: '',
    gasFeeLoading: false,
    gasEstimationError: 'Insufficient funds',
    tokenEstimates: [],
    selectedFeeToken: null,
    setSelectedFeeToken: () => undefined,
    isPayingWithErc20: false,
  }),
}));
// The grant screen reads token names over RPC before it settles; offline, that fails fast here
// instead of after the transport's retries.
vi.mock('../utils/publicClient', () => ({
  getPublicClient: () => ({ readContract: () => Promise.reject(new Error('offline')) }),
}));
vi.mock('../hooks/useAssetPreview', () => ({ useAssetPreview: () => ({ assetsOut: [], assetsIn: [] }) }));
vi.mock('../hooks/usePermissionExecution', () => ({
  usePermissionExecution: ({ permissionId }: { permissionId?: string }) => ({
    onBehalfOf: permissionId ? BOB : undefined,
    loading: false,
    problem: null,
  }),
}));
vi.mock('../hooks/usePermissionRevocation', () => ({
  usePermissionRevocation: () => ({
    permission: { spender: BOB, end: 2_000_000_000, spends: [], calls: [] },
    loading: false,
    problem: null,
  }),
}));

const { ReactUIHandler } = await import('./ReactUIHandler');
const ADD_FUNDS_REJECTION = 'Insufficient funds. The user opened Add funds; retry after the deposit.';

const base = { id: 'req', timestamp: 0 };
// Not the handler's default chain, so a wrapper that passes the default instead of the request's chain fails.
const DEFAULT_CHAIN = 8453;
const CHAIN = 84532;
const sendCalls = (capabilities?: TransactionUIRequest['data']['capabilities']): TransactionUIRequest => ({
  ...base,
  type: 'wallet_sendCalls',
  data: { version: '2.0.0', from: ALICE, chainId: CHAIN, calls: [{ to: BOB, value: '0x1' }], capabilities },
});
const sendTransaction: SendTransactionUIRequest = {
  ...base,
  type: 'eth_sendTransaction',
  data: { from: ALICE, to: BOB, value: '0x1', chainId: CHAIN },
};
const grant = (address: Address): PermissionUIRequest => ({
  ...base,
  type: 'wallet_grantPermissions',
  data: {
    address,
    chainId: CHAIN,
    expiry: 2_000_000_000,
    spender: BOB,
    permissions: { calls: [{ target: BOB, selector: '0xa9059cbb' }] },
  },
});
const revoke: RevokePermissionUIRequest = {
  ...base,
  type: 'wallet_revokePermissions',
  data: { permissionId: '0x01', address: ALICE, chainId: CHAIN },
};

/** Opens the request and returns its response, still pending while the dialog is up. */
async function open(request: UIRequest, options?: ConstructorParameters<typeof ReactUIHandler>[0]) {
  const handler = new ReactUIHandler(options);
  handler.init({ apiKey: 'test-key', defaultChainId: DEFAULT_CHAIN } as Parameters<typeof handler.init>[0]);
  let response: UIResponse<unknown> | undefined;
  await act(async () => {
    void handler.request(request).then((r) => (response = r));
  });
  // Account.get resolves on a later tick than the first render.
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return () => response;
}

const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = (label: string) => act(async () => buttonNamed(label)?.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  Object.values(signer).forEach((fn) => typeof fn === 'function' && fn.mockReset());
});

afterEach(async () => {
  await act(async () => undefined);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const blocked = [
  ['wallet_sendCalls', sendCalls()],
  ['eth_sendTransaction', sendTransaction],
  ['wallet_grantPermissions', grant(ALICE)],
  ['wallet_revokePermissions', revoke],
] as const;

describe('a request blocked on funds', () => {
  it.each(blocked)('Given %s blocked with funds, When it renders, Then "Add funds" is enabled', async (_, request) => {
    await open(request);

    expect(buttonNamed('Add funds')?.disabled).toBe(false);
  });

  it.each([
    ['a call under a permissionId', sendCalls({ permissions: { id: '0x01' } })],
    ['a grant for another address', grant(BOB)],
  ])('Given %s, When it renders, Then it stays the disabled "Insufficient Funds"', async (_, request) => {
    await open(request);

    expect(buttonNamed('Add funds')).toBeUndefined();
    expect(buttonNamed('Insufficient Funds')?.disabled).toBe(true);
  });

  it.each(blocked)(
    'Given %s, When the user taps "Add funds", Then it shows the connected address on the request chain only, unsettled',
    async (_, request) => {
      const response = await open(request);
      await click('Add funds');

      expect(document.querySelectorAll('[data-slot="dialog-content"]')).toHaveLength(1);
      expect(document.body.textContent).toContain('Receive on');
      expect(document.body.textContent).toContain(ALICE);
      expect(document.querySelector('[aria-label="QR code to receive on Base Sepolia"]')).not.toBeNull();
      expect(
        document.querySelector('[aria-label^="Works on"], [aria-label^="Accepted on"]')?.getAttribute('aria-label')
      ).toBe('Accepted on Base Sepolia');
      expect(response()).toBeUndefined();
    }
  );

  it.each(blocked)(
    'Given %s on a handler with an originLabel, When the user taps "Add funds", Then the header keeps that label',
    async (_, request) => {
      await open(request, { originLabel: 'via JAW bridge' });
      await click('Add funds');

      expect(document.body.textContent).toContain('Receive on');
      expect(document.body.textContent).toContain('via JAW bridge');
    }
  );

  const leave = {
    X: () => act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')?.click()),
    Escape: () => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))),
  };

  it.each(Object.entries(leave))(
    'When the user leaves Add funds with %s, Then it rejects with 4001 and ADD_FUNDS_REJECTION, unsigned',
    async (_, exit) => {
      const response = await open(sendCalls());
      await click('Add funds');
      await exit();

      expect(response()?.approved).toBe(false);
      expect(response()?.error).toMatchObject({ code: 4001, message: ADD_FUNDS_REJECTION });
      expect(signer.sendCalls).not.toHaveBeenCalled();
    }
  );

  it.each(blocked)(
    'Given %s, When the user taps Done on Add funds, Then it rejects with ADD_FUNDS_REJECTION',
    async (_, request) => {
      const response = await open(request);
      await click('Add funds');
      await click('Done');

      expect(response()?.error).toMatchObject({ code: 4001, message: ADD_FUNDS_REJECTION });
      Object.values(signer).forEach((fn) => typeof fn === 'function' && expect(fn).not.toHaveBeenCalled());
    }
  );

  it('When the user taps Cancel on the request view, Then it rejects with the current message', async () => {
    const response = await open(sendCalls());
    await click('Cancel');

    expect(response()?.error).toMatchObject({ code: 4001, message: 'User rejected the request' });
  });
});

describe('wallet_addFunds called directly', () => {
  it('Given the Add Funds screen, When the user taps Done, Then it approves with null', async () => {
    const addFunds: AddFundsUIRequest = { ...base, type: 'wallet_addFunds', data: { address: ALICE, chainId: CHAIN } };
    const response = await open(addFunds);
    await click('Done');

    expect(response()).toMatchObject({ approved: true, data: null });
  });
});
