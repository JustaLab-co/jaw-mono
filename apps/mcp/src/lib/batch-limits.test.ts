import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { entryPoint08Address } from 'viem/account-abstraction';
import { describe, expect, it } from 'vitest';
import { gasNode } from '@/owner-calls/chain-testkit';
import { batchBytes, gasBudget, overBudget } from './batch-limits';

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
// An ERC-20 approve: a selector and two words, 68 bytes.
const APPROVE = `0x095ea7b3${'00'.repeat(12)}${'22'.repeat(20)}${'0'.repeat(63)}1` as Hex;
const approves = (n: number) => Array.from({ length: n }, () => ({ to: TOKEN, value: 0n, data: APPROVE }));
// The runtime code of a deployed JAW account, read off 0xD529852a5ce970e7a49d4Cb09cB259A8057ebe6f on Base.
const JAW_ACCOUNT_CODE = '0x363d3d373d3d3d363d73bb4f7d5418cd8dadb61bb95561179e517572cbcd5af43d82803e903d91602b57fd5bf3';
const executeBatch = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);

describe('batchBytes', () => {
  // A selector, the array's offset and length, then per call its offset, target, value, data offset, data length and
  // the data padded to 32 bytes: 4 + 32 + 32 + (5 * 32 + 96) per approve.
  it('given one approve, then it counts the 324 bytes the wallet sends', () => {
    expect(batchBytes(approves(1))).toBe(324);
  });

  // The wallet's own encoder made 48,708 bytes of these 190 approves in the live estimate of 2026-10-26.
  it('given 190 approves, then it counts 48,708 bytes', () => {
    expect(batchBytes(approves(190))).toBe(48_708);
  });
});

describe('gasBudget', () => {
  it('given blocks that hold more than one transaction may use, then a batch gets 5M', () => {
    expect(gasBudget(60_000_000n)).toBe(5_000_000n);
    // Arbitrum answers 2^50 for its blocks.
    expect(gasBudget(1_125_899_906_842_624n)).toBe(5_000_000n);
  });

  // (10M - 6.975M around the calls) x 6/11.
  it("given Citrea's 10M blocks, then a batch gets 1.65M", () => {
    expect(gasBudget(10_000_000n)).toBe(1_650_000n);
  });

  it('given blocks too small for what goes around the calls, then nothing fits', () => {
    expect(gasBudget(6_000_000n)).toBe(0n);
  });
});

describe('overBudget', () => {
  it('given an account not deployed yet, then the batch is estimated from the EntryPoint on the JAW account code', async () => {
    const node = gasNode({ code: '0x' });

    await overBudget(node.clientFor(8453), ACCOUNT, approves(2));

    const estimate = node.asked.find((a) => a.method === 'eth_estimateGas')!;
    expect(estimate.params[0]).toMatchObject({
      from: entryPoint08Address,
      to: ACCOUNT,
      data: encodeFunctionData({
        abi: executeBatch,
        functionName: 'executeBatch',
        args: [approves(2).map((c) => ({ target: c.to, value: c.value, data: c.data }))],
      }),
    });
    expect((estimate.params[0] as { data: Hex }).data.slice(0, 10)).toBe('0x34fcd5be');
    expect(estimate.params[2]).toEqual({ [ACCOUNT]: { code: JAW_ACCOUNT_CODE } });
  });

  it('given a deployed account, then its own code runs the batch', async () => {
    const node = gasNode({ code: '0x6080604052' });

    await overBudget(node.clientFor(8453), ACCOUNT, approves(2));

    const estimate = node.asked.find((a) => a.method === 'eth_estimateGas')!;
    expect(estimate.params[2]).toBeUndefined();
  });

  it('given a deployed account and a batch needing more gas than the budget, then the gas and the budget come back', async () => {
    const node = gasNode({ code: JAW_ACCOUNT_CODE, gasLimit: 60_000_000n, gas: 5_000_001n });

    expect(await overBudget(node.clientFor(8453), ACCOUNT, approves(2))).toEqual({
      gas: 5_000_001n,
      budget: 5_000_000n,
    });
  });

  it('given a deployed account and a batch needing exactly the budget, then it fits', async () => {
    const node = gasNode({ code: JAW_ACCOUNT_CODE, gasLimit: 60_000_000n, gas: 5_000_000n });

    expect(await overBudget(node.clientFor(8453), ACCOUNT, approves(2))).toBeUndefined();
  });

  it('given an account not deployed yet, then its first transaction gets 3.3M and the chain budget comes back for later', async () => {
    const node = gasNode({ code: '0x', gasLimit: 60_000_000n, gas: 3_300_001n });

    expect(await overBudget(node.clientFor(8453), ACCOUNT, approves(2))).toEqual({
      gas: 3_300_001n,
      budget: 3_300_000n,
      later: 5_000_000n,
    });
  });

  it('given an account not deployed yet and a batch over the chain budget too, then nothing is promised for later', async () => {
    const node = gasNode({ code: '0x', gasLimit: 60_000_000n, gas: 5_000_001n });

    expect(await overBudget(node.clientFor(8453), ACCOUNT, approves(2))).toEqual({
      gas: 5_000_001n,
      budget: 3_300_000n,
    });
  });

  it('given an account not deployed yet and a batch needing exactly 3.3M, then it fits', async () => {
    const node = gasNode({ code: '0x', gasLimit: 60_000_000n, gas: 3_300_000n });

    expect(await overBudget(node.clientFor(8453), ACCOUNT, approves(2))).toBeUndefined();
  });

  // A new account: 3.3M is above what Citrea's blocks leave, so Citrea's own budget stands.
  it("given Citrea's smaller blocks, then a batch that fits elsewhere is over there", async () => {
    const node = gasNode({ gasLimit: 10_000_000n, gas: 2_000_000n });

    expect(await overBudget(node.clientFor(4114), ACCOUNT, approves(2))).toEqual({
      gas: 2_000_000n,
      budget: 1_650_000n,
    });
  });

  it('given a block without a gas limit, then the check fails rather than refusing every batch', async () => {
    const node = gasNode({ gasLimit: null, gas: 21_000n });

    await expect(overBudget(node.clientFor(8453), ACCOUNT, approves(2))).rejects.toThrow();
  });

  it('given a node that cannot answer, then the check fails rather than deciding', async () => {
    const node = gasNode({ down: true });

    await expect(overBudget(node.clientFor(8453), ACCOUNT, approves(2))).rejects.toThrow();
  });
});
