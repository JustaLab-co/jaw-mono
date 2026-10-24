// @vitest-environment jsdom
// Add funds must not end a request whose signed submission is still in flight:
// the caller would see 4001, retry after funding, and send twice.
//
// The dialogs are stubbed with buttons that are never disabled, standing in for
// the render where the disabled gates have not committed yet.
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

const pending = () => new Promise(() => undefined);
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

vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({ account: signer, isLoading: false, walletAddress: ALICE }),
}));
vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return { ...actual, handleGetCapabilitiesRequest: async () => ({}) };
});
vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    TransactionDialog: StubDialog,
    PermissionDialog: StubDialog,
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
    usePermissionExecution: () => ({ onBehalfOf: undefined, loading: false, problem: null }),
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

const txData = (method: TransactionRequestData['method']): TransactionRequestData => ({
  method,
  transactions: [{ to: BOB, value: '0x1', chainId: CHAIN }],
  chainId: CHAIN,
  from: ALICE,
});

type Case = { type: SDKRequestType; params: unknown[]; tx: TransactionRequestData | null };
const cases: Record<string, Case> = {
  wallet_sendCalls: { type: SDKRequestType.SEND_TRANSACTION, params: [], tx: txData('wallet_sendCalls') },
  eth_sendTransaction: { type: SDKRequestType.SEND_TRANSACTION, params: [], tx: txData('eth_sendTransaction') },
  wallet_grantPermissions: {
    type: SDKRequestType.GRANT_PERMISSIONS,
    params: [
      {
        address: ALICE,
        chainId: CHAIN,
        expiry: 2_000_000_000,
        spender: BOB,
        permissions: { calls: [{ target: BOB, selector: '0xa9059cbb' }] },
      },
    ],
    tx: null,
  },
  wallet_revokePermissions: {
    type: SDKRequestType.REVOKE_PERMISSIONS,
    params: [{ id: '0x01', address: ALICE }],
    tx: null,
  },
};

let root: Root | undefined;

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
  await act(async () => {
    mounted.render(
      <RequestModals
        pendingRequest={pendingRequest}
        communicator={{ requestClose: () => undefined } as unknown as PopupCommunicator}
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
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return onReject;
}

const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = (label: string) => act(async () => buttonNamed(label)?.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a request with its submission in flight', () => {
  it.each(Object.entries(cases))(
    'Given %s submitting, When the user taps "Add funds", Then it stays on the request, unsettled',
    async (_, request) => {
      const onReject = await render(request);
      await click('Confirm');
      const submits = [signer.sendCalls, signer.sendTransaction, signer.grantPermissions, signer.revokePermission];
      expect(submits.filter((fn) => fn.mock.calls.length > 0)).toHaveLength(1);
      await click('Add funds');

      expect(buttonNamed('Confirm')).toBeDefined();
      expect(document.body.textContent).not.toContain('Receive on');
      expect(onReject).not.toHaveBeenCalled();
    }
  );
});
