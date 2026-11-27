import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { FeeTokenOption } from '../components/FeeTokenSelector';
import { preselectFeeToken, provenErc20 } from './feePreselect';

// A token reduced to the facts the choice reads, as lean/Model/FeePreselect.lean models it.
const tok = (
  isNative: boolean,
  balance: bigint,
  isSelectable: boolean,
  priced: boolean,
  uid = 't'
): FeeTokenOption => ({
  uid,
  symbol: uid,
  address: uid,
  decimals: 18,
  balance,
  balanceFormatted: '',
  isNative,
  isSelectable,
  gasCostMaxFormatted: priced ? '1' : undefined,
});

describe('preselectFeeToken', () => {
  // The vectors and outputs `#eval vectors` prints in lean/Model/FeePreselect.lean.
  const coin2 = tok(true, 2n, true, false, 'coin');
  const coin1 = tok(true, 1n, true, false, 'coin');
  const usdc = tok(false, 5n, true, true, 'usdc');
  const vectors: Array<[FeeTokenOption[], bigint, FeeTokenOption | null]> = [
    [[coin2, usdc], 2n, coin2],
    [[coin1, usdc], 2n, usdc],
    [[usdc], 2n, usdc],
    [[coin1, tok(false, 5n, false, false, 'dai'), usdc], 2n, usdc],
    [[coin1, tok(false, 5n, true, false, 'usdt')], 2n, null],
    [[tok(true, 0n, false, false, 'coin')], 0n, tok(true, 0n, false, false, 'coin')],
    [[], 1n, null],
  ];

  it.each(vectors)('agrees with the Lean model on vector %#', (tokens, need, expected) => {
    expect(preselectFeeToken(tokens, need)).toEqual(expected);
  });

  const arbToken = fc
    .record({
      isNative: fc.boolean(),
      balance: fc.bigInt({ min: 0n, max: 10n }),
      isSelectable: fc.boolean(),
      priced: fc.boolean(),
    })
    .map(({ isNative, balance, isSelectable, priced }) => tok(isNative, balance, isSelectable, priced));

  it('picks a token from the list that can pay, the coin first, or nothing when none can', () => {
    fc.assert(
      fc.property(fc.array(arbToken, { maxLength: 4 }), fc.bigInt({ min: 0n, max: 10n }), (tokens, need) => {
        const coin = tokens.find((t) => t.isNative);
        const coinCovers = !!coin && coin.balance >= need;
        const pick = preselectFeeToken(tokens, need);

        if (coinCovers) expect(pick).toBe(coin);
        else if (tokens.some(provenErc20)) expect(pick).toBe(tokens.find(provenErc20));
        else expect(pick).toBeNull();
      })
    );
  });
});
