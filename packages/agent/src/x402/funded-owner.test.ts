import { describe, it, expect } from 'vitest';
import { whyOwnerCannotFundSession, whySpenderCannotPay } from './funded-owner.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const BASE_SEPOLIA = 84532;
const PREFUND = 100_000n; // 0.10 USDC

function bridge(accounts: string[] | undefined) {
  return async (method: string) => (method === 'eth_requestAccounts' ? accounts : undefined);
}

describe('whyOwnerCannotFundSession', () => {
  it('lets a funded account through', async () => {
    const reason = await whyOwnerCannotFundSession({
      chainId: BASE_SEPOLIA,
      request: bridge([OWNER]),
      readBalance: async () => PREFUND,
    });

    expect(reason).toBeNull();
  });

  // Granting anyway leaves a permission that cannot be used until the account is
  // funded and the whole setup is run again, which revokes and re-grants.
  it('stops a short account, naming what it holds and what it needs', async () => {
    const reason = await whyOwnerCannotFundSession({
      chainId: BASE_SEPOLIA,
      request: bridge([OWNER]),
      readBalance: async () => PREFUND - 1n,
    });

    expect(reason).toContain(OWNER);
    expect(reason).toContain('0.099999 USDC');
    expect(reason).toContain('0.1 USDC');
  });

  // The wallet makes the same check against its own node before building the
  // transfer, so an RPC hiccup here costs a clearer error, not the guarantee.
  it('does not refuse over an unreachable RPC', async () => {
    const reason = await whyOwnerCannotFundSession({
      chainId: BASE_SEPOLIA,
      request: bridge([OWNER]),
      readBalance: async () => {
        throw new Error('rpc down');
      },
    });

    expect(reason).toBeNull();
  });

  it('says nothing on a chain with no USDC to fund', async () => {
    const reason = await whyOwnerCannotFundSession({
      chainId: 1,
      request: bridge([OWNER]),
      readBalance: async () => 0n,
    });

    expect(reason).toBeNull();
  });

  it('says nothing when the browser reports no account', async () => {
    const reason = await whyOwnerCannotFundSession({
      chainId: BASE_SEPOLIA,
      request: bridge([]),
      readBalance: async () => 0n,
    });

    expect(reason).toBeNull();
  });
});

const SPENDER = '0x2222222222222222222222222222222222222222';
const ONE_OP = 10_000n; // 0.01 USDC, the floor a session has to clear to send anything

/**
 * The wallet decides whether to seed the session, and declines for eight
 * different reasons of which "does not implement the capability" is only one.
 * So this reports the observable state, that the session cannot pay, and never
 * claims to know which of the eight it was.
 */
describe('whySpenderCannotPay', () => {
  const check = (readBalance: () => Promise<bigint>, timeoutMs = 50) =>
    whySpenderCannotPay({ chainId: BASE_SEPOLIA, spender: SPENDER, readBalance, timeoutMs });

  it('says nothing when the session can pay for an operation', async () => {
    expect(await check(async () => PREFUND)).toBeNull();
  });

  it('accepts exactly one operation, since that is all it has to clear', async () => {
    expect(await check(async () => ONE_OP)).toBeNull();
  });

  // A session key is reused by default, so the address can carry dust from a
  // previous life. Reading that as funded would miss the case on the common path.
  it('reports dust below the cost of one operation', async () => {
    const reason = await check(async () => ONE_OP - 1n);
    expect(reason).toContain(SPENDER);
    expect(reason).toContain('0.01');
  });

  it('reports an empty balance', async () => {
    expect(await check(async () => 0n)).toContain('not enough to pay for its first operation');
  });

  it('offers the causes rather than naming one', async () => {
    const reason = (await check(async () => 0n)) ?? '';
    expect(reason).toContain('may not implement');
    expect(reason).toContain('could not price');
    expect(reason).toContain('allowance was too small');
  });

  it('stays quiet on a chain with no USDC, where gas is not charged in it', async () => {
    expect(await whySpenderCannotPay({ chainId: 1, spender: SPENDER, readBalance: async () => 0n })).toBeNull();
  });

  it('stays quiet when the node cannot be read, since the session is already saved', async () => {
    expect(
      await check(async () => {
        throw new Error('rpc down');
      })
    ).toBeNull();
  });

  it('gives up on a stalled node instead of holding the command open', async () => {
    const started = Date.now();
    // A read that never settles, which is what a stalled node looks like.
    const reason = await check(() => new Promise<bigint>(() => undefined));
    expect(reason).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
