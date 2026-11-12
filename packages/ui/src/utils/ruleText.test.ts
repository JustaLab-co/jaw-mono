import { describe, expect, it } from 'vitest';

import { argumentAt, describeRule, type RulePart, type RuleText } from './ruleText';
import type { CheckerRule } from './checkerRule';

const LANDLORD_WORD = '0x0000000000000000000000000000000000000000000000000000000000001a4d';
const ACCOUNT_WORD = '0x000000000000000000000000acc0acc0acc0acc0acc0acc0acc0acc0acc0acc0';
// Checksummed, from `cast to-check-sum-address`.
const LANDLORD = '0x0000000000000000000000000000000000001a4d';
const word = (hex: string) => `0x${hex.padStart(64, '0')}` as const;

/** Parts joined the way the screen reads them, addresses written out. */
const read = (text: RuleText) =>
  text.tone === 'rule'
    ? text.parts
        .map((part: RulePart) => (typeof part === 'string' ? part : 'address' in part ? part.address : 'this wallet'))
        .join('')
    : text.tone;

const EXACT_INPUT_SINGLE =
  'exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)';
const EXACT_INPUT_SINGLE_UNNAMED = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';
const SWAP_DESCRIPTOR = { formatKey: EXACT_INPUT_SINGLE, fields: [{ path: 'params.recipient', label: 'Recipient' }] };

const transfer = { selector: '0xa9059cbb', signature: 'transfer(address,uint256)' };
const describe1 = (rule: CheckerRule, call: object, extra: object = {}) =>
  read(describeRule(rule, { call, nativeSymbol: 'ETH', ...extra }));

describe('the argument a rule reads', () => {
  it('uses the label a clear-signing descriptor gives the field', () => {
    expect(
      argumentAt(3n, { selector: '0x04e45aaf', signature: EXACT_INPUT_SINGLE_UNNAMED, descriptor: SWAP_DESCRIPTOR })
    ).toEqual({ label: 'Recipient', type: 'address' });
  });

  it('takes the name from the descriptor’s own signature when it has no label for that field', () => {
    expect(
      argumentAt(4n, {
        selector: '0x04e45aaf',
        signature: EXACT_INPUT_SINGLE_UNNAMED,
        descriptor: { formatKey: EXACT_INPUT_SINGLE, fields: [] },
      })
    ).toEqual({ label: 'amountIn', type: 'uint256' });
  });

  it('uses the ERC-20 standard’s names for a token function', () => {
    expect(argumentAt(0n, transfer)).toEqual({ label: 'to', type: 'address' });
    expect(argumentAt(1n, { selector: '0x095ea7b3' })).toEqual({ label: 'amount', type: 'uint256' });
    expect(argumentAt(1n, { selector: '0x23b872dd' })).toEqual({ label: 'to', type: 'address' });
  });

  // A dapp picks its signature's parameter names, and nothing binds them to the function: it could
  // call a referrer "recipient". So its names never stand alone, and never beat a trusted one.
  it('shows a name from the dapp’s own signature only as the app’s', () => {
    expect(argumentAt(3n, { selector: '0x04e45aaf', signature: EXACT_INPUT_SINGLE })).toEqual({
      label: 'argument 4 (the app calls it “recipient”)',
      type: 'address',
    });
    expect(argumentAt(0n, { selector: '0xa9059cbb', signature: 'transfer(address refundTo,uint256 value)' })).toEqual({
      label: 'to',
      type: 'address',
    });
  });

  it('counts from one when nothing names the argument', () => {
    expect(argumentAt(2n, { selector: '0x12345678', signature: 'doThing(address,uint256,bool)' })).toEqual({
      label: 'argument 3',
      type: 'bool',
    });
    expect(argumentAt(0n, { selector: '0x12345678' })).toEqual({ label: 'argument 1' });
  });

  it('marks a slot that holds the offset of a variable-size argument', () => {
    expect(argumentAt(1n, { selector: '0x12345678', signature: 'f(address to,bytes data)' })).toMatchObject({
      dynamic: true,
    });
  });

  it('marks a slot past the function’s arguments', () => {
    expect(argumentAt(2n, transfer)).toMatchObject({ beyondArguments: true });
  });
});

