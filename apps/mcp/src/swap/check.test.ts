import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, getAddress, zeroAddress } from 'viem';
import { checkQuote } from './check';
import acrossCrossToken from './fixtures/across-usdc-to-weth.json';
import acrossSameToken from './fixtures/prod-across-quote.json';
import relayNative from './fixtures/prod-relay-quote.json';
import relayUsdc from './fixtures/relay-usdc.json';

const BASE = 8453;
const usdc = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const depositAddress = getAddress('0x5f6a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
// The request the USDC fixtures answer: 10 USDC from Base.
const tenUsdc = { originChainId: BASE, originToken: usdc.toLowerCase(), amount: '10000000' };

type Quote = {
  inputAmount: string;
  transactions: { chainId: number; to: string; data: string; value: string }[];
} & Record<string, unknown>;

const bodyOf = (answer: { result: { data: unknown } }): Quote => structuredClone(answer.result.data) as Quote;

const auroraQuote = (): Quote => ({
  quoteId: `aurora:${depositAddress}`,
  provider: 'aurora',
  inputAmount: '1000000',
  expectedOutputAmount: '999000',
  minOutputAmount: '990000',
  expectedFillTimeSec: 30,
  fees: { totalUsd: '0.001310' },
  transactions: [
    {
      chainId: BASE,
      to: usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [depositAddress, 1000000n] }),
      value: '0',
    },
  ],
});

const callsOf = (quote: Quote) =>
  quote.transactions.map(({ chainId, to, data, value }) => ({ chainId, to, data, value }));

describe('checkQuote with the quote as the backend sends it', () => {
  it.each([
    ['an Across quote for the same token', acrossSameToken],
    ['an Across quote that swaps USDC into WETH', acrossCrossToken],
    ['a Relay quote for an ERC-20', relayUsdc],
  ])(
    'given %s, when checked, then the approve and the deposit become the calls, in order, as the backend gave them',
    (_, answer) => {
      const quote = bodyOf(answer);

      const result = checkQuote(tenUsdc, quote);

      expect(result).toMatchObject({
        ok: true,
        quoteId: quote.quoteId,
        quote: { provider: quote.provider, minOutputAmount: quote.minOutputAmount },
      });
      if (!result.ok) return;
      const [approve, deposit] = callsOf(quote);
      expect(result.calls).toEqual([
        { kind: 'approve', ...approve },
        { kind: 'deposit', ...deposit },
      ]);
      expect(result.depositAddress).toBeUndefined();
    }
  );

  it('given a Relay quote for the native coin, when checked, then its one transaction is the deposit, value included', () => {
    const quote = bodyOf(relayNative);

    const result = checkQuote({ originChainId: BASE, originToken: zeroAddress, amount: quote.inputAmount }, quote);

    expect(result).toMatchObject({ ok: true, calls: [{ kind: 'deposit', ...callsOf(quote)[0] }] });
  });

  it('given an Aurora quote, when checked, then its transfer is the deposit and the deposit address comes from the quote id', () => {
    const quote = auroraQuote();

    const result = checkQuote({ ...tenUsdc, amount: '1000000' }, quote);

    expect(result).toMatchObject({
      ok: true,
      quoteId: `aurora:${depositAddress}`,
      depositAddress,
      calls: [{ kind: 'deposit', ...callsOf(quote)[0] }],
      quote: { provider: 'aurora', feesUsd: '0.001310' },
    });
  });
});

describe('checkQuote refusals', () => {
  it('given a body that is not a quote, when checked, then quote_invalid', () => {
    for (const body of [undefined, null, {}, { ...bodyOf(acrossSameToken), transactions: 'none' }]) {
      expect(checkQuote(tenUsdc, body)).toEqual({ ok: false, code: 'quote_invalid' });
    }
  });

  it('given a provider this server does not know, when checked, then quote_unsupported_provider', () => {
    const quote = { ...bodyOf(acrossSameToken), provider: 'lifi', quoteId: 'lifi:abc' };

    expect(checkQuote(tenUsdc, quote)).toEqual({ ok: false, code: 'quote_unsupported_provider' });
  });

  it.each([
    ['another provider', 'relay:abc'],
    ['no prefix', 'abc'],
    ['an Aurora id that is not an address', 'aurora:0x1234'],
  ])('given a quote id with %s, when checked, then quote_id', (_, quoteId) => {
    const quote = quoteId.startsWith('aurora') ? auroraQuote() : bodyOf(acrossSameToken);

    expect(checkQuote(tenUsdc, { ...quote, quoteId })).toEqual({ ok: false, code: 'quote_id' });
  });

  it('given an Across quote whose id has the across prefix but a character the id pattern refuses, when checked, then quote_id', () => {
    const quote = { ...bodyOf(acrossSameToken), quoteId: 'across:84z7t_1792622110214' };

    expect(checkQuote(tenUsdc, quote)).toEqual({ ok: false, code: 'quote_id' });
  });

  it('given an Across quote whose id is a well-formed Relay id, when checked, then quote_id', () => {
    const quote = { ...bodyOf(acrossSameToken), quoteId: bodyOf(relayUsdc).quoteId };

    expect(checkQuote(tenUsdc, quote)).toEqual({ ok: false, code: 'quote_id' });
  });

  it.each([
    ['no transaction', (q: Quote) => (q.transactions = [])],
    ['three transactions', (q: Quote) => q.transactions.push(q.transactions[1])],
    ['a first transaction that is not an approve', (q: Quote) => (q.transactions[0] = q.transactions[1])],
    ['transactions on two chains', (q: Quote) => (q.transactions[1].chainId = 42161)],
  ])('given %s, when checked, then tx_calls', (_, tamper) => {
    const quote = bodyOf(acrossSameToken);
    tamper(quote);

    expect(checkQuote(tenUsdc, quote)).toEqual({ ok: false, code: 'tx_calls' });
  });

  it('given transactions on a chain other than the origin, when checked, then tx_chain', () => {
    expect(checkQuote({ ...tenUsdc, originChainId: 42161 }, bodyOf(acrossSameToken))).toEqual({
      ok: false,
      code: 'tx_chain',
    });
  });

  it('given a quote for another amount than the one asked, when checked, then input_amount', () => {
    expect(checkQuote({ ...tenUsdc, amount: '10000001' }, bodyOf(acrossSameToken))).toEqual({
      ok: false,
      code: 'input_amount',
    });
  });

  it('given an approve on another token than the origin token, when checked, then approve_token', () => {
    const other = { ...tenUsdc, originToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' };

    expect(checkQuote(other, bodyOf(acrossSameToken))).toEqual({ ok: false, code: 'approve_token' });
  });

  it('given a native origin and a quote with an approve, when checked, then approve_token', () => {
    expect(checkQuote({ ...tenUsdc, originToken: zeroAddress }, bodyOf(acrossSameToken))).toEqual({
      ok: false,
      code: 'approve_token',
    });
  });

  it('given an approve whose spender is not the deposit contract, when checked, then approve_spender', () => {
    const quote = bodyOf(acrossSameToken);
    const deposit = quote.transactions[1].to.slice(2).toLowerCase();
    quote.transactions[0].data = quote.transactions[0].data.replace(deposit, '3'.repeat(40));

    expect(checkQuote(tenUsdc, quote)).toEqual({ ok: false, code: 'approve_spender' });
  });
});
