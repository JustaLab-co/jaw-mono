import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { describeCall } from './decode';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ALICE: Address = '0x2222222222222222222222222222222222222222';
const BOB: Address = '0x3333333333333333333333333333333333333333';
const call = (data: Hex) => ({ to: USDC, value: '0x0' as Hex, data });

describe('call decoding', () => {
  it('names an ERC-20 transfer and its arguments, with no warning', () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ALICE, 10_000n] });
    expect(describeCall(call(data))).toEqual({
      ...call(data),
      function: 'transfer(address,uint256)',
      args: [
        { name: 'recipient', type: 'address', value: ALICE },
        { name: 'amount', type: 'uint256', value: '10000' },
      ],
      warnings: [],
    });
  });

  it('names a transferFrom', () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [ALICE, BOB, 5n] });
    expect(describeCall(call(data))).toMatchObject({ function: 'transferFrom(address,address,uint256)', warnings: [] });
  });

  it('warns that an approve lets the spender move the amount, and calls max uint unlimited', () => {
    const some = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [BOB, 7n] });
    expect(describeCall(call(some))).toMatchObject({
      function: 'approve(address,uint256)',
      warnings: [{ code: 'token_approval', spender: BOB, amount: '7', unlimited: false }],
    });
    const all = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [BOB, maxUint256] });
    expect(describeCall(call(all)).warnings).toEqual([
      { code: 'token_approval', spender: BOB, amount: maxUint256.toString(), unlimited: true },
    ]);
  });

  it('shows an unknown selector as raw calldata with a warning', () => {
    expect(describeCall(call('0xdeadbeef0001'))).toEqual({
      ...call('0xdeadbeef0001'),
      warnings: [{ code: 'unknown_function' }],
    });
  });

  it('shows a known selector with arguments that do not decode as unknown', () => {
    expect(describeCall(call('0xa9059cbb00')).warnings).toEqual([{ code: 'unknown_function' }]);
  });

  it('flags calldata under four bytes', () => {
    expect(describeCall(call('0xa905'))).toEqual({ ...call('0xa905'), warnings: [{ code: 'short_calldata' }] });
  });

  it('leaves a plain value transfer with no calldata unflagged', () => {
    expect(describeCall({ to: ALICE, value: '0x1', data: '0x' })).toEqual({
      to: ALICE,
      value: '0x1',
      data: '0x',
      warnings: [],
    });
  });
});
