import { describe, expect, it } from 'vitest';
import { maxUint160, maxUint256 } from 'viem';
import { allowanceChanges, decodeAllowanceChange } from './allowances';

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const OWNER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';
const word = (hex: string) => hex.padStart(64, '0');
const addr = (a: string) => word(a.slice(2).toLowerCase());
const uint = (n: bigint) => word(n.toString(16));

// Selectors from the standard signatures: approve(address,uint256), increaseAllowance(address,uint256),
// setApprovalForAll(address,bool), Permit2 approve(address,address,uint160,uint48).
const approve = (amount: bigint) => `0x095ea7b3${addr(SPENDER)}${uint(amount)}`;
const increase = (amount: bigint) => `0x39509351${addr(SPENDER)}${uint(amount)}`;
const setAll = (approved: bigint) => `0xa22cb465${addr(SPENDER)}${uint(approved)}`;
const increaseApproval = (amount: bigint) => `0xd73dd623${addr(SPENDER)}${uint(amount)}`;
const approveAndCall = (amount: bigint) => `0x3177029f${addr(SPENDER)}${uint(amount)}`;
const approveAndCallData = (amount: bigint) =>
  `0xcae9ca51${addr(SPENDER)}${uint(amount)}${uint(96n)}${uint(2n)}${'abcd'.padEnd(64, '0')}`;
const permit = (value: bigint) =>
  `0xd505accf${addr(OWNER)}${addr(SPENDER)}${uint(value)}${uint(1_900_000_000n)}${uint(27n)}${uint(1n)}${uint(2n)}`;
const permit2 = (amount: bigint) => `0x87517c45${addr(TOKEN)}${addr(SPENDER)}${uint(amount)}${uint(1_900_000_000n)}`;

describe('decodeAllowanceChange', () => {
  it('reads an ERC-20 approve', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(5_000_000n) })).toEqual({
      token: TOKEN,
      spender: SPENDER,
      amount: 5_000_000n,
      added: false,
      allTokens: false,
      unlimited: false,
      revoke: false,
      ambiguous: true,
    });
  });

  it('flags max uint256 and anything from 2^255 as unlimited', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(maxUint256) })?.unlimited).toBe(true);
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(1n << 255n) })?.unlimited).toBe(true);
    expect(decodeAllowanceChange({ to: TOKEN, data: approve((1n << 255n) - 1n) })?.unlimited).toBe(false);
  });

  it('reads an approve to zero as a revoke', () => {
    const change = decodeAllowanceChange({ to: TOKEN, data: approve(0n) });
    expect(change?.revoke).toBe(true);
    expect(change?.unlimited).toBe(false);
  });

  it('reads increaseAllowance as an addition', () => {
    const change = decodeAllowanceChange({ to: TOKEN, data: increase(7n) });
    expect(change).toMatchObject({ token: TOKEN, spender: SPENDER, amount: 7n, added: true, revoke: false });
  });

  it('does not call an increase by zero a revoke', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: increase(0n) })?.revoke).toBe(false);
  });

  it('reads setApprovalForAll(true) as access to every token', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: setAll(1n) })).toMatchObject({
      token: TOKEN,
      spender: SPENDER,
      allTokens: true,
      unlimited: true,
      revoke: false,
    });
  });

  it('ignores setApprovalForAll(false)', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: setAll(0n) })).toBeNull();
  });

  it('reads a Permit2 approve against the token named in the call', () => {
    expect(decodeAllowanceChange({ to: PERMIT2, data: permit2(1_000n) })).toMatchObject({
      token: TOKEN,
      spender: SPENDER,
      amount: 1_000n,
      unlimited: false,
    });
  });

  it('matches the Permit2 address in any case and flags max uint160', () => {
    const change = decodeAllowanceChange({ to: PERMIT2.toLowerCase(), data: permit2(maxUint160) });
    expect(change?.unlimited).toBe(true);
  });

  it('ignores the Permit2 selector on another contract', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: permit2(1n) })).toBeNull();
  });

  it('ignores other calls, empty calldata and a missing target', () => {
    const transfer = `0xa9059cbb${addr(SPENDER)}${uint(1n)}`;
    expect(decodeAllowanceChange({ to: TOKEN, data: transfer })).toBeNull();
    expect(decodeAllowanceChange({ to: TOKEN, data: '0x' })).toBeNull();
    expect(decodeAllowanceChange({ to: TOKEN })).toBeNull();
    expect(decodeAllowanceChange({ data: approve(1n) })).toBeNull();
  });

  it('ignores calldata that is not hex or a target that is not an address', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: 'not hex' })).toBeNull();
    expect(decodeAllowanceChange({ to: 'not an address', data: approve(1n) })).toBeNull();
  });
});

