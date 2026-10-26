// @vitest-environment jsdom
// The revoke hands the dapp what the relay answered, so a revoke the relay has
// not seen on-chain yet reaches it as `pending` instead of a plain success. The
// dialog is stubbed and confirmed through its props.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Chain } from '@jaw.id/core';

const revokePermission = vi.fn();
const grantPermissions = vi.fn();

type DialogProps = { onConfirm?: () => void; calls?: Array<{ checker?: string }> };
let dialogProps: DialogProps = {};
vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    PermissionDialog: (props: DialogProps) => {
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
    account: { revokePermission, grantPermissions },
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
  grantPermissions.mockReset();
  grantPermissions.mockResolvedValue({ permissionId: `0x${'cd'.repeat(32)}` });
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

/**
 * The checker is part of what the passkey signs, and keys passes `permissionDetails.calls` to
 * `grantPermissions` unchanged, so the screen has to show the same checker or it hides part of
 * the signed permission.
 */
describe('PermissionModal grant', () => {
  const CHECKER = '0x398b9d939E7E616E03eA99601c835C920621B2ca';

  it('shows the checker it signs', async () => {
    const request = {
      method: 'wallet_grantPermissions' as const,
      params: [
        {
          expiry: Math.floor(Date.now() / 1000) + 86_400,
          spender: '0x2222222222222222222222222222222222222222',
          permissions: {
            calls: [
              {
                target: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                functionSignature: 'transfer(address,uint256)',
                checker: CHECKER,
              },
            ],
          },
        },
      ],
    };
    await act(async () => {
      root.render(
        <PermissionModal
          permissionRequest={request as never}
          chain={CHAIN}
          apiKey="test-key"
          onSuccess={vi.fn()}
          onError={vi.fn()}
        />
      );
    });
    await act(async () => dialogProps.onConfirm?.());

    expect(dialogProps.calls?.[0].checker).toBe(CHECKER);
    expect(grantPermissions).toHaveBeenCalledTimes(1);
    expect(grantPermissions.mock.calls[0][2].calls[0].checker).toBe(CHECKER);
  });
});
