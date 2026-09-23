/**
 * What a top-up is allowed to send through the session permission.
 *
 * The permission manager caps the pull on chain, but the amount is chosen here
 * and every send costs the payer a paymaster fee, so the shape of what goes out
 * is worth holding to: one USDC `transfer` to the payer, at least the shortfall,
 * never more than what is left of the tightest cap, and nothing at all for a
 * payment on another chain or in another token.
 */
import fc from 'fast-check';
import { decodeFunctionData, erc20Abi } from 'viem';
import { describe, it, expect } from 'vitest';

import { USDC_BY_NETWORK } from './asset-registry.js';
import { ensurePayerFunds, type TopUpExecutor } from './topup.js';
import type { X402PaymentRequirement } from './types.js';

fc.configureGlobal({ seed: 0x70b, numRuns: 300 });

const PAYER = '0x1111111111111111111111111111111111111111' as const;
const OTHER_TOKEN = '0x2222222222222222222222222222222222222222' as const;
const NETWORKS = [...Object.keys(USDC_BY_NETWORK), 'eip155:1'];

const scenario = fc
  .record({
    network: fc.constantFrom(...NETWORKS),
    scheme: fc.constantFrom('exact', 'upto') as fc.Arbitrary<'exact' | 'upto'>,
    ownToken: fc.boolean(),
    price: fc.bigInt({ min: 0n, max: 5_000_000n }),
    balance: fc.bigInt({ min: 0n, max: 5_000_000n }),
    permit2Allowance: fc.constantFrom(0n, 10n ** 30n),
    maxTopUp: fc.option(fc.bigInt({ min: 0n, max: 10_000_000n }), { nil: undefined, freq: 2 }),
    floatTarget: fc.option(fc.bigInt({ min: 0n, max: 10_000_000n }), { nil: undefined, freq: 2 }),
    sessionChainId: fc.option(fc.constantFrom(8453, 84532, 137), { nil: undefined, freq: 3 }),
  })
  .map((s) => {
    const usdc = USDC_BY_NETWORK[s.network] as (typeof USDC_BY_NETWORK)[string] | undefined;
    return { ...s, usdc, asset: s.ownToken && usdc ? usdc.address : OTHER_TOKEN };
  });

function recordingExecutor() {
  const sends: unknown[] = [];
  const approvals: string[] = [];
  const executor: TopUpExecutor = {
    async request(method, params) {
      if (method === 'wallet_sendCalls') {
        sends.push(params);
        return { id: '0xbatch' };
      }
      if (method === 'wallet_getCallsStatus') return { status: 200 };
      throw new Error(`unexpected ${method}`);
    },
    async approvePermit2(token) {
      approvals.push(token);
      return '0xapproval';
    },
  };
  return { executor, sends, approvals };
}

describe('topping up the payer', () => {
  it('sends at most one USDC transfer to the payer, sized between the shortfall and the cap', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { executor, sends, approvals } = recordingExecutor();
        const requirement = {
          scheme: s.scheme,
          network: s.network,
          amount: String(s.price),
          asset: s.asset,
          payTo: OTHER_TOKEN,
        } as X402PaymentRequirement;

        await ensurePayerFunds(requirement, PAYER, executor, {
          balanceReader: async () => s.balance,
          allowanceReader: async () => s.permit2Allowance,
          maxTopUp: s.maxTopUp,
          floatTarget: s.floatTarget,
          sessionChainId: s.sessionChainId,
          pollMs: 0,
          sleep: async () => undefined,
        });

        for (const token of approvals) expect(token).toBe(s.usdc?.address);

        const otherChain = s.sessionChainId !== undefined && s.sessionChainId !== s.usdc?.chainId;
        const covered = s.balance >= s.price;
        if (!s.usdc || s.asset !== s.usdc.address || otherChain || (covered && s.scheme === 'exact')) {
          expect(sends).toEqual([]);
          expect(approvals).toEqual([]);
          return;
        }

        expect(sends.length).toBeLessThanOrEqual(1);
        if (sends.length === 0) return;
        const [{ calls }] = sends[0] as [{ calls: Array<{ to: string; data: `0x${string}` }> }];
        expect(calls).toHaveLength(1);
        expect(calls[0].to).toBe(s.usdc.address);
        const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
        expect(functionName).toBe('transfer');
        const [to, amount] = args as [string, bigint];
        expect(to).toBe(PAYER);
        expect(amount).toBeGreaterThanOrEqual(s.price - s.balance);
        if (s.maxTopUp !== undefined) expect(amount).toBeLessThanOrEqual(s.maxTopUp);
      })
    );
  });
});
