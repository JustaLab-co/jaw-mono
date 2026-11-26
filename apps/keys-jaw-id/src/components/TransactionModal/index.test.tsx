// @vitest-environment jsdom
// The fee picker offers a token only when what the batch leaves of it covers the fee. What the
// batch moves out comes from the asset preview, so the popup has to hand it to the gas estimate
// once the preview has run, and only when the account the preview read is the one that pays.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Chain } from '@jaw.id/core';
import type { TransactionRequestData } from './index';

/** What the modal handed the gas estimate as the batch's outflow, on the last render. */
let estimatedAssetsOut: unknown = 'never called';
const OUT = [{ address: '0x3333333333333333333333333333333333333333', diff: -5n, direction: 'out' }];
let previewSimulated = true;

vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    TransactionDialog: () => null,
    loadFeeTokenOptions: async () => [],
    usePermissionExecution: () => ({ onBehalfOf: undefined, loading: false, problem: undefined }),
    useAssetPreview: () => ({
      assetsOut: OUT,
      assetsIn: [],
      error: false,
      loading: !previewSimulated,
      simulated: previewSimulated,
      willRevert: false,
      revertCause: undefined,
    }),
    useGasEstimation: ({ assetsOut }: { assetsOut?: unknown }) => {
      estimatedAssetsOut = assetsOut;
      return {
        gasFee: '',
        gasFeeLoading: false,
        gasEstimationError: '',
        tokenEstimates: [],
        estimatingTokenCosts: false,
        selectedFeeToken: null,
        setSelectedFeeToken: () => undefined,
        isPayingWithErc20: false,
        refetch: () => undefined,
      };
    },
  };
});

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return { ...actual, handleGetCapabilitiesRequest: async () => ({}) };
});

vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({
    account: {},
    isLoading: false,
    walletAddress: '0x1111111111111111111111111111111111111111',
  }),
}));

const { TransactionModal } = await import('./index');

const CHAIN = { id: 8453, rpcUrl: 'https://rpc.example' } as Chain;
const request = (permissionId?: `0x${string}`): TransactionRequestData => ({
  method: 'wallet_sendCalls',
  transactions: [{ to: '0x2222222222222222222222222222222222222222', value: '0x0', chainId: 8453 }],
  chainId: 8453,
  from: '0x1111111111111111111111111111111111111111',
  permissionId,
});

let root: Root;

async function open(transactionRequest: TransactionRequestData) {
  await act(async () => {
    root.render(<TransactionModal transactionRequest={transactionRequest} chain={CHAIN} apiKey="test-key" />);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  estimatedAssetsOut = 'never called';
  previewSimulated = true;
});
afterEach(() => {
  act(() => root.unmount());
});

describe('TransactionModal hands the batch outflow to the fee estimate', () => {
  it('once the preview has run', async () => {
    await open(request());
    expect(estimatedAssetsOut).toBe(OUT);
  });

  it('not while the preview has not run', async () => {
    previewSimulated = false;
    await open(request());
    expect(estimatedAssetsOut).toBeUndefined();
  });

  it('not under a permission, where the preview reads the granter and another account pays the fee', async () => {
    await open(request(`0x${'1'.repeat(64)}`));
    expect(estimatedAssetsOut).toBeUndefined();
  });
});
