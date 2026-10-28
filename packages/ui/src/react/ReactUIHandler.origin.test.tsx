// @vitest-environment jsdom
// The transaction screen names who is asking from the page the request came from. Both wrappers
// (wallet_sendCalls and eth_sendTransaction) have to hand `origin` to the dialog, or the header
// disappears for one of the two entry points.
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

vi.mock('../hooks/useGasEstimation', () => ({
  useGasEstimation: () => ({
    gasFee: '',
    gasFeeLoading: false,
    gasEstimationError: '',
    tokenEstimates: [],
    estimatingTokenCosts: false,
    selectedFeeToken: null,
    setSelectedFeeToken: () => undefined,
    isPayingWithErc20: false,
    refetch: () => undefined,
  }),
}));
vi.mock('../hooks/useAssetPreview', () => ({
  useAssetPreview: () => ({ assetsOut: [], assetsIn: [], error: false, willRevert: false, revertCause: undefined }),
}));
vi.mock('../hooks/usePermissionExecution', () => ({
  usePermissionExecution: () => ({ onBehalfOf: undefined, loading: false, problem: undefined }),
}));

type DialogProps = { origin?: string; originLabel?: string; appName?: string; capabilities?: unknown };
let dialogProps: DialogProps = {};
vi.mock('../components/TransactionDialog', () => ({
  TransactionDialog: (props: DialogProps) => {
    dialogProps = props;
    return null;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';

async function open(request: unknown, options?: { originLabel?: string }) {
  const handler = new ReactUIHandler(options);
  (handler as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 8453,
    paymasters: {},
    appName: 'Test app',
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
  dialogProps = {};
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler passes the page origin to the transaction dialog', () => {
  it('for wallet_sendCalls', async () => {
    await open({
      id: 'req-calls',
      type: 'wallet_sendCalls',
      data: { from: FROM, chainId: 8453, calls: [{ to: TO, value: '0x1' }] },
    });
    expect(dialogProps.origin).toBe(window.location.origin);
    expect(dialogProps.appName).toBe('Test app');
  });

  it('for eth_sendTransaction', async () => {
    await open({
      id: 'req-tx',
      type: 'eth_sendTransaction',
      data: { from: FROM, chainId: 8453, to: TO, value: '0x1' },
    });
    expect(dialogProps.origin).toBe(window.location.origin);
    expect(dialogProps.appName).toBe('Test app');
  });
});

describe('ReactUIHandler originLabel option', () => {
  const calls = {
    id: 'req-calls',
    type: 'wallet_sendCalls',
    data: { from: FROM, chainId: 8453, calls: [{ to: TO, value: '0x1' }] },
  };
  const tx = { id: 'req-tx', type: 'eth_sendTransaction', data: { from: FROM, chainId: 8453, to: TO, value: '0x1' } };

  it.each([
    ['wallet_sendCalls', calls],
    ['eth_sendTransaction', tx],
  ])('hands the label to the dialog for %s', async (_name, request) => {
    await open(request, { originLabel: 'via JAW bridge' });
    expect(dialogProps.originLabel).toBe('via JAW bridge');
    expect(dialogProps.origin).toBe(window.location.origin);
  });

  it('leaves the label unset by default', async () => {
    await open(calls);
    expect(dialogProps.originLabel).toBeUndefined();
  });
});

describe('ReactUIHandler passes the request capabilities to the transaction dialog', () => {
  it('for wallet_sendCalls, so the Relay order reaches the screen', async () => {
    const capabilities = { jawRelayOrder: { optional: true, orderData: { version: 'v1' } } };
    await open({
      id: 'req-calls',
      type: 'wallet_sendCalls',
      data: { from: FROM, chainId: 8453, calls: [{ to: TO, value: '0x1' }], capabilities },
    });
    expect(dialogProps.capabilities).toEqual(capabilities);
  });
});
