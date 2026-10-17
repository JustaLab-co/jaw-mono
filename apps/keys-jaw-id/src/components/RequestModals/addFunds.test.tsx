// @vitest-environment jsdom
// A request blocked on funds offers Add funds in the same popup. Leaving that
// view ends the request with 4001 and ADD_FUNDS_REJECTION, so the caller
// retries after the deposit, and nothing is ever signed from it.
//
// The session account and the estimates are stubbed: what is under test is
// which button the modal offers and how the pending request settles.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PendingRequest } from '../../utils/types';
import type { PopupCommunicator } from '../../lib/popup-communicator';
import type { TransactionRequestData } from '../TransactionModal';
import { SDKRequestType } from '../../lib/sdk-types';

const ALICE = '0x00000000000000000000000000000000000A11cE';
const BOB = '0x0000000000000000000000000000000000000B0b';
const CHAIN = 84532;

const signer = {
  address: ALICE,
  sendCalls: vi.fn(),
  sendTransaction: vi.fn(),
  grantPermissions: vi.fn(),
  revokePermission: vi.fn(),
};

// A session handoff can swap the wallet address; a capabilities call that never
// answers keeps the fee token list loading.
const session = { walletAddress: ALICE, feeTokensPending: false };

vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({ account: signer, isLoading: false, walletAddress: session.walletAddress }),
}));
vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    handleGetCapabilitiesRequest: () => (session.feeTokensPending ? new Promise(() => undefined) : Promise.resolve({})),
  };
});
vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    useGasEstimation: () => ({
      gasFee: '',
      gasFeeLoading: false,
      gasEstimationError: 'Insufficient funds',
      tokenEstimates: [],
      selectedFeeToken: null,
      setSelectedFeeToken: () => undefined,
      isPayingWithErc20: false,
    }),
    useAssetPreview: () => ({ assetsOut: [], assetsIn: [] }),
    usePermissionExecution: ({ permissionId }: { permissionId?: string }) => ({
      onBehalfOf: permissionId ? BOB : undefined,
      loading: false,
      problem: null,
    }),
    usePermissionRevocation: () => ({
      permission: { spender: BOB, end: 2_000_000_000, spends: [], calls: [] },
      loading: false,
      problem: null,
    }),
    useSpenderPrefund: () => ({ quote: null, loading: false }),
    getPublicClient: () => ({ readContract: () => Promise.reject(new Error('offline')) }),
  };
});

const { RequestModals } = await import('./index');
const ADD_FUNDS_REJECTION = 'Insufficient funds. The user opened Add funds; retry after the deposit.';

const txData = (method: TransactionRequestData['method'], permissionId?: `0x${string}`): TransactionRequestData => ({
  method,
  transactions: [{ to: BOB, value: '0x1', chainId: CHAIN }],
  chainId: CHAIN,
  from: ALICE,
  permissionId,
});
const grantParams = (address: string) => [
  {
    address,
    chainId: CHAIN,
    expiry: 2_000_000_000,
    spender: BOB,
    permissions: { calls: [{ target: BOB, selector: '0xa9059cbb' }] },
  },
];

type Case = { type: SDKRequestType; params: unknown[]; tx: TransactionRequestData | null };
const cases = {
  wallet_sendCalls: { type: SDKRequestType.SEND_TRANSACTION, params: [], tx: txData('wallet_sendCalls') },
  eth_sendTransaction: { type: SDKRequestType.SEND_TRANSACTION, params: [], tx: txData('eth_sendTransaction') },
  wallet_grantPermissions: { type: SDKRequestType.GRANT_PERMISSIONS, params: grantParams(ALICE), tx: null },
  wallet_revokePermissions: {
    type: SDKRequestType.REVOKE_PERMISSIONS,
    params: [{ id: '0x01', address: ALICE }],
    tx: null,
  },
} satisfies Record<string, Case>;

let root: Root | undefined;
let rerender: () => Promise<void>;
const requestClose = vi.fn();

