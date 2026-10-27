import { describe, expect, it } from 'vitest';
import { labelhash, maxUint160, maxUint256, namehash } from 'viem';
import { allowanceFlag, decodeAllowanceChange, type AllowanceFlag } from './allowances';

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
// DAI's pre-EIP-2612 permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32).
const daiPermit = (allowed: bigint) =>
  `0x8fcbaf0c${addr(OWNER)}${addr(SPENDER)}${uint(3n)}${uint(1_900_000_000n)}${uint(allowed)}${uint(27n)}${uint(1n)}${uint(2n)}`;
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
      argIndex: 1,
    });
  });

  it('flags an increase from max uint160 up as unlimited, the same rule as Permit2', () => {
    for (const amount of [maxUint256, 1n << 255n, 1n << 200n, maxUint160 + 1n, maxUint160]) {
      expect(decodeAllowanceChange({ to: TOKEN, data: increase(amount) })?.unlimited).toBe(true);
    }
    expect(decodeAllowanceChange({ to: TOKEN, data: increase(maxUint160 - 1n) })?.unlimited).toBe(false);
  });

  it('flags an approve as unlimited only at exactly max uint256 or max uint160', () => {
    // Any other number may be an NFT token id: approve has the same selector on an ERC-721.
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(maxUint256) })?.unlimited).toBe(true);
    expect(decodeAllowanceChange({ to: TOKEN, data: approve(maxUint160) })?.unlimited).toBe(true);
    for (const amount of [maxUint256 - 1n, 1n << 255n, 1n << 200n, maxUint160 + 1n, maxUint160 - 1n]) {
      expect(decodeAllowanceChange({ to: TOKEN, data: approve(amount) })?.unlimited).toBe(false);
    }
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

  it('does not flag a Permit2 approve one below max uint160 as unlimited', () => {
    expect(decodeAllowanceChange({ to: PERMIT2, data: permit2(maxUint160 - 1n) })).toMatchObject({ unlimited: false });
  });

  it('reads a Permit2 approve as setting the allowance, never adding to it', () => {
    expect(decodeAllowanceChange({ to: PERMIT2, data: permit2(5n) })).toMatchObject({
      added: false,
      amount: 5n,
      revoke: false,
    });
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
      argIndex: 2,
    });
    expect(decodeAllowanceChange({ to: TOKEN, data: permit(maxUint256) })?.unlimited).toBe(true);
    expect(decodeAllowanceChange({ to: TOKEN, data: permit(0n) })).toMatchObject({ revoke: true });
  });

  it('reads a DAI permit with allowed true as an unlimited allowance from its holder', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: daiPermit(1n) })).toMatchObject({
      token: TOKEN,
      spender: SPENDER,
      owner: OWNER,
      added: false,
      allTokens: false,
      unlimited: true,
      revoke: false,
      ambiguous: false,
    });
  });

  it('reads a DAI permit with allowed false as a revoke', () => {
    expect(decodeAllowanceChange({ to: TOKEN, data: daiPermit(0n) })).toMatchObject({
      spender: SPENDER,
      owner: OWNER,
      unlimited: false,
      revoke: true,
    });
  });
});

describe('allowanceFlag', () => {
  const unlimited = (argIndex: number, amount: bigint): AllowanceFlag => ({ label: 'Unlimited', argIndex, amount });

  it('flags each unlimited allowance kind on the argument that carries the amount', () => {
    const cases: [{ to: string; data: string }, AllowanceFlag][] = [
      [{ to: TOKEN, data: approve(maxUint256) }, unlimited(1, maxUint256)],
      [{ to: TOKEN, data: approve(maxUint160) }, unlimited(1, maxUint160)],
      [{ to: TOKEN, data: increase(maxUint256) }, unlimited(1, maxUint256)],
      [{ to: TOKEN, data: increaseApproval(1n << 200n) }, unlimited(1, 1n << 200n)],
      [{ to: TOKEN, data: approveAndCall(maxUint256) }, unlimited(1, maxUint256)],
      [{ to: TOKEN, data: approveAndCallData(maxUint256) }, unlimited(1, maxUint256)],
      [
        { to: TOKEN, data: setAll(1n) },
        { label: 'All tokens', argIndex: 1 },
      ],
      [{ to: TOKEN, data: permit(maxUint256) }, unlimited(2, maxUint256)],
      [{ to: TOKEN, data: daiPermit(1n) }, unlimited(4, maxUint256)],
      [{ to: PERMIT2, data: permit2(maxUint160) }, unlimited(2, maxUint160)],
    ];
    expect(cases.map(([call]) => allowanceFlag(call))).toEqual(cases.map(([, flag]) => flag));
  });

  it('flags nothing for finite amounts, revokes and calls that grant no allowance', () => {
    const calls = [
      { to: TOKEN, data: approve(5_000_000n) },
      { to: TOKEN, data: approve(0n) },
      { to: TOKEN, data: increase(maxUint160 - 1n) },
      { to: TOKEN, data: setAll(0n) },
      { to: TOKEN, data: permit(1_000n) },
      { to: TOKEN, data: daiPermit(0n) },
      { to: PERMIT2, data: permit2(maxUint160 - 1n) },
      { to: TOKEN, data: '0x' },
      { to: SPENDER, data: '0xdeadbeef' },
    ];
    expect(calls.map(allowanceFlag)).toEqual(calls.map(() => null));
  });

  it('never flags an ENS name approval, on the registrar or the NameWrapper', () => {
    // The registrar's token id is the labelhash; the NameWrapper's, an ERC-1155, is the namehash.
    const registrar = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
    const nameWrapper = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
    expect(allowanceFlag({ to: registrar, data: approve(BigInt(labelhash('vitalik'))) })).toBeNull();
    expect(allowanceFlag({ to: nameWrapper, data: approve(BigInt(namehash('nick.eth'))) })).toBeNull();
  });

  it('flags nothing for an allowance selector whose arguments do not decode', () => {
    expect(allowanceFlag({ to: TOKEN, data: '0x095ea7b3' })).toBeNull();
  });
});
