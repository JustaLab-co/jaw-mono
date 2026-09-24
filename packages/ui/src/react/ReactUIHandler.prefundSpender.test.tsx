// @vitest-environment jsdom
// `prefundSpender` is the capability that funds the spender's first operation
// out of the grant. It was once accepted, forwarded, typed and then dropped, so
// the spender was granted the permission and held nothing to pay with, and
// nothing reported it. Typecheck is no guard here: the argument is the seventh
// positional of `grantPermissions` and every one of them is a plain value, so
// dropping it or passing it in the wrong slot compiles.
//
// The dialog is stubbed rather than driven through its button. `canConfirm`
// gates on token info, resolved addresses and a settled gas estimate, none of
// which this is about; what is under test is what `handleConfirm` hands to the
// account.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const grantPermissions = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ grantPermissions }) },
    handleGetCapabilitiesRequest: async () => ({}),
  };
});

/** Props the wrapper hands the dialog on the last render, so `onConfirm` is reachable. */
let dialogProps: { onConfirm?: () => void } = {};
vi.mock('../components/PermissionDialog', () => ({
  PermissionDialog: (props: { onConfirm?: () => void }) => {
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
  dialogProps = {};
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler grants with the prefund capability it was asked for', () => {
  it('forwards prefundSpender: true as the seventh argument', async () => {
    await openGrant({ prefundSpender: true });
    await act(async () => dialogProps.onConfirm?.());

    expect(grantPermissions).toHaveBeenCalledTimes(1);
    expect(seventhArgOf(grantPermissions)).toEqual({ prefundSpender: true });
  });

  // A wallet does not move funds unasked, so the absence of the capability has
  // to arrive as an explicit false rather than as undefined: the option object
  // is what core reads, and a missing key there reads the same as an opt-out
  // only by accident.
  it('sends prefundSpender: false when the capability is absent', async () => {
    await openGrant();
    await act(async () => dialogProps.onConfirm?.());

    expect(seventhArgOf(grantPermissions)).toEqual({ prefundSpender: false });
  });

  it('does not let a non-boolean capability turn the prefund on', async () => {
    await openGrant({ prefundSpender: 'yes' });
    await act(async () => dialogProps.onConfirm?.());

    expect(seventhArgOf(grantPermissions)).toEqual({ prefundSpender: false });
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
