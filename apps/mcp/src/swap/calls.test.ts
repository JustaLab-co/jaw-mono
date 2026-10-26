import { encodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { callsOf } from './calls';

const DEPOSIT = '0x3333333333333333333333333333333333333333';
const SPENDER = '0x4444444444444444444444444444444444444444';
const transfer = {
  chainId: 8453,
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [DEPOSIT, 1_000_000n] }),
  value: '0',
} as const;
const approval = {
  kind: 'approve',
  chainId: 8453,
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 1_000_000n] }),
  value: '0',
} as const;
const native = { kind: 'deposit', chainId: 8453, to: DEPOSIT, data: '0x', value: '1000000' } as const;

describe('callsOf', () => {
  it('given a row written before arrays, with one call object, then it reads as that one deposit', () => {
    expect(callsOf({ call: transfer })).toEqual([{ kind: 'deposit', ...transfer }]);
  });

  it('given a row whose call is an array with that same deposit, then it reads the same as the one-object row', () => {
    expect(callsOf({ call: [{ kind: 'deposit', ...transfer }] })).toEqual([{ kind: 'deposit', ...transfer }]);
  });

  it('given an approve then a deposit on one chain, then both read in that order', () => {
    const calls = [approval, { kind: 'deposit', ...transfer }] as const;
    expect(callsOf({ call: [...calls] })).toEqual(calls);
  });

  it('given a native deposit with empty data, then it reads as is', () => {
    expect(callsOf({ call: [native] })).toEqual([native]);
  });

  it.each([
    ['no call', null],
    ['an empty object', {}],
    ['an empty array', []],
    ['an object without data', { chainId: 8453, to: transfer.to, value: '0' }],
    ['an object with an extra field', { ...transfer, gas: '1' }],
    ['a value in hex', { ...transfer, value: '0x0' }],
    ['a negative value', { ...transfer, value: '-1' }],
    ['a short address', { ...transfer, to: '0x1234' }],
    ['data of odd length', { ...transfer, data: '0xabc' }],
    ['a chain id as a string', { ...transfer, chainId: '8453' }],
    ['a deposit with an extra field', [{ ...native, gas: '1' }]],
    ['an unknown kind', [{ ...transfer, kind: 'transfer' }]],
    ['two deposits', [native, native]],
    ['a deposit then an approve', [native, approval]],
    ['an approve alone', [approval]],
    ['three calls', [approval, approval, native]],
    ['calls on two chains', [approval, { ...native, chainId: 42161 }]],
    ['an approve that sends value', [{ ...approval, value: '1' }, native]],
    ['an approve whose data is a transfer', [{ ...approval, data: transfer.data }, native]],
    ['an approve one byte short', [{ ...approval, data: approval.data.slice(0, -2) }, native]],
    ['an approve one byte long', [{ ...approval, data: `${approval.data}00` }, native]],
  ])('given %s, then nothing reads, so nothing can be sent', (_, call) => {
    expect(callsOf({ call: call as never })).toBeUndefined();
  });
});