describe('a rule as the grant screen reads it', () => {
  it('says which address an argument must be', () => {
    const text = describeRule(
      { kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [LANDLORD_WORD] },
      { call: transfer, nativeSymbol: 'ETH' }
    );
    expect(text).toEqual({ tone: 'rule', parts: ['To must be ', { address: LANDLORD }] });
  });

  it('reads the ACCOUNT placeholder as this wallet', () => {
    expect(
      describe1(
        { kind: 'argIn', selector: '0x04e45aaf', slot: 3n, allowed: [ACCOUNT_WORD] },
        { selector: '0x04e45aaf', signature: EXACT_INPUT_SINGLE_UNNAMED, descriptor: SWAP_DESCRIPTOR }
      )
    ).toBe('Recipient must be this wallet');
  });

  it('lists every value a rule allows', () => {
    expect(
      describe1({ kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [LANDLORD_WORD, ACCOUNT_WORD] }, transfer)
    ).toBe(`To must be one of ${LANDLORD}, this wallet`);
  });

  it('shows a number argument as a number and a bool as true or false', () => {
    const call = { selector: '0x12345678', signature: 'doThing(uint256,bool)' };
    expect(describe1({ kind: 'argIn', selector: '0x12345678', slot: 0n, allowed: [word('2710')] }, call)).toBe(
      'Argument 1 must be 10,000'
    );
    expect(describe1({ kind: 'argIn', selector: '0x12345678', slot: 1n, allowed: [word('1')] }, call)).toBe(
      'Argument 2 must be true'
    );
  });

  it('shows a negative number the way the contract compares it', () => {
    const call = { selector: '0x12345678', signature: 'setTick(int24)' };
    expect(describe1({ kind: 'argIn', selector: '0x12345678', slot: 0n, allowed: [`0x${'f'.repeat(64)}`] }, call)).toBe(
      'Argument 1 must be -1'
    );
  });

  it('shows a word as hex when nothing says its type', () => {
    expect(describe1({ kind: 'argIn', selector: '0x12345678', slot: 0n, allowed: [word('2710')] }, {})).toBe(
      `Argument 1 must be ${word('2710')}`
    );
  });

  it('caps a token amount in the token’s own units when it is known', () => {
    expect(
      describe1({ kind: 'argAtMost', selector: '0xa9059cbb', slot: 1n, max: 100_000_000n }, transfer, {
        token: { decimals: 6, symbol: 'USDC' },
      })
    ).toBe('Amount at most 100 USDC per call');
  });

  // Until the token's units are read, a bare 100,000,000 would read as a hundred million tokens.
  it('says a token amount is in base units until the token’s units are known', () => {
    expect(describe1({ kind: 'argAtMost', selector: '0xa9059cbb', slot: 1n, max: 100_000_000n }, transfer)).toBe(
      'Amount at most 100,000,000 base units per call'
    );
  });

  it('groups a cap on a number that isn’t a token amount', () => {
    expect(
      describe1(
        { kind: 'argAtMost', selector: '0x12345678', slot: 0n, max: 5000n },
        { selector: '0x12345678', signature: 'setFee(uint256)' }
      )
    ).toBe('Argument 1 at most 5,000 per call');
  });

  // The contract compares the word unsigned, so a negative value is a huge number and never passes.
  it('caps a signed argument from 0, since no negative value passes', () => {
    expect(
      describe1(
        { kind: 'argAtMost', selector: '0x12345678', slot: 0n, max: 100n },
        { selector: '0x12345678', signature: 'move(int256)' }
      )
    ).toBe('Argument 1 from 0 to 100 per call');
  });

  it('caps what a call sends in the chain’s native token', () => {
    expect(
      describe1({ kind: 'valueAtMost', selector: '0xe0e0e0e0', max: 10n ** 17n }, { selector: '0xe0e0e0e0' })
    ).toBe('Sends at most 0.1 ETH per call');
  });

  it('says which function the rule allows when it guards any function', () => {
    expect(
      describe1(
        { kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [LANDLORD_WORD] },
        { selector: '0x32323232' }
      )
    ).toBe(`Only transfer, where to must be ${LANDLORD}`);
    expect(
      describe1({ kind: 'valueAtMost', selector: '0xe0e0e0e0', max: 10n ** 17n }, { selector: '0x32323232' })
    ).toBe('Only plain transfers, sending at most 0.1 ETH per call');
  });
});

