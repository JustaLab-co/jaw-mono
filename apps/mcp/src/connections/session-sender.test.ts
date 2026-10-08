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

const tenant = { chainId: 84532, sessionAddress: PAYER, sessionKey: () => KEY } as unknown as Tenant;
const call = { to: PAYMASTER, data: '0x' } as const;

afterEach(() => {
  estimate.mockReset();
  sendCalls.mockReset();
});

describe('given the session key of a payer', () => {
  it('when the batch is quoted, then it prices the delegation a fresh payer still needs', async () => {
    estimate.mockResolvedValue([{ tokenCost: 5_000n, tokenCostMax: 20_000n }]);
    const sender = await sessionSender(tenant);

    expect(await sender.quote([call])).toEqual({ expected: 5_000n, max: 20_000n });
    expect(sender.paymaster).toBe(PAYMASTER);
    expect(estimate.mock.calls[0][5].localAccount.address).toBe(PAYER);
  });

  it('when the bundler refuses the batch because the fee is over the cap, then it reports it reverted', async () => {
    sendCalls.mockRejectedValue(
      new Error('Details: UserOperation reverted during simulation with reason: AA50 postOp reverted 0x7939f424')
    );
    const sender = await sessionSender(tenant);

    expect(await sender.send([call])).toEqual({ status: 'reverted' });
  });

  it('when the bundler refuses the batch for another reason, then it throws so nothing counts as sent', async () => {
    sendCalls.mockRejectedValue(new Error('AA25 invalid account nonce'));
    const sender = await sessionSender(tenant);

    await expect(sender.send([call])).rejects.toThrow('AA25');
  });
});
