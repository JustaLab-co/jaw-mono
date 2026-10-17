// @vitest-environment jsdom
// Add funds must not end a request whose signed submission is still in flight:
// the caller would see 4001, retry after funding, and send twice.
//
// The dialogs are stubbed with buttons that are never disabled, standing in for
// the render where the disabled gates have not committed yet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type {
  PermissionUIRequest,
  RevokePermissionUIRequest,
  SendTransactionUIRequest,
  TransactionUIRequest,
  UIRequest,
  UIResponse,
} from '@jaw.id/core';

const ALICE = '0x00000000000000000000000000000000000A11cE';
const BOB = '0x0000000000000000000000000000000000000B0b';

let finishSubmit: (value: unknown) => void = () => undefined;
const pending = () => new Promise((resolve) => (finishSubmit = resolve));
const signer = {
  address: ALICE,
  sendCalls: vi.fn(pending),
  sendTransaction: vi.fn(pending),
  grantPermissions: vi.fn(pending),
  revokePermission: vi.fn(pending),
};

type StubProps = { onConfirm: () => void; onAddFunds?: () => void };
const StubDialog = ({ onConfirm, onAddFunds }: StubProps) => (
  <div>
    <button onClick={onConfirm}>Confirm</button>
    <button onClick={onAddFunds}>Add funds</button>
  </div>
);

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return { ...actual, Account: { get: async () => signer }, handleGetCapabilitiesRequest: async () => ({}) };
});
vi.mock('../components/TransactionDialog', () => ({ TransactionDialog: StubDialog }));
vi.mock('../components/PermissionDialog', () => ({ PermissionDialog: StubDialog }));
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
vi.mock('../hooks/useAssetPreview', () => ({ useAssetPreview: () => ({ assetsOut: [], assetsIn: [] }) }));
vi.mock('../hooks/usePermissionExecution', () => ({
  usePermissionExecution: () => ({ onBehalfOf: undefined, loading: false, problem: null }),
}));
vi.mock('../hooks/usePermissionRevocation', () => ({
  usePermissionRevocation: () => ({
    permission: { spender: BOB, end: 2_000_000_000, spends: [], calls: [] },
    loading: false,
    problem: null,
  }),
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const base = { id: 'req', timestamp: 0 };
const sendCalls: TransactionUIRequest = {
  ...base,
  type: 'wallet_sendCalls',
  data: { version: '2.0.0', from: ALICE, chainId: 8453, calls: [{ to: BOB, value: '0x1' }] },
};
const sendTransaction: SendTransactionUIRequest = {
  ...base,
  type: 'eth_sendTransaction',
  data: { from: ALICE, to: BOB, value: '0x1', chainId: 8453 },
};
const grant: PermissionUIRequest = {
  ...base,
  type: 'wallet_grantPermissions',
  data: {
    address: ALICE,
    chainId: 8453,
    expiry: 2_000_000_000,
    spender: BOB,
    permissions: { calls: [{ target: BOB, selector: '0xa9059cbb' }] },
  },
};
const revoke: RevokePermissionUIRequest = {
  ...base,
  type: 'wallet_revokePermissions',
  data: { permissionId: '0x01', address: ALICE, chainId: 8453 },
};

const settled: Record<string, unknown> = {
  wallet_sendCalls: { id: '0xabc', chainId: 8453 },
  eth_sendTransaction: '0xabc',
  wallet_grantPermissions: { permissionId: '0x02' },
  wallet_revokePermissions: {},
};

async function open(request: UIRequest) {
  const handler = new ReactUIHandler();
  handler.init({ apiKey: 'test-key', defaultChainId: 8453 } as Parameters<typeof handler.init>[0]);
  let response: UIResponse<unknown> | undefined;
  await act(async () => {
    void handler.request(request).then((r) => (response = r));
  });
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
});

afterEach(async () => {
  await act(async () => undefined);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Add funds during a submit', () => {
  it.each([sendCalls, sendTransaction, grant, revoke])(
    'Given $type submitting, When "Add funds" is tapped, Then the view stays and the submit settles the request',
    async (request) => {
      const response = await open(request);
      await click('Confirm');
      await click('Add funds');

      expect(document.body.textContent).not.toContain('Receive on');
      expect(response()).toBeUndefined();

      await act(async () => finishSubmit(settled[request.type]));

      expect(response()?.approved).toBe(true);
    }
  );
});
