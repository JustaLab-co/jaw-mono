import { describe, expect, test, vi } from 'vitest';
import { decodeFunctionData, erc20Abi } from 'viem';
import { ensurePayerFunds, type TopUpExecutor } from './topup.js';
import type { BalanceReader } from './balance.js';
import type { X402PaymentRequirement } from './types.js';

const PAYER = '0x1111111111111111111111111111111111111111' as const;
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const requirement = (amount = '1000000'): X402PaymentRequirement =>
  ({
    scheme: 'exact',
    network: 'eip155:84532',
    amount,
    asset: BASE_SEPOLIA_USDC,
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
  }) as X402PaymentRequirement;

function fakeExecutor(overrides?: {
  sendCalls?: (params: unknown) => Promise<unknown>;
  status?: () => Promise<unknown>;
}): { executor: TopUpExecutor; requests: Array<{ method: string; params: unknown }> } {
  const requests: Array<{ method: string; params: unknown }> = [];
  const executor: TopUpExecutor = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'wallet_sendCalls') {
        // Real bridge shape: Account.sendCalls resolves to { id, chainId }.
        return overrides?.sendCalls ? overrides.sendCalls(params) : { id: '0xbatch1', chainId: 84532 };
      }
      if (method === 'wallet_getCallsStatus') {
        return overrides?.status ? overrides.status() : { status: 200 };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { executor, requests };
}

/**
 * A payer whose balance rises by what a refill transferred to it, the way a
 * chain would.
 *
 * A constant reader models a transfer that moves nothing, which is the one thing
 * a refill is not. It was enough while the funder only decided how much to pull;
 * it is not enough now that the funder reads the balance back to decide whether
 * the payment can be signed at all.
 */
function payerHolding(initial: bigint) {
  let balance = initial;
  return {
    balanceReader: async () => balance,
    /**
     * Apply the `transfer(payer, amount)` calls a `wallet_sendCalls` carried.
     * Only the ones addressed to the payer: a refill sent to the wrong address
     * moves the user's USDC and leaves the payer as empty as it was, and a
     * harness that credits it anyway cannot tell those two apart.
     */
    settle(params: unknown) {
      const batch = (params as [{ calls?: Array<{ data: `0x${string}` }> }])[0];
      for (const call of batch?.calls ?? []) {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
        if (decoded.functionName !== 'transfer') continue;
        const [to, value] = decoded.args;
        if (to.toLowerCase() === PAYER.toLowerCase()) balance += value;
      }
    },
  };
}

/** `fakeExecutor` wired to a payer that actually receives what it is sent. */
function fakeChain(
  initial: bigint,
  overrides?: Parameters<typeof fakeExecutor>[0]
): ReturnType<typeof fakeExecutor> & { balanceReader: () => Promise<bigint> } {
  const payer = payerHolding(initial);
  const wired = fakeExecutor({
    ...overrides,
    // Settled only once the send succeeds. A `sendCalls` override that throws is
    // a transfer that reverted, and crediting the payer first would make the one
    // case the post-refill read must not be fooled by, nothing moved, the one
    // case this harness cannot express.
    sendCalls: async (params) => {
      const sent = overrides?.sendCalls ? await overrides.sendCalls(params) : { id: '0xbatch1', chainId: 84532 };
      payer.settle(params);
      return sent;
    },
  });
  return { ...wired, balanceReader: payer.balanceReader };
}

const instantly = { pollMs: 0, sleep: async () => undefined };

