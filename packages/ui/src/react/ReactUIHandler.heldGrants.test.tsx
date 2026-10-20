// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const grantPermissions = vi.fn();
const getPermissions = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ grantPermissions }) },
    handleGetCapabilitiesRequest: async () => ({}),
    handleGetPermissionsRequest: (...args: unknown[]) => getPermissions(...args),
  };
});

vi.mock('../utils/publicClient', () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      ({ decimals: 6, symbol: 'USDC', isRevoked: false })[functionName],
  }),
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

type DialogProps = { onConfirm?: () => void; heldGrants?: unknown };
let dialogProps: DialogProps = {};
vi.mock('../components/PermissionDialog', () => ({
  PermissionDialog: (props: DialogProps) => {
    dialogProps = props;
    return null;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x65c8f80520052212f80dFc4B4474A89b5b4bB0c7';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const EXPIRY = Math.floor(Date.now() / 1000) + 86_400;

const REQUEST = {
  id: 'req-held',
  type: 'wallet_grantPermissions' as const,
  data: {
    address: ACCOUNT,
    chainId: 84532,
    expiry: EXPIRY,
    spender: SPENDER,
    permissions: {
      calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
      spends: [{ token: USDC, allowance: '1000000', unit: 'day' as const, multiplier: 1 }],
    },
  },
};

const indexed = (spender: string, allowance: string) => ({
  permissionId: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
  account: ACCOUNT.toLowerCase(),
  spender: spender.toLowerCase(),
  start: 1,
  end: EXPIRY,
  salt: '0x01',
  calls: [
    { target: USDC.toLowerCase(), selector: '0xa9059cbb', checker: '0x0000000000000000000000000000000000000000' },
  ],
  spends: [{ token: USDC.toLowerCase(), allowance, unit: 'day', multiplier: 1 }],
  chainId: '0x14a34',
});

async function openGrant() {
  const handler = new ReactUIHandler();
  (handler as unknown as { config: Record<string, unknown> }).config = { apiKey: 'test-key', paymasters: {} };
  await act(async () => {
    void handler.request(REQUEST as Parameters<ReactUIHandler['request']>[0]).catch(() => undefined);
  });
  await act(async () => undefined);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  grantPermissions.mockReset();
  grantPermissions.mockResolvedValue({ permissionId: '0xabc' });
  getPermissions.mockReset();
  dialogProps = {};
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler shows what the spender already holds next to the grant', () => {
  it('given two live daily budgets to this spender, then shows them summed in USDC', async () => {
    getPermissions.mockResolvedValue([
      indexed(SPENDER, '0xf4240'),
      indexed(SPENDER, '500000'),
      indexed('0x3333333333333333333333333333333333333333', '9000000'),
    ]);
    await openGrant();

    expect(getPermissions.mock.calls[0][0]).toMatchObject({ params: [{ address: ACCOUNT, chainId: '0x14a34' }] });
    expect(dialogProps.heldGrants).toEqual({
      status: 'ready',
      count: 2,
      totals: [expect.objectContaining({ amount: '1.5', token: 'USDC', duration: '1 day' })],
    });
  });

  it('given the lookup fails, then the screen is told the total is unreadable', async () => {
    getPermissions.mockRejectedValue(new Error('500'));
    await openGrant();

    expect(dialogProps.heldGrants).toEqual({ status: 'unreadable' });
  });

  it('given held grants on screen, when approved, then grants exactly the request', async () => {
    getPermissions.mockResolvedValue([indexed(SPENDER, '0xf4240')]);
    await openGrant();
    await act(async () => dialogProps.onConfirm?.());

    expect(grantPermissions).toHaveBeenCalledTimes(1);
    const [expiry, spender, detail] = grantPermissions.mock.calls[0];
    expect([expiry, spender, detail]).toEqual([
      EXPIRY,
      SPENDER,
      { spends: REQUEST.data.permissions.spends, calls: REQUEST.data.permissions.calls },
    ]);
  });
});
