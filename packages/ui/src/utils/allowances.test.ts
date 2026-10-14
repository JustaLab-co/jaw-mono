import { describe, expect, it } from 'vitest';
import { maxUint160, maxUint256 } from 'viem';
import { allowanceChanges, decodeAllowanceChange, PERMIT2_ADDRESS } from './allowances';

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
    expect(decodeAllowanceChange({ to: PERMIT2_ADDRESS, data: permit2(1_000n) })).toMatchObject({
      token: TOKEN,
      spender: SPENDER,
      amount: 1_000n,
      unlimited: false,
    });
  });

  it('matches the Permit2 address in any case and flags max uint160', () => {
    const change = decodeAllowanceChange({ to: PERMIT2_ADDRESS.toLowerCase(), data: permit2(maxUint160) });
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

  it('ignores short or malformed calldata', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: '0x095ea7b3' })).toBeNull();
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(1n).slice(0, 100) })).toBeNull();
    expect(decodeAllowanceChange({ to: TOKEN, data: 'not hex' })).toBeNull();
    expect(decodeAllowanceChange({ to: 'not an address', data: approve(1n) })).toBeNull();
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
