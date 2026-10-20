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

const WETH = '0x4200000000000000000000000000000000000006';
let wethHangs = false;
vi.mock('../utils/publicClient', () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
      if (functionName === 'isRevoked') return false;
      if (address.toLowerCase() === WETH)
        return wethHangs ? new Promise(() => undefined) : { decimals: 18, symbol: 'WETH' }[functionName];
      return { decimals: 6, symbol: 'USDC' }[functionName];
    },
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

type DialogProps = {
  onConfirm?: () => void;
  heldGrants?: unknown;
  isLoadingTokenInfo?: boolean;
  spends?: Array<{ token: string }>;
};
let dialogProps: DialogProps = {};
let loadingHistory: boolean[] = [];
vi.mock('../components/PermissionDialog', () => ({
  PermissionDialog: (props: DialogProps) => {
    dialogProps = props;
    loadingHistory.push(!!props.isLoadingTokenInfo);
    return null;
  },
}));

/** Once the request's own token info settled, it never went back to loading. */
const settledOnce = () => loadingHistory.slice(loadingHistory.indexOf(false)).every((loading) => !loading);

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

const indexed = (spender: string, allowance: string, token = USDC) => ({
  permissionId: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
  account: ACCOUNT.toLowerCase(),
  spender: spender.toLowerCase(),
  start: 1,
  end: EXPIRY,
  salt: '0x01',
  calls: [
    { target: USDC.toLowerCase(), selector: '0xa9059cbb', checker: '0x0000000000000000000000000000000000000000' },
  ],
  spends: [{ token: token.toLowerCase(), allowance, unit: 'day', multiplier: 1 }],
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
  loadingHistory = [];
  wethHangs = false;
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

  it('given the held read hangs, then Confirm is not held and the request rows stay resolved', async () => {
    getPermissions.mockReturnValue(new Promise(() => undefined));
    await openGrant();

    expect(dialogProps.heldGrants).toEqual({ status: 'loading' });
    expect(dialogProps.isLoadingTokenInfo).toBe(false);
    expect(dialogProps.spends?.[0].token).toBe('USDC');
    expect(settledOnce()).toBe(true);
  });

  it('given a held token whose metadata hangs, then its row shows the address and Confirm is not held', async () => {
    wethHangs = true;
    getPermissions.mockResolvedValue([indexed(SPENDER, '5', WETH)]);
    await openGrant();

    expect(dialogProps.heldGrants).toEqual({
      status: 'ready',
      count: 1,
      totals: [expect.objectContaining({ tokenAddress: WETH, token: '', amount: '5', decimalsUnknown: true })],
    });
    expect(dialogProps.isLoadingTokenInfo).toBe(false);
    expect(dialogProps.spends?.[0].token).toBe('USDC');
    expect(settledOnce()).toBe(true);
  });

  it('given a held token outside the request, then its row is named once its metadata lands', async () => {
    getPermissions.mockResolvedValue([indexed(SPENDER, '1000000000000000000', WETH)]);
    await openGrant();

    expect(dialogProps.heldGrants).toEqual({
      status: 'ready',
      count: 1,
      totals: [expect.objectContaining({ token: 'WETH', amount: '1' })],
    });
    expect(settledOnce()).toBe(true);
  });
});