describe('a rule that can never pass a call', () => {
  it('blocks when the rule names a different function from the one it guards', () => {
    expect(describe1({ kind: 'argIn', selector: '0x095ea7b3', slot: 0n, allowed: [LANDLORD_WORD] }, transfer)).toBe(
      'blocks'
    );
  });

  it('blocks when the list of allowed values is empty', () => {
    expect(describe1({ kind: 'argIn', selector: '0xa9059cbb', slot: 0n, allowed: [] }, transfer)).toBe('blocks');
  });

  // A plain transfer has no arguments to read, so a rule on one never finds the word it checks.
  it('blocks when a rule reads an argument of a plain transfer', () => {
    const call = { selector: '0xe0e0e0e0' };
    expect(describe1({ kind: 'argIn', selector: '0xe0e0e0e0', slot: 0n, allowed: [LANDLORD_WORD] }, call)).toBe(
      'blocks'
    );
    expect(describe1({ kind: 'argAtMost', selector: '0xe0e0e0e0', slot: 0n, max: 5n }, call)).toBe('blocks');
  });

  // These words are no valid encoding of the argument, so no call can match them.
  it.each([
    ['a uint8 over 255', 'setLevel(uint8)', word('12c')],
    ['an int24 not sign-extended', 'setTick(int24)', word('ffffff')],
    ['a bytes4 with bytes after its four', 'setTag(bytes4)', `0x12345678${'0'.repeat(54)}01`],
    ['a bool that is neither 0 nor 1', 'setFlag(bool)', word('2')],
    ['an address with bytes above its twenty', 'setOwner(address)', `0x01${'0'.repeat(62)}`],
  ])('blocks when the only allowed value is %s', (_, signature, allowed) => {
    expect(
      describe1(
        { kind: 'argIn', selector: '0x12345678', slot: 0n, allowed: [allowed as `0x${string}`] },
        {
          selector: '0x12345678',
          signature,
        }
      )
    ).toBe('blocks');
  });

  it('leaves out a value no call can match and keeps the rest', () => {
    expect(
      describe1(
        { kind: 'argIn', selector: '0x12345678', slot: 0n, allowed: [word('12c'), word('7')] },
        { selector: '0x12345678', signature: 'setLevel(uint8)' }
      )
    ).toBe('Argument 1 must be 7');
  });
});

describe('a rule of ours the screen can’t state truthfully', () => {
  // The word at a variable-size argument's slot is an offset, so the rule checks where the data
  // is, not what it is.
  it('is a custom check when it reads a variable-size argument', () => {
    expect(
      describe1(
        { kind: 'argIn', selector: '0x12345678', slot: 1n, allowed: [word('40')] },
        { selector: '0x12345678', signature: 'f(address,bytes)' }
      )
    ).toBe('custom');
  });

  it('is a custom check when it reads past the function’s arguments', () => {
    expect(describe1({ kind: 'argIn', selector: '0xa9059cbb', slot: 5n, allowed: [word('1')] }, transfer)).toBe(
      'custom'
    );
  });

  it('is a custom check when it caps an argument that isn’t a number', () => {
    expect(describe1({ kind: 'argAtMost', selector: '0xa9059cbb', slot: 0n, max: 5n }, transfer)).toBe('custom');
  });
});
