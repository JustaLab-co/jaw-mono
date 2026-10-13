// @vitest-environment jsdom
// The revoke dialog hands the dapp what the relay answered, so a revoke the
// relay has not seen on-chain yet reaches it as `pending` instead of a plain
// success. The dialog is stubbed and confirmed through its props, as in the
// prefund test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const revokePermission = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ revokePermission }) },
    handleGetCapabilitiesRequest: async () => ({}),
  };
});

vi.mock('../hooks/usePermissionRevocation', () => ({
  usePermissionRevocation: () => ({ permission: null, loading: false, problem: null }),
}));

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

let dialogProps: { onConfirm?: () => void } = {};
vi.mock('../components/PermissionDialog', () => ({
  PermissionDialog: (props: { onConfirm?: () => void }) => {
    dialogProps = props;
    return null;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const REQUEST = {
  id: 'req-revoke',
  type: 'wallet_revokePermissions' as const,
  timestamp: 0,
  data: {
    permissionId: '0x' + 'ab'.repeat(32),
    address: '0x1111111111111111111111111111111111111111',
    chainId: 8453,
  },
};

/** Opens the revoke dialog, confirms it, and returns what the handler resolved with. */
async function confirmRevoke() {
  const handler = new ReactUIHandler();
  (handler as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 8453,
    paymasters: {},
  };
  let response: Promise<unknown> = Promise.resolve();
  await act(async () => {
    response = handler.request(REQUEST as Parameters<ReactUIHandler['request']>[0]);
  });
  await vi.waitFor(() => expect(dialogProps.onConfirm).toBeDefined());
  await act(async () => dialogProps.onConfirm?.());
  return response;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  revokePermission.mockReset();
  dialogProps = {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('ReactUIHandler revoke', () => {
  it('hands the dapp the pending answer the relay gave', async () => {
    revokePermission.mockResolvedValue({ success: true, pending: true });

    const response = await confirmRevoke();

    expect(revokePermission).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ approved: true, data: { success: true, pending: true } });
  });

  it('hands the dapp a plain success when the relay removed it right away', async () => {
    revokePermission.mockResolvedValue({ success: true });

    const response = await confirmRevoke();

    expect(response).toMatchObject({ approved: true, data: { success: true } });
    expect((response as { data: object }).data).not.toHaveProperty('pending');
  });
});
