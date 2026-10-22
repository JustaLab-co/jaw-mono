import { describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { checkQuote, type CheckDeps, type QuoteRequest } from './check';
import { checkAcross } from './check/across';
import { checkRelay } from './check/relay';

vi.mock('./check/across', () => ({ checkAcross: vi.fn(() => ({ ok: false, code: 'quote_id' })) }));
vi.mock('./check/relay', () => ({ checkRelay: vi.fn(async () => ({ ok: false, code: 'quote_id' })) }));

const request: QuoteRequest = {
  originChainId: 8453,
  originToken: zeroAddress,
  amount: '1000',
  account: zeroAddress,
  destinationChainId: 42161,
  destinationToken: zeroAddress,
  recipient: zeroAddress,
};

const bodyOf = (provider: string) => ({
  quoteId: `${provider}:x`,
  provider,
  inputAmount: '1000',
  expectedOutputAmount: '990',
  minOutputAmount: '980',
  expectedFillTimeSec: 2,
  fees: {},
  transactions: [],
});

const deps: CheckDeps = {
  isDepositAddressTaken: async () => false,
  isOrderTaken: async () => false,
  now: () => 1_792_676_780,
  ownerWindowSec: 137,
};

describe('checkQuote dispatch', () => {
  it('given an Across quote, when checked, then the Across check gets the owner window and the clock in seconds', async () => {
    await checkQuote(request, bodyOf('across'), deps);

    expect(checkAcross).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ provider: 'across' }),
      1_792_676_780,
      137
    );
  });

  it('given a Relay quote, when checked, then the Relay check gets the same deps, owner window included', async () => {
    await checkQuote(request, bodyOf('relay'), deps);

    expect(checkRelay).toHaveBeenCalledWith(request, expect.objectContaining({ provider: 'relay' }), deps);
  });
});