async function render({ type, params, tx }: Case) {
  const onReject = vi.fn(async () => undefined);
  const pendingRequest: PendingRequest = {
    origin: 'https://dapp.example',
    type,
    requestId: 'req',
    correlationId: 'corr',
    metadata: { appName: 'Dapp' } as PendingRequest['metadata'],
    method: '',
    params,
    chain: { id: CHAIN, rpcUrl: 'https://rpc.example' },
    onApprove: vi.fn(async () => undefined),
    onReject,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mounted = createRoot(container);
  root = mounted;
  const tree = () => (
    <RequestModals
      pendingRequest={pendingRequest}
      communicator={{ requestClose } as unknown as PopupCommunicator}
      apiKey="test-key"
      currentOrigin="https://dapp.example"
      txData={tx}
      setPhase={() => undefined}
      setError={() => undefined}
      scheduleClose={() => undefined}
      finishDeliveredFlow={() => undefined}
      closeDelayMs={0}
      signDelivered={false}
    />
  );
  rerender = async () => {
    await act(async () => mounted.render(tree()));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
  };
  await rerender();
  return onReject;
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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  Object.values(signer).forEach((fn) => typeof fn === 'function' && fn.mockReset());
  requestClose.mockReset();
  Object.assign(session, { walletAddress: ALICE, feeTokensPending: false });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const blocked = Object.entries(cases);

describe('a request blocked on funds', () => {
  it.each(blocked)('Given %s blocked with funds, When it renders, Then "Add funds" is enabled', async (_, request) => {
    await render(request);

    expect(buttonNamed('Add funds')?.disabled).toBe(false);
  });

  it.each(blocked)(
    'Given %s blocked with funds while the fee tokens load, When it renders, Then it does not offer Add funds',
    async (_, request) => {
      session.feeTokensPending = true;
      await render(request);

      expect(buttonNamed('Add funds')).toBeUndefined();
      expect(buttonNamed('Insufficient Funds')?.disabled).toBe(true);
    }
  );

  it.each([
    ['a call under a permissionId', { ...cases.wallet_sendCalls, tx: txData('wallet_sendCalls', '0x01') }],
    ['a grant for another address', { ...cases.wallet_grantPermissions, params: grantParams(BOB) }],
  ])('Given %s, When it renders, Then it stays the disabled "Insufficient Funds"', async (_, request) => {
    await render(request);

    expect(buttonNamed('Add funds')).toBeUndefined();
    expect(buttonNamed('Insufficient Funds')?.disabled).toBe(true);
  });

  it.each(blocked)(
    'Given %s, When the user taps "Add funds", Then it shows the connected address on the request chain only, unsettled',
    async (_, request) => {
      const onReject = await render(request);
      await click('Add funds');

      expect(document.querySelectorAll('[data-slot="dialog-content"]')).toHaveLength(1);
      expect(document.body.textContent).toContain('Receive on');
      expect(document.body.textContent).toContain(ALICE);
      expect(document.body.textContent).toContain('dapp.example');
      expect(document.querySelector('[aria-label="QR code to receive on Base Sepolia"]')).not.toBeNull();
      expect(
        document.querySelector('[aria-label^="Works on"], [aria-label^="Accepted on"]')?.getAttribute('aria-label')
      ).toBe('Accepted on Base Sepolia');
      expect(onReject).not.toHaveBeenCalled();
    }
  );

  const leave = {
    Done: () => click('Done'),
    X: () => act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')?.click()),
    Escape: () => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))),
  };

  describe.each(blocked)('Given %s on Add funds', (_, request) => {
    it.each(Object.entries(leave))(
      'When the user leaves with %s, Then it rejects once with 4001 and ADD_FUNDS_REJECTION, unsigned',
      async (_, exit) => {
        const onReject = await render(request);
        await click('Add funds');
        await exit();

        expect(onReject.mock.calls).toEqual([[ADD_FUNDS_REJECTION, 4001]]);
        Object.values(signer).forEach((fn) => typeof fn === 'function' && expect(fn).not.toHaveBeenCalled());
      }
    );
  });

  it.each(blocked)(
    'Given %s on Add funds, When the session hands off to another address, Then it stays on the captured one, unsettled',
    async (_, request) => {
      const onReject = await render(request);
      await click('Add funds');

      session.walletAddress = BOB;
      await rerender();

      expect(document.body.textContent).toContain('Receive on');
      expect(document.body.textContent).toContain(ALICE);
      expect(document.body.textContent).not.toContain(BOB);
      expect(onReject).not.toHaveBeenCalled();
    }
  );

  it.each(blocked)(
    'Given %s on Add funds, When the user leaves with Done, Done, X and Escape, Then it rejects and closes once',
    async (_, request) => {
      const onReject = await render(request);
      await click('Add funds');

      await leave.Done();
      await leave.Done();
      await leave.X();
      await leave.Escape();

      expect(onReject.mock.calls).toEqual([[ADD_FUNDS_REJECTION, 4001]]);
      expect(requestClose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(blocked)(
    'Given %s, When the user taps Cancel on the request view, Then it rejects with the current message',
    async (_, request) => {
      const onReject = await render(request);
      await click(request.type === SDKRequestType.REVOKE_PERMISSIONS ? 'Keep it' : 'Cancel');

      expect(onReject.mock.calls).toEqual([['User rejected the request', 4001]]);
    }
  );
});
