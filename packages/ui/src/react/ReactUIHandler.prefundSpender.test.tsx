// @vitest-environment jsdom
// `prefundSpender` is the capability that funds the spender's first operation
// out of the grant. The wallet quotes the transfer before the screen renders,
// shows it, estimates the fee with it in, and hands exactly that transfer to
// `grantPermissions`. Typecheck is no guard on the last step: the option is the
// seventh positional of `grantPermissions` and every one of them is a plain
// value, so dropping it or passing it in the wrong slot compiles.
//
// The dialog is stubbed rather than driven through its button. `canConfirm`
// gates on token info, resolved addresses and a settled gas estimate, none of
// which this is about; what is under test is what the wrapper shows and what
// `handleConfirm` hands to the account.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const grantPermissions = vi.fn();
const quoteSpenderPrefund = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ grantPermissions, quoteSpenderPrefund }) },
    handleGetCapabilitiesRequest: async () => ({}),
  };
});

/** What the wrapper asked to be estimated, on the last render. */
let estimatedCalls: Array<{ to: string; data?: string }> = [];
vi.mock('../hooks/useGasEstimation', () => ({
  useGasEstimation: ({ transactionCalls }: { transactionCalls: Array<{ to: string; data?: string }> }) => {
    estimatedCalls = transactionCalls;
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

type DialogProps = {
  onConfirm?: () => void;
  prefund?: { kind: string } | null;
  prefundLoading?: boolean;
};
/** Props the wrapper hands the dialog on the last render, so `onConfirm` is reachable. */
let dialogProps: DialogProps = {};
vi.mock('../components/PermissionDialog', () => ({
  PermissionDialog: (props: DialogProps) => {
    dialogProps = props;
    return null;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const REQUEST = {
  id: 'req-prefund',
  type: 'wallet_grantPermissions' as const,
  data: {
    address: '0x1111111111111111111111111111111111111111',
    chainId: 8453,
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    spender: '0x2222222222222222222222222222222222222222',
    permissions: {
      spends: [
        {
          token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          allowance: '1000000',
          unit: 'day' as const,
          multiplier: 1,
        },
      ],
    },
  },
};

/** Open the grant dialog and settle the wrapper's mount effects. */
async function openGrant(capabilities?: Record<string, unknown>) {
  const handler = new ReactUIHandler();
  (handler as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 8453,
    paymasters: {},
  };
  const request = { ...REQUEST, data: { ...REQUEST.data, capabilities } };
  await act(async () => {
    void handler.request(request as Parameters<ReactUIHandler['request']>[0]).catch(() => undefined);
  });
  return handler;
}

const seventhArgOf = (mock: typeof grantPermissions) => mock.mock.calls[0]?.[6];

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PREFUND = { token: TOKEN, spender: REQUEST.data.spender, amount: 6_000n };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no matchMedia, and the handler asks it which presentation to use
  // before it renders anything at all.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  grantPermissions.mockReset();
  grantPermissions.mockResolvedValue({ permissionId: '0xabc' });
  quoteSpenderPrefund.mockReset();
  quoteSpenderPrefund.mockResolvedValue({ kind: 'transfer', ...PREFUND });
  dialogProps = {};
  estimatedCalls = [];
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler shows the prefund it was asked for, then sends exactly that', () => {
  it('quotes the transfer for the spender and account the request names', async () => {
    await openGrant({ prefundSpender: true });

    expect(quoteSpenderPrefund).toHaveBeenCalledTimes(1);
    const [spender, permissions, address] = quoteSpenderPrefund.mock.calls[0] ?? [];
    expect(spender).toBe(REQUEST.data.spender);
    expect(permissions).toMatchObject({ spends: REQUEST.data.permissions.spends });
    expect(address).toBe(REQUEST.data.address);
  });

  it('shows the transfer on the screen once it is quoted', async () => {
    await openGrant({ prefundSpender: true });

    expect(dialogProps.prefundLoading).toBe(false);
    expect(dialogProps.prefund).toMatchObject({ kind: 'transfer' });
  });

  // The transfer is part of what the transaction costs, so an estimate without
  // it approves a batch one transfer short of the one that goes out.
  it('estimates the fee with the transfer in the batch', async () => {
    await openGrant({ prefundSpender: true });

    expect(estimatedCalls).toHaveLength(2);
    expect(estimatedCalls[0].to).toBe(TOKEN);
  });

  it('hands the quoted transfer to the grant as the seventh argument', async () => {
    await openGrant({ prefundSpender: true });
    await act(async () => dialogProps.onConfirm?.());

    expect(grantPermissions).toHaveBeenCalledTimes(1);
    expect(seventhArgOf(grantPermissions)).toEqual({ prefund: PREFUND });
  });

  // A wallet does not move funds unasked.
  it('neither quotes nor sends a prefund when the capability is absent', async () => {
    await openGrant();
    await act(async () => dialogProps.onConfirm?.());

    expect(quoteSpenderPrefund).not.toHaveBeenCalled();
    expect(dialogProps.prefundLoading).toBe(false);
    expect(dialogProps.prefund).toBeNull();
    expect(estimatedCalls).toHaveLength(1);
    expect(seventhArgOf(grantPermissions)).toBeUndefined();
  });

  it('does not let a non-boolean capability turn the prefund on', async () => {
    await openGrant({ prefundSpender: 'yes' });
    await act(async () => dialogProps.onConfirm?.());

    expect(quoteSpenderPrefund).not.toHaveBeenCalled();
    expect(seventhArgOf(grantPermissions)).toBeUndefined();
  });

  // The decline is shown, since it is the one a person can act on, and nothing
  // is sent.
  it('shows a limit too small to fund the spender and grants without a transfer', async () => {
    quoteSpenderPrefund.mockResolvedValue({
      kind: 'below-one-operation',
      token: TOKEN,
      allowance: 1_000_000n,
      operationCost: 6_000_000n,
    });
    await openGrant({ prefundSpender: true });
    await act(async () => dialogProps.onConfirm?.());

    expect(dialogProps.prefund).toMatchObject({ kind: 'below-one-operation' });
    expect(estimatedCalls).toHaveLength(1);
    expect(seventhArgOf(grantPermissions)).toBeUndefined();
  });

  // The grant is what the user came to do; a quote that fails is not a reason
  // to hold it, and with nothing shown nothing is sent.
  it('settles to no prefund when the quote fails', async () => {
    quoteSpenderPrefund.mockRejectedValue(new Error('rpc down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await openGrant({ prefundSpender: true });
    await act(async () => dialogProps.onConfirm?.());

    expect(dialogProps.prefundLoading).toBe(false);
    expect(dialogProps.prefund).toBeNull();
    expect(seventhArgOf(grantPermissions)).toBeUndefined();
  });

  // The six positionals before it are what make the seventh reachable at all:
  // slide any one of them and the option object lands in `address`.
  it('keeps the six positionals before it in place', async () => {
    await openGrant({ prefundSpender: true });
    await act(async () => dialogProps.onConfirm?.());

    const [expiry, spender, permissions, , , address] = grantPermissions.mock.calls[0] ?? [];
    expect(expiry).toBe(REQUEST.data.expiry);
    expect(spender).toBe(REQUEST.data.spender);
    expect(permissions).toMatchObject({ spends: REQUEST.data.permissions.spends });
    expect(address).toBe(REQUEST.data.address);
  });
});