describe('decodeAllowanceChange with an allowance selector that cannot be read', () => {
  const undecoded = { token: TOKEN, undecoded: true };

  it('flags setApprovalForAll with a bool word of 2', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: setAll(2n) })).toMatchObject(undecoded);
  });

  it('flags approve with a truncated amount word', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(1n).slice(0, 100) })).toMatchObject(undecoded);
    expect(decodeAllowanceChange({ to: TOKEN, data: '0x095ea7b3' })).toMatchObject(undecoded);
  });

  it('flags a Permit2 approve with garbage arguments, on the Permit2 address', () => {
    const data = `0x87517c45${'ff'.repeat(40)}`;
    expect(decodeAllowanceChange({ to: PERMIT2, data })).toMatchObject({ token: PERMIT2, undecoded: true });
  });

  it('flags every other allowance selector', () => {
    for (const selector of ['0x39509351', '0xd73dd623', '0x3177029f', '0xcae9ca51', '0xd505accf']) {
      expect(decodeAllowanceChange({ to: TOKEN, data: `${selector}01` })).toMatchObject(undecoded);
    }
  });

  it('still ignores a selector that is not an allowance one', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: '0xa9059cbb01' })).toBeNull();
    expect(decodeAllowanceChange({ to: TOKEN, data: `0x87517c45${'ff'.repeat(40)}` })).toBeNull();
  });
});

describe('decodeAllowanceChange hardening', () => {
  it('decodes uppercase hex calldata', () => {
    const upper = `0x${approve(5n).slice(2).toUpperCase()}`;
    expect(decodeAllowanceChange({ to: TOKEN, data: upper })).toMatchObject({ spender: SPENDER, amount: 5n });
    expect(decodeAllowanceChange({ to: TOKEN, data: `0X${approve(5n).slice(2)}` })).toMatchObject({ amount: 5n });
  });

  it('decodes uppercase setApprovalForAll and Permit2 approve', () => {
    const all = `0x${setAll(1n).slice(2).toUpperCase()}`;
    expect(decodeAllowanceChange({ to: TOKEN, data: all })).toMatchObject({ allTokens: true, spender: SPENDER });
    const p2 = `0x${permit2(9n).slice(2).toUpperCase()}`;
    expect(decodeAllowanceChange({ to: PERMIT2, data: p2 })).toMatchObject({ token: TOKEN, amount: 9n });
  });

  it('marks only the shared-selector approve as possibly an NFT approval', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(0n) })).toMatchObject({ revoke: true, ambiguous: true });
    expect(decodeAllowanceChange({ to: PERMIT2, data: permit2(0n) })).toMatchObject({ revoke: true, ambiguous: false });
    expect(decodeAllowanceChange({ to: TOKEN, data: increase(1n) })?.ambiguous).toBe(false);
  });

  it('reads increaseApproval as an addition', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: increaseApproval(7n) })).toMatchObject({
      token: TOKEN,
      spender: SPENDER,
      amount: 7n,
      added: true,
      revoke: false,
      ambiguous: false,
    });
    expect(decodeAllowanceChange({ to: TOKEN, data: increaseApproval(maxUint256) })?.unlimited).toBe(true);
  });

  it('reads ERC-1363 approveAndCall with and without data', () => {
    for (const data of [approveAndCall(42n), approveAndCallData(42n)]) {
      expect(decodeAllowanceChange({ to: TOKEN, data })).toMatchObject({
        token: TOKEN,
        spender: SPENDER,
        amount: 42n,
        added: false,
        unlimited: false,
        revoke: false,
        ambiguous: false,
      });
    }
    expect(decodeAllowanceChange({ to: TOKEN, data: approveAndCall(0n) })).toMatchObject({ revoke: true });
    expect(decodeAllowanceChange({ to: TOKEN, data: approveAndCallData(maxUint256) })?.unlimited).toBe(true);
  });

  it('reads an EIP-2612 permit as an allowance from its owner on the called token', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: permit(1_000n) })).toEqual({
      token: TOKEN,
      spender: SPENDER,
      owner: OWNER,
      amount: 1_000n,
      added: false,
      allTokens: false,
      unlimited: false,
      revoke: false,
      ambiguous: false,
    });
    expect(decodeAllowanceChange({ to: TOKEN, data: permit(maxUint256) })?.unlimited).toBe(true);
    expect(decodeAllowanceChange({ to: TOKEN, data: permit(0n) })).toMatchObject({ revoke: true });
  });
});

describe('allowanceChanges', () => {
  it('keeps the allowance calls of a batch in order and drops the rest', () => {
    const changes = allowanceChanges([
      { to: TOKEN, data: approve(maxUint256) },
      { to: SPENDER, data: '0x' },
      { to: TOKEN, data: setAll(1n) },
    ]);
    expect(changes.map((c) => c.allTokens)).toEqual([false, true]);
  });
});