describe('ensurePayerFunds', () => {
  test('Given the payer balance covers the price, When ensuring funds, Then nothing runs on-chain', async () => {
    const { executor, requests, balanceReader } = fakeChain(2_000_000n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out).toEqual({ ok: true, skipped: true });
    expect(requests).toHaveLength(0);
  });

  test('Given a shortfall, When ensuring funds, Then a permitted transfer for the shortfall plus the gas reserve runs and confirms', async () => {
    const { executor, requests, balanceReader } = fakeChain(250_000n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(out.amount).toBe('850000'); // 0.75 short + 0.10 reserve
    expect(out.batchId).toBe('0xbatch1');

    const send = requests.find((r) => r.method === 'wallet_sendCalls');
    const call = (send?.params as Array<{ calls: Array<{ to: string; data: `0x${string}` }> }>)[0].calls[0];
    expect(call.to.toLowerCase()).toBe(BASE_SEPOLIA_USDC.toLowerCase());
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([PAYER, 850_000n]);
  });

  // The payer sends the top-up userOp itself, so the ERC-20 paymaster charges it
  // right after the transfer lands. Pulling only the shortfall would leave the
  // fee to come out of the payment, and the payment would land short.
  test('Given a refill, When it lands, Then the reserve is left behind so the next one can pay its own fee', async () => {
    const { executor, requests, balanceReader } = fakeChain(1_000_000n - 1n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader, // one base unit short
      ...instantly,
    });

    expect(out.amount).toBe('100001');

    const send = requests.find((r) => r.method === 'wallet_sendCalls');
    const call = (send?.params as Array<{ calls: Array<{ to: string; data: `0x${string}` }> }>)[0].calls[0];
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(decoded.args).toEqual([PAYER, 100_001n]);
  });

  test('Given a float target above the price, When topping up, Then the refill reaches the float (fewer hops later)', async () => {
    const { executor, balanceReader } = fakeChain(0n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      floatTarget: 5_000_000n,
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(out.amount).toBe('5100000'); // the float, plus the reserve
  });

  test('Given a float target above the session cap, When topping up, Then the refill is clamped to the session cap (blast-radius bound)', async () => {
    const { executor, balanceReader } = fakeChain(0n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      floatTarget: 100_000_000n, // 100 USDC float requested
      maxTopUp: 10_000_000n, // but the session can only ever spend 10 USDC
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(out.amount).toBe('10000000'); // clamped to the session cap, not the float
  });

  test('Given a period nearly exhausted, When the shortfall exceeds what the caps have left, Then it refuses before anything moves', async () => {
    const { executor, requests, balanceReader } = fakeChain(0n);

    const out = await ensurePayerFunds(requirement('5000000'), PAYER, executor, {
      balanceReader,
      maxTopUp: 1_000_000n, // only 1 USDC left of the granted period
      ...instantly,
    });

    // Pulling the 1 USDC that fits buys a payer that still cannot pay the 5,
    // and the period cap has been spent on it. The cap mirrors the on-chain
    // allowance, so the transfer for the full shortfall would revert anyway.
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('1000000 base units left');
    expect(requests).toHaveLength(0);
  });

  test('Given a cap that covers the shortfall but not the fee on top of it, When topping up, Then it refuses rather than funding a payment that cannot be signed', async () => {
    const { executor, requests, balanceReader } = fakeChain(0n);

    // 2 USDC price against 2 USDC of cap: the transfer lands, the paymaster
    // charges the payer for it, and the payment is signed for more than the
    // payer now holds.
    const out = await ensurePayerFunds(requirement('2000000'), PAYER, executor, {
      balanceReader,
      maxTopUp: 2_000_000n,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    // The figure the message names is the shortfall plus headroom for the fee,
    // not the fee itself: naming it as the fee would send an operator to raise a
    // cap that only looked short.
    expect(out.reason).toContain('2010000 topped up: 2000000 short, plus 10000 of headroom');
    expect(requests).toHaveLength(0);
  });

  // The bar stays at one operation because the fee is no longer predicted: the
  // balance is read back once the refill lands. A wider bar would refuse this,
  // and every cap would end its period with an unspendable tail.
  test('Given a cap that clears the shortfall by exactly one operation, When topping up, Then the refill runs clamped to the cap', async () => {
    const { executor, balanceReader } = fakeChain(0n);

    const out = await ensurePayerFunds(requirement('2000000'), PAYER, executor, {
      balanceReader,
      maxTopUp: 2_010_000n, // the price plus exactly one operation
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(out.amount).toBe('2010000');
  });

  test('Given a cap between the price and the bar, When topping up, Then the refill runs clamped to the cap', async () => {
    const { executor, balanceReader } = fakeChain(0n);

    const out = await ensurePayerFunds(requirement('2000000'), PAYER, executor, {
      balanceReader,
      maxTopUp: 2_050_000n,
      ...instantly,
    });

    // The reserve is what the clamp cuts: the payment and room for its fee are
    // covered, the float behind them is not, and that is the right thing to
    // give up.
    expect(out.ok).toBe(true);
    expect(out.amount).toBe('2050000');
  });

  // The bar before the refill is a prediction. This is the measurement: whatever
  // the fee turned out to be, the balance says so, and a payer that cannot cover
  // the price is refused before the payment is signed rather than after it fails.
  test('Given a refill that lands short of the price, When the balance is read back, Then it refuses before signing', async () => {
    const { executor, requests } = fakeExecutor();
    let call = 0;

    const out = await ensurePayerFunds(requirement('2000000'), PAYER, executor, {
      // A chain that credits less than it was sent, which is what a fee larger
      // than the headroom looks like from here. It has to move: an unchanged
      // balance is how replica lag reads, and the funder treats it as such.
      balanceReader: async () => (++call === 1 ? 0n : 1_999_999n),
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('after the refill');
    // The transfer went out, so the trace has to reach the ledger with it.
    expect(requests.some((r) => r.method === 'wallet_sendCalls')).toBe(true);
    expect(out.amount).toBeDefined();
    expect(out.batchId).toBeDefined();
  });

  // The bundler confirmed the transfer; the balance is read through a different
  // provider. A replica a block behind still answers with the pre-refill figure,
  // and refusing on it would burn the cap the refill just drew for a payment the
  // funds are already there for.
  test('Given the node has not caught up, When the balance reads unchanged, Then it warns and pays rather than refusing', async () => {
    const { executor } = fakeExecutor();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const out = await ensurePayerFunds(requirement('2000000'), PAYER, executor, {
      balanceReader: async () => 0n,
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unchanged from before it'));
    warn.mockRestore();
  });

  test('Given the node catches up on a later poll, When the balance has moved, Then the short payer is refused', async () => {
    const { executor } = fakeExecutor();
    let call = 0;

    const out = await ensurePayerFunds(requirement('2000000'), PAYER, executor, {
      // 0 before the refill, still 0 on the first look back, then the transfer
      // and its oversized fee both land.
      balanceReader: async () => (++call <= 2 ? 0n : 1_999_999n),
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('after the refill');
  });

  test('Given the on-chain cap rejects the transfer, When topping up, Then it refuses with the on-chain reason and no payment proceeds', async () => {
    const { executor, balanceReader } = fakeChain(0n, {
      sendCalls: async () => {
        throw new Error('execution reverted: spend limit exceeded');
      },
    });

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('top-up refused on-chain');
    expect(out.reason).toContain('spend limit exceeded');
    // The revert moved nothing, and the post-refill read is only sound if the
    // harness says so: a payer credited for a transfer that reverted would hide
    // exactly the state that check exists to catch.
    expect(await balanceReader()).toBe(0n);
  });

  test('Given the transaction fails after broadcast, When polling, Then it reports the cap/revoked explanation', async () => {
    const { executor, balanceReader } = fakeChain(0n, { status: async () => ({ status: 500 }) });

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('spending cap reached, or permission expired/revoked');
    expect(out.batchId).toBe('0xbatch1');
  });

  test('Given confirmation never arrives, When the timeout passes, Then it gives up with the batch id for reconciliation', async () => {
    const { executor, balanceReader } = fakeChain(0n, { status: async () => ({ status: 100 }) });
    let t = 0;

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      now: () => (t += 60_000),
      timeoutMs: 90_000,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('not confirmed after');
    expect(out.batchId).toBe('0xbatch1');
  });

  test('Given the status read wins the deadline race, When it returns, Then no timer is left armed to hold the process open', async () => {
    // Promise.race settles but never cancels the loser. An armed deadline timer
    // outlives the top-up and keeps the event loop alive, so `jaw x402 pay`
    // would print `Paid.` and then sit there for the rest of the timeout.
    vi.useFakeTimers();
    try {
      const { executor, balanceReader } = fakeChain(0n);

      // No injected sleep here on purpose: the leaked timer is the real one the
      // default sleep arms, so injecting an instant sleep would test nothing.
      const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
        balanceReader,
        timeoutMs: 90_000,
      });

      expect(out.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Given a bridge that returns a bare string id, When topping up, Then it still confirms (shape tolerance)', async () => {
    const { executor, balanceReader } = fakeChain(0n, { sendCalls: async () => '0xbatch2' });

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(out.batchId).toBe('0xbatch2');
  });

  test('Given a bridge that returns no call id, When topping up, Then it refuses because the transfer cannot be confirmed', async () => {
    const { executor, balanceReader } = fakeChain(0n, { sendCalls: async () => ({ chainId: 84532 }) });

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('no call id');
  });

  test('Given the payment network differs from the session chain, When ensuring funds, Then it refuses instead of transferring on the wrong chain', async () => {
    const { executor, requests, balanceReader } = fakeChain(0n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      sessionChainId: 8453,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('session is on chain 8453');
    expect(out.reason).toContain('needs chain 84532');
    expect(requests).toHaveLength(0);
  });

  test('Given a requirement for a non-USDC asset, When ensuring funds, Then it defers to scheme validation instead of funding the wrong token', async () => {
    const { executor, requests, balanceReader } = fakeChain(0n);

    const out = await ensurePayerFunds(
      { ...requirement(), asset: '0x9999999999999999999999999999999999999999' } as X402PaymentRequirement,
      PAYER,
      executor,
      { balanceReader, ...instantly }
    );

    expect(out).toEqual({ ok: true, skipped: true });
    expect(requests).toHaveLength(0);
  });

  test('Given an unsupported network, When ensuring funds, Then it defers to the scheme validation (no-op)', async () => {
    const { executor, requests } = fakeExecutor();

    const out = await ensurePayerFunds(
      { ...requirement(), network: 'eip155:999999' } as X402PaymentRequirement,
      PAYER,
      executor,
      instantly
    );

    expect(out).toEqual({ ok: true, skipped: true });
    expect(requests).toHaveLength(0);
  });
});

describe('ensurePayerFunds, statuses the bridge can actually return', () => {
  it('keeps polling when the call status comes back undefined instead of throwing', async () => {
    // Account.getCallStatus is typed `CallStatusResponse | undefined` and returns
    // undefined when the in-memory store misses and the receipt lookup throws.
    // This lands after the transfer is broadcast, so a TypeError here loses the
    // ledger row that meters the period cap.
    let call = 0;
    const { executor, balanceReader } = fakeChain(0n, {
      status: () => {
        call += 1;
        return call === 1 ? undefined : { status: 200 };
      },
    });

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(call).toBe(2); // the undefined round counted as pending, not as a crash
  });

  it('reports the amount when the broadcast returns no call id', async () => {
    const { executor } = fakeExecutor({ sendCalls: () => ({ chainId: 84532 }) });

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader: async () => 250_000n,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    // Funds moved with no id to confirm them by, so the amount is the only
    // thing the audit ledger can record.
    expect(out.amount).toBeDefined();
  });
});

/**
 * `upto` settles through Permit2, which pulls the token through the canonical
 * ERC-20 allowance. Without that allowance the proxy cannot execute what the
 * payer signed, so the payment fails at settlement and the ledger reserves its
 * whole ceiling for nothing. The approval is granted once, lazily, and outside
 * the permission, which is the only place it can be sent from.
 */
describe('Permit2 approval for upto', () => {
  const uptoRequirement = (amount = '1000000') =>
    ({ ...requirement(amount), scheme: 'upto' }) as X402PaymentRequirement;

  /**
   * The allowance starts where the test says and becomes unlimited once the
   * approval is sent, which is what the chain does. A reader frozen at zero
   * would be modelling an approval that never took effect, and the funder is
   * entitled to see the one it just granted.
   */
  const approving = (allowance: bigint, overrides?: Parameters<typeof fakeExecutor>[0]) => {
    const base = fakeExecutor(overrides);
    const approved: string[] = [];
    let current = allowance;
    const executor: TopUpExecutor = {
      request: base.executor.request.bind(base.executor),
      approvePermit2: async (token: `0x${string}`) => {
        approved.push(token);
        current = 2n ** 256n - 1n;
        return '0xapproval1';
      },
    };
    return {
      executor,
      approved,
      requests: base.requests,
      opts: {
        ...instantly,
        balanceReader: async () => 10_000_000n,
        allowanceReader: async () => current,
      },
    };
  };

  test('grants the approval when the payer has none', async () => {
    const { executor, approved, opts } = approving(0n);

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, opts);

    expect(outcome.ok).toBe(true);
    expect(approved).toEqual([BASE_SEPOLIA_USDC]);
  });

  /**
   * The approval is a userOp the payer pays for out of its own USDC, and the
   * top-up is what puts USDC there. Approving first meant the first upto
   * payment of a session refused on a payer that had never been funded, which
   * is its normal state since the top-up is lazy.
   */
  test('funds the payer before asking it to pay for its own approval', async () => {
    const order: string[] = [];
    const base = fakeChain(0n);
    let allowance = 0n;
    const executor: TopUpExecutor = {
      async request(method, params) {
        order.push(method);
        return base.executor.request(method, params);
      },
      approvePermit2: async () => {
        order.push('approvePermit2');
        allowance = 2n ** 256n - 1n;
        return '0xapproval1';
      },
    };

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, {
      ...instantly,
      balanceReader: base.balanceReader,
      allowanceReader: async () => allowance,
    });

    expect(outcome.ok).toBe(true);
    expect(order[0]).toBe('wallet_sendCalls');
    expect(order.indexOf('wallet_sendCalls')).toBeLessThan(order.indexOf('approvePermit2'));
  });

  /**
   * The cap has to clear what the payment actually needs, and an approval still
   * owed is part of that. Judged against the price alone, a cap a little over
   * it passed the guard and funded a payer that still could not pay for the
   * operation it was about to send.
   */
  test('refuses a cap that covers the price but not the approval the payment still owes', async () => {
    const { executor, approved, requests, opts } = approving(0n);

    const outcome = await ensurePayerFunds(uptoRequirement('1000000'), PAYER, executor, {
      ...opts,
      balanceReader: async () => 0n,
      // Over the price, under the price plus the reserve the approval rides on.
      maxTopUp: 1_050_000n,
    });

    expect(outcome.ok).toBe(false);
    expect(approved).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  /**
   * Holding exactly the price is holding nothing to be charged with, so the
   * bar for skipping the top-up rises by the reserve whenever an approval is
   * still owed.
   */
  test('tops up a payer that holds the price and nothing to pay the approval with', async () => {
    const { executor, approved, requests, opts } = approving(0n);

    const outcome = await ensurePayerFunds(uptoRequirement('1000000'), PAYER, executor, {
      ...opts,
      balanceReader: async () => 1_000_000n,
    });

    expect(outcome.ok).toBe(true);
    expect(requests.some((r) => r.method === 'wallet_sendCalls')).toBe(true);
    expect(approved).toEqual([BASE_SEPOLIA_USDC]);
  });

  test('reports the approval batch even when the balance covered the price and nothing else ran', async () => {
    const { executor, requests, opts } = approving(0n);

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, opts);

    expect(outcome).toEqual({
      ok: true,
      skipped: true,
      approvalBatchId: '0xapproval1',
      // Handed forward so the signer does not read the same allowance again.
      permit2Allowance: 2n ** 256n - 1n,
    });
    expect(requests.some((r) => r.method === 'wallet_sendCalls')).toBe(false);
  });

  // No principal moved on this branch and no cap was drawn: the payer covered
  // the price on its own and only the approval was sent. Sending the operator to
  // the permission cap would be blaming the one thing that did not happen.
  test('blames the approval, not the cap, when its gas leaves the payer short', async () => {
    const { executor, opts } = approving(0n);
    let call = 0;

    const outcome = await ensurePayerFunds(uptoRequirement('1000000'), PAYER, executor, {
      ...opts,
      // Covers the price and the reserve, then the approval's gas takes it under.
      balanceReader: async () => (++call === 1 ? 1_100_000n : 999_999n),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('after the Permit2 approval');
    expect(outcome.reason).toContain('Retry the payment');
    expect(outcome.reason).not.toContain('the cap allows');
    expect(outcome.reason).not.toContain('raise the cap');
    expect(outcome.approvalBatchId).toBe('0xapproval1');
    // Nothing moved, so nothing may reach the ledger as topped up.
    expect(outcome.amount).toBeUndefined();
  });

  test('warns about the approval rather than a refill when the balance cannot be re-read', async () => {
    const { executor, opts } = approving(0n);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let call = 0;

    const outcome = await ensurePayerFunds(uptoRequirement('1000000'), PAYER, executor, {
      ...opts,
      balanceReader: async () => {
        if (++call === 1) return 1_100_000n;
        throw new Error('rpc down');
      },
    });

    expect(outcome.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after the Permit2 approval'));
    warn.mockRestore();
  });

  test('does not grant it again once the allowance covers the ceiling', async () => {
    const { executor, approved, opts } = approving(10n ** 30n);

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, opts);

    expect(outcome.ok).toBe(true);
    expect(approved).toEqual([]);
  });

  test('leaves the exact scheme alone, which never touches Permit2', async () => {
    const { executor, approved, opts } = approving(0n);

    await ensurePayerFunds(requirement(), PAYER, executor, opts);

    expect(approved).toEqual([]);
  });

  test('refuses the payment when the approval cannot be confirmed', async () => {
    const { executor, opts } = approving(0n, { status: async () => ({ status: 500 }) });

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, opts);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('Permit2 approval failed on-chain');
  });

  /**
   * The payer re-reads this allowance immediately afterwards, right before it
   * signs, and from the same client. A node that has not caught up would refuse
   * a payment whose approval had already landed, after the user paid for the
   * approval and the top-up both, so the funder waits to see it rather than
   * handing that race to the signer.
   */
  test('waits for the granted allowance to be visible before calling the payer funded', async () => {
    const { executor: base, opts } = approving(0n);
    const executor: TopUpExecutor = {
      request: base.request.bind(base),
      approvePermit2: base.approvePermit2,
    };

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, {
      ...opts,
      // A replica that never catches up, which is the shape of one that is
      // merely slow at the moment the payer would have read it.
      allowanceReader: async () => 0n,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('not visible yet');
    // The approval is not resent on the retry, so the id has to survive.
    expect(outcome.approvalBatchId).toBe('0xapproval1');
  });

  test('refuses rather than signing when the allowance cannot be read', async () => {
    const { executor, opts } = approving(0n);
    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, {
      ...opts,
      allowanceReader: async () => {
        throw new Error('rpc down');
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("could not read the payer's Permit2 allowance");
  });

  test('says so when the executor cannot grant an approval at all', async () => {
    const { executor: base, opts } = approving(0n);
    const executor: TopUpExecutor = { request: base.request.bind(base) };

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, opts);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('cannot grant it');
  });

  /**
   * A class, not an object literal, because that is the difference that matters
   * and every other executor here is a literal. The real one is SessionBridge,
   * where `approvePermit2` is a prototype method that reads `this` on its first
   * line, so passing the reference on instead of calling it through the executor
   * throws once it is finally invoked. That is the last step of the funder, so
   * the top-up has already pulled the user's USDC through the permission by
   * then: the funds move and the payment refuses anyway, on every retry.
   */
  test('grants through an executor whose approval is a prototype method', async () => {
    const base = fakeExecutor();
    let current = 0n;

    class BridgeShaped implements TopUpExecutor {
      readonly approved: string[] = [];
      constructor(private readonly send: TopUpExecutor['request']) {}
      request(method: string, params?: unknown) {
        return this.send(method, params);
      }
      async approvePermit2(token: `0x${string}`): Promise<string> {
        // Reading `this` is the whole point: unbound, this line is the throw.
        this.approved.push(token);
        current = 2n ** 256n - 1n;
        return '0xapproval1';
      }
    }
    const executor = new BridgeShaped(base.executor.request.bind(base.executor));

    const outcome = await ensurePayerFunds(uptoRequirement(), PAYER, executor, {
      ...instantly,
      balanceReader: async () => 10_000_000n,
      allowanceReader: async () => current,
    });

    expect(outcome.ok).toBe(true);
    expect(executor.approved).toEqual([BASE_SEPOLIA_USDC]);
    expect(outcome.approvalBatchId).toBe('0xapproval1');
  });
});

// The read that decides whether the payer can pay runs after the transfer landed.
// When it fails the funder proceeds, because the cap is already drawn and
// refusing on an unreachable node buys a certain non-payment. What it must not do
// is proceed in silence: the one check that would have caught a short payer did
// not run, and only the warning says so.
test('Given the post-refill read fails, When it proceeds anyway, Then it says the check did not run', async () => {
  const { executor } = fakeExecutor();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let call = 0;

  const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
    balanceReader: async () => {
      call += 1;
      if (call === 1) return 0n;
      throw new Error('rpc down');
    },
    ...instantly,
  });

  expect(out.ok).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not re-read the payer balance'));
  warn.mockRestore();
});

describe('ensurePayerFunds against the funds behind the permission', () => {
  const FUNDER = '0x3333333333333333333333333333333333333333' as const;

  /**
   * A chain where the payer and the account the permission draws from hold
   * different balances, which `payerHolding` alone cannot express: its reader
   * answers the same figure whoever is asked about.
   */
  function fakeChainWithFunder(payerInitial: bigint, funderHolds: bigint) {
    const wired = fakeChain(payerInitial);
    const asked: string[] = [];
    const balanceReader: BalanceReader = async (_asset, owner) => {
      asked.push(owner.toLowerCase());
      return owner.toLowerCase() === FUNDER.toLowerCase() ? funderHolds : wired.balanceReader();
    };
    return { ...wired, balanceReader, asked };
  }

  const amountSent = (requests: Array<{ method: string; params: unknown }>) => {
    const send = requests.find((r) => r.method === 'wallet_sendCalls');
    const call = (send?.params as Array<{ calls: Array<{ data: `0x${string}` }> }>)[0].calls[0];
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    return decoded.args[1];
  };

  // The refill used to be sized against the caps alone, so a short account sent
  // a transfer that reverted inside the userOp, and the error the user got was
  // core failing to size the paymaster approval for a token on a chain.
  test('Given the account cannot cover the payment and the fee, When ensuring funds, Then it refuses with nothing sent', async () => {
    // 0.75 short plus a cent of fee is 760000, and the account holds less.
    const { executor, requests, balanceReader } = fakeChainWithFunder(250_000n, 700_000n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      funderAddress: FUNDER,
      ...instantly,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain(FUNDER);
    expect(out.reason).toContain('700000');
    expect(out.reason).toContain('760000');
    expect(requests).toHaveLength(0);
  });

  test('Given the account covers the payment but not the reserve, When ensuring funds, Then it pulls what the payment needs and leaves the rest', async () => {
    // The reserve asks for 850000 and the account holds 800000. Pulling all of
    // it would empty the account into the session key; 760000 is the payment
    // and the fee for the refill that carries it.
    const { executor, requests, balanceReader } = fakeChainWithFunder(250_000n, 800_000n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      funderAddress: FUNDER,
      ...instantly,
    });

    expect(out.ok).toBe(true);
    expect(out.amount).toBe('760000');
    expect(amountSent(requests)).toBe(760_000n);
  });

  test('Given the payer already covers the price, When ensuring funds, Then the account is never asked about', async () => {
    const { executor, balanceReader, asked } = fakeChainWithFunder(2_000_000n, 0n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      funderAddress: FUNDER,
      ...instantly,
    });

    expect(out).toEqual({ ok: true, skipped: true });
    expect(asked).not.toContain(FUNDER.toLowerCase());
  });

  test('Given no account to read, When ensuring funds, Then the refill is sized against the caps as before', async () => {
    const { executor, requests, balanceReader } = fakeChainWithFunder(250_000n, 0n);

    const out = await ensurePayerFunds(requirement('1000000'), PAYER, executor, {
      balanceReader,
      ...instantly,
    });

    expect(out.amount).toBe('850000');
    expect(amountSent(requests)).toBe(850_000n);
  });
});
