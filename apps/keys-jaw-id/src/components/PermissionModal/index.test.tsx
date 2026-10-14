// @vitest-environment jsdom
// The revoke hands the dapp what the relay answered, so a revoke the relay has
// not seen on-chain yet reaches it as `pending` instead of a plain success. The
// dialog is stubbed and confirmed through its props.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Chain } from '@jaw.id/core';

const revokePermission = vi.fn();

let dialogProps: { onConfirm?: () => void } = {};
vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    PermissionDialog: (props: { onConfirm?: () => void }) => {
      dialogProps = props;
      return null;
    },
    usePermissionRevocation: () => ({ permission: null, loading: false, problem: null }),
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
  };
});

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return { ...actual, handleGetCapabilitiesRequest: async () => ({}) };
});

vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({
    account: { revokePermission },
    isLoading: false,
    walletAddress: '0x1111111111111111111111111111111111111111',
  }),
}));

const { PermissionModal } = await import('./index');

const CHAIN = { id: 8453, rpcUrl: 'https://rpc.example' } as Chain;
const REQUEST = {
  method: 'wallet_revokePermissions' as const,
  params: [{ id: `0x${'ab'.repeat(32)}`, address: '0x1111111111111111111111111111111111111111' }],
};

let root: Root;
let container: HTMLDivElement;

/** Renders the revoke modal, confirms it, and returns what reached onSuccess. */
async function confirmRevoke() {
  const onSuccess = vi.fn();
  const onError = vi.fn();
  await act(async () => {
    root.render(
      <PermissionModal
        permissionRequest={REQUEST as never}
        chain={CHAIN}
        apiKey="test-key"
        onSuccess={onSuccess}
        onError={onError}
      />
    );
  });
  await act(async () => dialogProps.onConfirm?.());
  expect(onError).not.toHaveBeenCalled();
  return onSuccess;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  revokePermission.mockReset();
  dialogProps = {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('PermissionModal revoke', () => {
  it('hands the dapp the pending answer the relay gave', async () => {
    revokePermission.mockResolvedValue({ success: true, pending: true });

    const onSuccess = await confirmRevoke();

    expect(revokePermission).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({ success: true, pending: true });
  });

  it('hands the dapp a plain success when the relay removed it right away', async () => {
    revokePermission.mockResolvedValue({ success: true });

    const onSuccess = await confirmRevoke();

    expect(onSuccess).toHaveBeenCalledWith({ success: true });
  });

  it('tells the dapp the revoke succeeded when the relay had no row left to remove', async () => {
    revokePermission.mockResolvedValue({ success: false });

    const onSuccess = await confirmRevoke();

    expect(onSuccess).toHaveBeenCalledWith({ success: true });
  });
});
