// @vitest-environment jsdom
// A grant may name the one token its swaps may buy, in capabilities.swapDestination. The grant
// screen shows it as a checksummed address and refuses a value that is not one, as the keys popup
// does. The dialog is stubbed and read through its props, as in the note test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const grantPermissions = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ grantPermissions, quoteSpenderPrefund: vi.fn() }) },
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

// Token reads answer by address: the destination is a token named WETH, anything else is not.
const readContract = vi.fn();
vi.mock('../utils/publicClient', () => ({ getPublicClient: () => ({ readContract }) }));

type DialogProps = {
  onConfirm?: () => void;
  swapDestination?: string;
  tokenMeta?: Record<string, { symbol: string }>;
};
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
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const CALL = { target: '0x3333333333333333333333333333333333333333', selector: '0xa9059cbb' };

const handlers: InstanceType<typeof ReactUIHandler>[] = [];

/** Opens the grant dialog for a request whose capabilities carry `swapDestination`. */
async function openGrant(swapDestination?: unknown, calls = [CALL]) {
  const h = new ReactUIHandler();
  handlers.push(h);
  (h as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 8453,
    paymasters: {},
  };
  const request = {
    id: 'req-swap-destination',
    type: 'wallet_grantPermissions' as const,
    timestamp: 0,
    data: {
      address: ACCOUNT,
      chainId: 8453,
      expiry: Math.floor(Date.now() / 1000) + 86_400,
      spender: SPENDER,
      permissions: { calls },
      ...(swapDestination === undefined ? {} : { capabilities: { swapDestination } }),
    },
  };
  let response: Promise<unknown> = Promise.resolve();
  await act(async () => {
    response = h.request(request as Parameters<ReactUIHandler['request']>[0]);
    response.catch(() => undefined);
  });
  return { response };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  grantPermissions.mockReset().mockResolvedValue({ permissionId: '0xabc' });
  readContract.mockReset().mockImplementation(async ({ address, functionName }) => {
    if (address !== WETH) throw new Error('not a token');
    return functionName === 'symbol' ? 'WETH' : 18;
  });
  dialogProps = {};
});
afterEach(async () => {
  await act(async () => handlers.splice(0).forEach((h) => h.dismiss()));
  document.body.innerHTML = '';
});

describe('ReactUIHandler and the swap destination of a grant', () => {
  it('passes the swap destination to the grant screen', async () => {
    await openGrant(WETH);

    expect(dialogProps.swapDestination).toBe(WETH);
  });

  it('shows the destination checksummed, whatever case it came in', async () => {
    await openGrant(USDC.toLowerCase());

    expect(dialogProps.swapDestination).toBe(USDC);
  });

  it('reads the name of the destination token for the screen', async () => {
    await openGrant(WETH);

    await vi.waitFor(() => expect(dialogProps.tokenMeta?.[WETH]?.symbol).toBe('WETH'));
  });

  it('reads the name of the destination token when it is the only token on the grant', async () => {
    await openGrant(WETH, []);

    await vi.waitFor(() => expect(dialogProps.tokenMeta?.[WETH]?.symbol).toBe('WETH'));
  });

  it('shows no destination when the request names none', async () => {
    await openGrant();

    expect(dialogProps.onConfirm).toBeDefined();
    expect(dialogProps.swapDestination).toBeUndefined();
  });

  it('grants the same permission whether or not a destination is named', async () => {
    await openGrant(WETH);
    await act(async () => dialogProps.onConfirm?.());
    const withDestination = grantPermissions.mock.calls[0];

    grantPermissions.mockClear();
    await act(async () => handlers.splice(0).forEach((h) => h.dismiss()));
    dialogProps = {};
    await openGrant();
    await act(async () => dialogProps.onConfirm?.());

    expect(grantPermissions.mock.calls[0]).toEqual(withDestination);
  });

  it.each([['WETH'], [42], [{ address: WETH }], [''], [`${WETH}00`]])(
    'refuses %j with -32602 before anything is shown or granted',
    async (value) => {
      const { response } = await openGrant(value);

      await expect(response).resolves.toMatchObject({
        approved: false,
        error: { code: -32602, message: 'capabilities.swapDestination must be a token address' },
      });
      expect(dialogProps.onConfirm).toBeUndefined();
      expect(dialogProps.swapDestination).toBeUndefined();
      expect(grantPermissions).not.toHaveBeenCalled();
    }
  );
});
