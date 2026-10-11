import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tenant } from './auth';
import { sessionSender } from './disconnect';
import { setTestEnv } from './testkit';

setTestEnv();
process.env.JAW_MCP_API_KEY = 'test-key';

const KEY = `0x${'11'.repeat(32)}` as Hex;
const PAYER = privateKeyToAccount(KEY).address;
const PAYMASTER = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';

const estimate = vi.fn();
const sendCalls = vi.fn();
vi.mock('@jaw.id/core', async (original) => ({
  ...(await original<object>()),
  Account: {
    fromLocalAccount: async () => ({
      address: PAYER,
      getSmartAccount: () => ({}),
      sendCalls,
      getCallStatus: async () => ({ status: 200, receipts: [{ transactionHash: '0xab' }] }),
    }),
  },
  fetchTokenQuotes: async () => [{ paymasterAddress: PAYMASTER }],
  estimateErc20PaymasterCosts: (...args: unknown[]) => estimate(...args),
}));

// What the chain holds at the payer: an EIP-7702 delegation once it has sent an op, nothing before.
const chain = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () => ({ getCode: async () => chain.code }),
}));

const tenant = { chainId: 84532, sessionAddress: PAYER, sessionKey: () => KEY } as unknown as Tenant;
const call = { to: PAYMASTER, data: '0x' } as const;

afterEach(() => {
  estimate.mockReset();
  sendCalls.mockReset();
});

describe('given the session key of a payer', () => {
  it('when a payer that has sent an op is quoted, then the paymaster estimate prices it', async () => {
    chain.code = `0xef0100${'ab'.repeat(20)}`;
    estimate.mockResolvedValue([{ tokenCost: 5_000n, tokenCostMax: 20_000n }]);
    const sender = await sessionSender(tenant);

    expect(await sender.quote([call])).toEqual({ expected: 5_000n, max: 20_000n });
    expect(sender.paymaster).toBe(PAYMASTER);
  });

  it('when a payer that never sent an op is quoted, then it reserves the first-op fee the estimate cannot price', async () => {
    chain.code = undefined;
    const sender = await sessionSender(tenant);

    expect(await sender.quote([call])).toEqual({ expected: 50_000n, max: 50_000n });
    expect(estimate).not.toHaveBeenCalled();
  });

  it.each([
    ['the bundler', 'Details: UserOperation reverted during simulation with reason: AA50 postOp reverted 0x7939f424'],
    [
      'the paymaster',
      'Details: AA50 PostOp Reverted: Insufficient balance, 0.007197 USDC required but sender has 0.001 USDC',
    ],
  ])(
    'when %s refuses the batch because the fee is over the cap, then it reports it reverted',
    async (_who, message) => {
      sendCalls.mockRejectedValue(new Error(message));
      const sender = await sessionSender(tenant);

      expect(await sender.send([call])).toEqual({ status: 'reverted' });
    }
  );

  it('when the bundler refuses the batch for another reason, then it throws so nothing counts as sent', async () => {
    sendCalls.mockRejectedValue(new Error('AA25 invalid account nonce'));
    const sender = await sessionSender(tenant);

    await expect(sender.send([call])).rejects.toThrow('AA25');
  });
});
