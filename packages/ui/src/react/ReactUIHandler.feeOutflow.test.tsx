// @vitest-environment jsdom
// The fee picker offers a token only when what the batch leaves of it covers the fee. What the
// batch moves out comes from the asset preview, so both transaction wrappers have to hand it to
// the gas estimate once the preview has run, and only when the account the preview read is the
// one that pays the fee.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({}) },
    handleGetCapabilitiesRequest: async () => ({}),
  };
});

/** What the wrapper handed the gas estimate as the batch's outflow, on the last render. */
let estimatedAssetsOut: unknown = 'never called';
vi.mock('../hooks/useGasEstimation', () => ({
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
}));

const OUT = [{ address: '0x3333333333333333333333333333333333333333', diff: -5n, direction: 'out' }];
let previewSimulated = true;
vi.mock('../hooks/useAssetPreview', () => ({
  useAssetPreview: () => ({
    assetsOut: OUT,
    assetsIn: [],
    error: false,
    loading: !previewSimulated,
    simulated: previewSimulated,
    willRevert: false,
    revertCause: undefined,
  }),
}));
vi.mock('../hooks/usePermissionExecution', () => ({
  usePermissionExecution: () => ({ onBehalfOf: undefined, loading: false, problem: undefined }),
}));
vi.mock('../components/TransactionDialog', () => ({ TransactionDialog: () => null }));

const { ReactUIHandler } = await import('./ReactUIHandler');

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const calls = (capabilities?: unknown) => ({
  id: 'req-calls',
  type: 'wallet_sendCalls',
  data: { from: FROM, chainId: 8453, calls: [{ to: TO, value: '0x0' }], capabilities },
});
const tx = { id: 'req-tx', type: 'eth_sendTransaction', data: { from: FROM, chainId: 8453, to: TO, value: '0x0' } };

async function open(request: unknown) {
  const handler = new ReactUIHandler();
  (handler as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 8453,
    paymasters: {},
  };
  await act(async () => {
    void handler.request(request as Parameters<ReactUIHandler['request']>[0]).catch(() => undefined);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  estimatedAssetsOut = 'never called';
  previewSimulated = true;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler hands the batch outflow to the fee estimate', () => {
  it.each([
    ['wallet_sendCalls', calls()],
    ['eth_sendTransaction', tx],
  ])('for %s, once the preview has run', async (_name, request) => {
    await open(request);
    expect(estimatedAssetsOut).toBe(OUT);
  });

  it.each([
    ['wallet_sendCalls', calls()],
    ['eth_sendTransaction', tx],
  ])('not for %s while the preview has not run', async (_name, request) => {
    previewSimulated = false;
    await open(request);
    expect(estimatedAssetsOut).toBeUndefined();
  });

  it('not under a permission, where the preview reads the granter and another account pays the fee', async () => {
    await open(calls({ permissions: { id: `0x${'1'.repeat(64)}` } }));
    expect(estimatedAssetsOut).toBeUndefined();
  });
});
