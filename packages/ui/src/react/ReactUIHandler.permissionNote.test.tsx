// @vitest-environment jsdom
// A grant may carry a note: what the app says the permission is for. The grant screen shows it,
// and the grant stores the same value it showed. A revoke shows the note the permission was stored
// with. The dialog is stubbed and confirmed through its props, as in the prefund test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const grantPermissions = vi.fn();
const revokePermission = vi.fn();
let storedPermission: Record<string, unknown> | null = null;

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ grantPermissions, revokePermission, quoteSpenderPrefund: vi.fn() }) },
    handleGetCapabilitiesRequest: async () => ({}),
  };
});

vi.mock('../hooks/usePermissionRevocation', () => ({
  usePermissionRevocation: () => ({ permission: storedPermission, loading: false, problem: null }),
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

type DialogProps = { onConfirm?: () => void; note?: string; mode?: string };
let dialogProps: DialogProps = {};
vi.mock('../components/PermissionDialog', () => ({
  PermissionDialog: (props: DialogProps) => {
    dialogProps = props;
    return null;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';

/** Every handler a test opens, dismissed after it so no dialog of one test renders into the next. */
const handlers: InstanceType<typeof ReactUIHandler>[] = [];

function handler() {
  const h = new ReactUIHandler();
  handlers.push(h);
  (h as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 8453,
    paymasters: {},
  };
  return h;
}

/** Opens the grant dialog for a request carrying `note`. The answer is wrapped, so awaiting this does not wait for it. */
async function openGrant(note?: unknown) {
  const request = {
    id: 'req-note',
    type: 'wallet_grantPermissions' as const,
    timestamp: 0,
    data: {
      address: ACCOUNT,
      chainId: 8453,
      expiry: Math.floor(Date.now() / 1000) + 86_400,
      spender: SPENDER,
      permissions: { calls: [{ target: '0x3333333333333333333333333333333333333333', selector: '0xa9059cbb' }] },
      ...(note === undefined ? {} : { note }),
    },
  };
  let response: Promise<unknown> = Promise.resolve();
  await act(async () => {
    response = handler().request(request as Parameters<ReactUIHandler['request']>[0]);
    response.catch(() => undefined);
  });
  return { response };
}

const grantOptions = () => grantPermissions.mock.calls[0]?.[6] as { note?: string } | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  grantPermissions.mockReset().mockResolvedValue({ permissionId: '0xabc' });
  revokePermission.mockReset().mockResolvedValue({ success: true });
  storedPermission = null;
  dialogProps = {};
});
afterEach(async () => {
  await act(async () => handlers.splice(0).forEach((h) => h.dismiss()));
  document.body.innerHTML = '';
});

describe('ReactUIHandler and the note of a grant', () => {
  it('shows the note trimmed, as it will be stored', async () => {
    await openGrant('  Daily DCA into ETH  ');

    expect(dialogProps.note).toBe('Daily DCA into ETH');
  });

  it('grants with the note it showed', async () => {
    await openGrant('  Daily DCA into ETH  ');
    await act(async () => dialogProps.onConfirm?.());

    expect(grantPermissions).toHaveBeenCalledTimes(1);
    expect(grantOptions()?.note).toBe('Daily DCA into ETH');
  });

  it('shows no note and grants with none when the request has none', async () => {
    await openGrant();
    await act(async () => dialogProps.onConfirm?.());

    expect(dialogProps.note).toBeUndefined();
    expect(grantOptions()?.note).toBeUndefined();
  });

  it('refuses a note that breaks the rule with -32602, before anything is granted', async () => {
    const { response } = await openGrant('Daily \u202EDCA');

    // The handler answers a refusal rather than throwing; the signer throws its error to the dapp.
    await expect(response).resolves.toMatchObject({ approved: false, error: { code: -32602 } });
    // Nothing was shown: no screen, so no Confirm that could still grant.
    expect(dialogProps.onConfirm).toBeUndefined();
    expect(dialogProps.note).toBeUndefined();
    expect(grantPermissions).not.toHaveBeenCalled();
  });
});

describe('ReactUIHandler and the note of a revoke', () => {
  async function openRevoke() {
    await act(async () => {
      void handler()
        .request({
          id: 'req-revoke-note',
          type: 'wallet_revokePermissions',
          timestamp: 0,
          data: { permissionId: '0x' + 'ab'.repeat(32), address: ACCOUNT, chainId: 8453 },
        } as Parameters<ReactUIHandler['request']>[0])
        .catch(() => undefined);
    });
    await vi.waitFor(() => expect(dialogProps.mode).toBe('revoke'));
  }

  const stored = (note?: string) => ({
    permissionId: '0x' + 'ab'.repeat(32),
    account: ACCOUNT,
    spender: SPENDER,
    start: 1700000000,
    end: 2000000000,
    salt: '0x1',
    calls: [],
    spends: [],
    chainId: '0x2105',
    ...(note === undefined ? {} : { note }),
  });

  it('shows the note the permission was stored with', async () => {
    storedPermission = stored('Daily DCA into ETH');
    await openRevoke();

    expect(dialogProps.note).toBe('Daily DCA into ETH');
  });

  it('shows no note when the permission has none', async () => {
    storedPermission = stored();
    await openRevoke();

    expect(dialogProps.note).toBeUndefined();
  });

  it('shows no note rather than one that breaks the rule', async () => {
    storedPermission = stored('Daily\u200BDCA');
    await openRevoke();

    expect(dialogProps.note).toBeUndefined();
  });
});
