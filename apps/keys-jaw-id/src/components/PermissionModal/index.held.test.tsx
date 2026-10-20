// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const getPermissions = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => ({
  ...(await importActual<typeof import('@jaw.id/core')>()),
  handleGetPermissionsRequest: (...args: unknown[]) => getPermissions(...args),
  handleGetCapabilitiesRequest: async () => ({}),
  getPermissionFromRelay: () => new Promise(() => undefined),
}));

vi.mock('../../../../../packages/ui/src/utils/publicClient', () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      ({ isRevoked: false, decimals: 6, symbol: 'USDC' })[functionName],
  }),
}));

type DialogProps = { heldGrants?: unknown; mode?: string; isLoadingTokenInfo?: boolean };
let dialogProps: DialogProps = {};
vi.mock('@jaw.id/ui', async (importActual) => ({
  ...(await importActual<typeof import('@jaw.id/ui')>()),
  PermissionDialog: (props: DialogProps) => {
    dialogProps = props;
    return null;
  },
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

const ACCOUNT = '0x1111111111111111111111111111111111111111';
vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({ account: null, isLoading: false, walletAddress: ACCOUNT }),
}));

const { PermissionModal } = await import('./index');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPENDER = '0x65c8f80520052212f80dFc4B4474A89b5b4bB0c7';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const EXPIRY = Math.floor(Date.now() / 1000) + 86_400;
const CHAIN = { id: 84532, rpcUrl: 'https://api.justaname.id/proxy/v1/rpc?chainId=84532&api-key=test-key' };

const indexed = (allowance: string) => ({
  permissionId: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
  account: ACCOUNT,
  spender: SPENDER.toLowerCase(),
  start: 1,
  end: EXPIRY,
  salt: '0x01',
  calls: [
    { target: USDC.toLowerCase(), selector: '0xa9059cbb', checker: '0x0000000000000000000000000000000000000000' },
  ],
  spends: [{ token: USDC.toLowerCase(), allowance, unit: 'day', multiplier: 1 }],
  chainId: '0x14a34',
});

const GRANT = {
  method: 'wallet_grantPermissions' as const,
  params: [
    {
      address: ACCOUNT,
      chainId: '0x14a34',
      spender: SPENDER,
      expiry: EXPIRY,
      permissions: {
        calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
        spends: [{ token: USDC, allowance: '1000000', unit: 'day', multiplier: 1 }],
      },
    },
  ],
};

let root: Root | null = null;

async function open(permissionRequest: unknown, chain: unknown = CHAIN) {
  const mounted = createRoot(document.createElement('div'));
  root = mounted;
  await act(async () =>
    mounted.render(
      <PermissionModal
        permissionRequest={permissionRequest as never}
        chain={chain as never}
        apiKey="test-key"
        origin="https://app.example"
      />
    )
  );
  await act(async () => undefined);
}

beforeEach(() => {
  getPermissions.mockReset();
  dialogProps = {};
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('the keys popup grant screen shows what the spender already holds', () => {
  it('given two live daily budgets to this spender, then shows them summed', async () => {
    getPermissions.mockResolvedValue([indexed('0xf4240'), indexed('500000')]);
    await open(GRANT);

    expect(getPermissions.mock.calls[0][0]).toMatchObject({ params: [{ address: ACCOUNT, chainId: '0x14a34' }] });
    expect(dialogProps.heldGrants).toEqual({
      status: 'ready',
      count: 2,
      tokensLoading: false,
      totals: [expect.objectContaining({ amount: '1.5', token: 'USDC', duration: '1 day' })],
    });
  });

  it('given a grant request with no address, then reads for the connected wallet it signs from', async () => {
    getPermissions.mockResolvedValue([indexed('0xf4240')]);
    await open({ ...GRANT, params: [{ ...GRANT.params[0], address: undefined }] });

    expect(getPermissions.mock.calls[0][0]).toMatchObject({ params: [{ address: ACCOUNT }] });
    expect(dialogProps.heldGrants).toMatchObject({ status: 'ready', count: 1 });
  });

  it('given a request naming another account, then reads for that account, not the connected one', async () => {
    const other = '0x2222222222222222222222222222222222222222';
    getPermissions.mockResolvedValue([]);
    await open({ ...GRANT, params: [{ ...GRANT.params[0], address: other }] });

    expect(getPermissions.mock.calls[0][0]).toMatchObject({ params: [{ address: other }] });
  });

  it('given no chain yet, then nothing is read rather than reporting none found', async () => {
    await open(GRANT, null);

    expect(getPermissions).not.toHaveBeenCalled();
    expect(dialogProps.heldGrants).toBeUndefined();
  });

  it('given the held read hangs, then the token info gate that holds Grant is not held by it', async () => {
    getPermissions.mockReturnValue(new Promise(() => undefined));
    await open(GRANT);

    expect(dialogProps.heldGrants).toEqual({ status: 'loading' });
    expect(dialogProps.isLoadingTokenInfo).toBe(false);
  });

  it('given the lookup fails, then the screen is told the total is unreadable', async () => {
    getPermissions.mockRejectedValue(new Error('500'));
    await open(GRANT);

    expect(dialogProps.heldGrants).toEqual({ status: 'unreadable' });
  });

  it('given a revoke request, then nothing is read and no held section is passed', async () => {
    await open({
      method: 'wallet_revokePermissions',
      params: [{ id: `0x${'ab'.repeat(32)}`, address: ACCOUNT }],
    });

    expect(dialogProps.mode).toBe('revoke');
    expect(dialogProps.heldGrants).toBeUndefined();
    expect(getPermissions).not.toHaveBeenCalled();
  });
});
