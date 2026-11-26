// @vitest-environment jsdom
// The grant screen /cli-bridge renders for a same-chain swap grant from jaw-agent, with the real
// dialog: the owner reads the token the swaps may buy. The request is the bridge fixture
// rpc-request-mcp-grant-swap-destination.json.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ grantPermissions: vi.fn(), quoteSpenderPrefund: vi.fn().mockResolvedValue(null) }) },
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
vi.mock('../utils/publicClient', () => ({
  getPublicClient: () => ({ readContract: vi.fn().mockRejectedValue(new Error('offline')) }),
}));
vi.mock('../components/ShellDialog', () => ({
  ShellDialog: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock('../hooks/useAddressIdentities', () => ({ useAddressIdentities: () => ({}) }));

const { ReactUIHandler } = await import('./ReactUIHandler');

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SWAP = 'exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))';

const fixtureParams = {
  spender: '0x3333333333333333333333333333333333333333',
  expiry: Math.floor(Date.now() / 1000) + 86_400,
  chainId: '0x2105',
  permissions: {
    calls: [
      { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', functionSignature: 'approve(address,uint256)' },
      { target: '0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F', functionSignature: SWAP },
      { target: '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D', functionSignature: SWAP },
      { target: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5', functionSignature: SWAP },
      { target: '0x2626664c2603336E57B271c5C0b26F421741e481', functionSignature: 'multicall(uint256,bytes[])' },
    ],
    spends: [
      { token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', allowance: '10500000', unit: 'day', multiplier: 1 },
    ],
  },
  capabilities: { prefundSpender: true, swapDestination: '0x4200000000000000000000000000000000000006' },
};

const handlers: InstanceType<typeof ReactUIHandler>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(async () => {
  await act(async () => handlers.splice(0).forEach((h) => h.dismiss()));
  document.body.innerHTML = '';
});

describe('the /cli-bridge grant screen for a swap grant', () => {
  it('names the token the swaps may buy', async () => {
    const h = new ReactUIHandler();
    handlers.push(h);
    (h as unknown as { config: Record<string, unknown> }).config = { apiKey: 'test-key', paymasters: {} };
    await act(async () => {
      void h
        .request({
          id: 'req-swap-screen',
          type: 'wallet_grantPermissions',
          timestamp: 0,
          data: { ...fixtureParams, address: ACCOUNT, chainId: 8453 },
        } as Parameters<ReactUIHandler['request']>[0])
        .catch(() => undefined);
    });

    await vi.waitFor(() => expect(document.body.textContent).toContain('Swaps only into WETH (0x4200'));
  });
});
