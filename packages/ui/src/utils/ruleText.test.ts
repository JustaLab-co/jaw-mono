import { describe, expect, it } from 'vitest';

import { argumentAt, describeRule, type RulePart } from './ruleText';

const LANDLORD_WORD = '0x0000000000000000000000000000000000000000000000000000000000001a4d';
const ACCOUNT_WORD = '0x000000000000000000000000acc0acc0acc0acc0acc0acc0acc0acc0acc0acc0';
// Checksummed, from `cast to-check-sum-address`.
const LANDLORD = '0x0000000000000000000000000000000000001a4d';

/** Parts joined the way the screen reads them, addresses written out. */
const read = (parts: RulePart[]) =>
  parts.map((part) => (typeof part === 'string' ? part : 'address' in part ? part.address : 'this wallet')).join('');

const EXACT_INPUT_SINGLE =
  'exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)';

describe('the argument a rule reads', () => {
  it('takes its name from a signature that has names', () => {
    expect(argumentAt(0n, { selector: '0xa9059cbb', signature: 'transfer(address recipient,uint256 value)' })).toEqual({
      label: 'recipient',
      type: 'address',
    });
  });

  it('falls back to the ERC-20 names for an unnamed token function', () => {
    expect(argumentAt(0n, { selector: '0xa9059cbb', signature: 'transfer(address,uint256)' })).toEqual({
      label: 'to',
      type: 'address',
    });
    expect(argumentAt(1n, { selector: '0x095ea7b3', signature: 'approve(address,uint256)' })).toEqual({
      label: 'amount',
      type: 'uint256',
    });
    expect(argumentAt(1n, { selector: '0x23b872dd', signature: 'transferFrom(address,address,uint256)' })).toEqual({
      label: 'to',
      type: 'address',
    });
  });

  // A struct of fixed-size fields sits inline, one word per field, so slot 3 is its fourth field.
  it('names a field inside a struct argument', () => {
    expect(argumentAt(3n, { selector: '0x04e45aaf', signature: EXACT_INPUT_SINGLE })).toEqual({
      label: 'recipient',
      type: 'address',
    });
  });

  it('uses the label a clear-signing descriptor gives the field when the signature has no names', () => {
    const descriptor = {
      formatKey: EXACT_INPUT_SINGLE,
      fields: [{ path: 'params.recipient', label: 'Beneficiary' }],
    };
    expect(
      argumentAt(3n, {
        selector: '0x04e45aaf',
        signature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
        descriptor,
      })
    ).toEqual({ label: 'Beneficiary', type: 'address' });
  });

  it('takes the name from the descriptor’s signature when it has no label for that field', () => {
    expect(
      argumentAt(4n, {
        selector: '0x04e45aaf',
        signature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
        descriptor: { formatKey: EXACT_INPUT_SINGLE, fields: [] },
      })
    ).toEqual({ label: 'amountIn', type: 'uint256' });
  });

  it('counts from one only when nothing names the argument', () => {
    expect(argumentAt(2n, { selector: '0x12345678', signature: 'doThing(address,uint256,bool)' })).toEqual({
      label: 'argument 3',
      type: 'bool',
    });
    expect(argumentAt(0n, { selector: '0x12345678' })).toEqual({ label: 'argument 1' });
  });
});

describe('a rule as the grant screen reads it', () => {
  const transfer = { selector: '0xa9059cbb', signature: 'transfer(address,uint256)' };

  it('says which address an argument must be', () => {
    const text = describeRule(
      { kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [LANDLORD_WORD] },
      { call: transfer, nativeSymbol: 'ETH' }
    );
    expect(text).toMatchObject({ tone: 'rule' });
    expect(read(text.parts)).toBe(`To must be ${LANDLORD}`);
  });

  it('reads the ACCOUNT placeholder as this wallet', () => {
    const text = describeRule(
      { kind: 'argIn', selector: '0x04e45aaf', slot: 3n, allowed: [ACCOUNT_WORD] },
      { call: { selector: '0x04e45aaf', signature: EXACT_INPUT_SINGLE }, nativeSymbol: 'ETH' }
    );
    expect(read(text.parts)).toBe('Recipient must be this wallet');
  });

  it('lists every value a rule allows', () => {
    const text = describeRule(
      { kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [LANDLORD_WORD, ACCOUNT_WORD] },
      { call: transfer, nativeSymbol: 'ETH' }
    );
    expect(read(text.parts)).toBe(`To must be one of ${LANDLORD}, this wallet`);
  });

  it('caps a token amount in the token’s own units when it is known', () => {
    const text = describeRule(
      { kind: 'argAtMost', selector: '0xa9059cbb', slot: 1n, max: 100_000_000n },
      { call: transfer, token: { decimals: 6, symbol: 'USDC' }, nativeSymbol: 'ETH' }
    );
    expect(read(text.parts)).toBe('Amount at most 100 USDC per call');
  });

  it('groups a cap whose units it can’t know', () => {
    const text = describeRule(
      { kind: 'argAtMost', selector: '0xa9059cbb', slot: 1n, max: 100_000_000n },
      { call: transfer, nativeSymbol: 'ETH' }
    );
    expect(read(text.parts)).toBe('Amount at most 100,000,000 per call');
  });

  it('caps what a call sends in the chain’s native token', () => {
    const text = describeRule(
      { kind: 'valueAtMost', selector: '0xe0e0e0e0', max: 10n ** 17n },
      { call: { selector: '0xe0e0e0e0' }, nativeSymbol: 'ETH' }
    );
    expect(read(text.parts)).toBe('Sends at most 0.1 ETH per call');
  });

  it('shows a number argument as a number and a bool as true or false', () => {
    const call = { selector: '0x12345678', signature: 'doThing(uint256 tier,bool enabled)' };
    expect(
      read(
        describeRule(
          { kind: 'argIn', selector: '0x12345678', slot: 0n, allowed: [`0x${'0'.repeat(60)}2710`] },
          { call, nativeSymbol: 'ETH' }
        ).parts
      )
    ).toBe('Tier must be 10,000');
    expect(
      read(
        describeRule(
          { kind: 'argIn', selector: '0x12345678', slot: 1n, allowed: [`0x${'0'.repeat(63)}1`] },
          { call, nativeSymbol: 'ETH' }
        ).parts
      )
    ).toBe('Enabled must be true');
  });

  // The rule only passes calls to its own function, so on any other one it blocks them all.
  it('blocks every call when the rule names a different function from the one it guards', () => {
    expect(
      describeRule(
        { kind: 'argIn', selector: '0x095ea7b3', slot: 0n, allowed: [LANDLORD_WORD] },
        { call: transfer, nativeSymbol: 'ETH' }
      )
    ).toEqual({ tone: 'blocks' });
  });

  it('blocks every call when the list of allowed values is empty', () => {
    expect(
      describeRule(
        { kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [] },
        { call: transfer, nativeSymbol: 'ETH' }
      )
    ).toEqual({ tone: 'blocks' });
  });

  it('says which function the rule allows when it guards any function', () => {
    const text = describeRule(
      { kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [LANDLORD_WORD] },
      { call: { selector: '0x32323232' }, nativeSymbol: 'ETH' }
    );
    expect(read(text.parts)).toBe(`Only transfer, where to must be ${LANDLORD}`);
  });
});
