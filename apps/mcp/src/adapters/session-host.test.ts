import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from '@/connections/testkit';

const caps = vi.hoisted(() => ({ answer: undefined as unknown, fail: false }));
const bridgeOptions = vi.hoisted(() => ({ last: undefined as { paymasterContext?: unknown } | undefined }));

vi.mock('@jaw.id/core', async (original) => ({
  ...(await original<object>()),
  handleGetCapabilitiesRequest: async () => {
    if (caps.fail) throw new Error('proxy down');
    return caps.answer;
  },
}));
vi.mock('@jaw.id/agent', async (original) => ({
  ...(await original<object>()),
  SessionBridge: class {
    constructor(options: { paymasterContext?: unknown }) {
      bridgeOptions.last = options;
    }
  },
}));

setTestEnv();
process.env.JAW_MCP_API_KEY = 'key';
const { agentLogger, feeTokenOf, sessionBridge } = await import('./session-host');

describe('agentLogger', () => {
  it.each([
    'HTTP request failed.\n\nURL: https://base-sepolia.g.alchemy.com/v2/PROVIDER-KEY\nRequest body: {}',
    'paymaster refused: https://api.justaname.id/proxy/v1/rpc/erc20-paymaster?chainId=84532&api-key=PROVIDER-KEY',
    'socket closed: wss://rpc.example/ws/PROVIDER-KEY',
  ])('never writes a url, and so no key inside one, to the log: %j', (message) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      agentLogger.warn(message);
      const line = String(out.mock.calls[0][0]);
      expect(line).not.toContain('PROVIDER-KEY');
      expect(line).toContain('<url>');
    } finally {
      out.mockRestore();
    }
  });
});

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const grantSpending = (...tokens: string[]) =>
  ({
    chainId: 84532,
    permission: { spends: tokens.map((token) => ({ token, allowance: '1', unit: 'day', multiplier: 1 })) },
  }) as unknown as Parameters<typeof feeTokenOf>[0];

const accepting = (...tokens: string[]) => ({
  '0x14a34': { feeToken: { supported: true, tokens: tokens.map((address) => ({ address, feeToken: true })) } },
});

describe('feeTokenOf', () => {
  beforeEach(() => {
    caps.fail = false;
    caps.answer = accepting(WETH, USDC);
  });

  it('given a grant spending WETH and USDC, when the paymaster takes WETH, then the fee is paid in WETH', async () => {
    expect(await feeTokenOf(grantSpending(WETH, USDC))).toBe(WETH);
  });

  it('given a native spend first, then the first ERC-20 spend is the fee token', async () => {
    expect(await feeTokenOf(grantSpending(NATIVE, WETH))).toBe(WETH);
  });

  it('given a grant with no ERC-20 spend, then there is no fee token', async () => {
    expect(await feeTokenOf(grantSpending())).toBeUndefined();
    expect(await feeTokenOf(grantSpending(NATIVE))).toBeUndefined();
  });

  it('given a spend token the paymaster does not take, then there is no fee token', async () => {
    caps.answer = accepting(USDC);
    expect(await feeTokenOf(grantSpending(WETH))).toBeUndefined();
  });

  it('given the capabilities cannot be read, then there is no fee token', async () => {
    caps.fail = true;
    expect(await feeTokenOf(grantSpending(WETH))).toBeUndefined();
  });
});

describe('sessionBridge', () => {
  const tenant = { sessionKey: () => '0x' } as unknown as Parameters<typeof sessionBridge>[0];
  const grant = {
    ...grantSpending(WETH),
    account: WETH,
    spender: WETH,
    permissionId: '0x1',
    expiresAt: new Date(),
    createdAt: new Date(),
  };

  it('given a fee token, then the session pays its fee in it', () => {
    sessionBridge(tenant, grant as never, WETH);
    expect(bridgeOptions.last?.paymasterContext).toEqual({ token: WETH });
  });

  it('given no fee token, then the context is left to the default', () => {
    sessionBridge(tenant, grant as never);
    expect(bridgeOptions.last?.paymasterContext).toBeUndefined();
  });
});
