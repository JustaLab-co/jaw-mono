import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { NetworkFeeRow } from './index';
import type { FeeTokenOption } from '../FeeTokenSelector';

/**
 * The ERC-20 fee slot. useGasEstimation overloads `gasCostFormatted`: a numeric amount on
 * success, `undefined` while in flight, and a sentinel string or required amount when the token
 * can't pay. A re-estimate can put an unpayable token in the selection, where blockReason stays
 * null and Confirm is disabled with no banner — so the slot itself must say why, never a fee
 * figure or an "Estimating..." that can't resolve.
 */
describe('NetworkFeeRow — ERC-20 fee slot', () => {
  const usdc = (overrides: Partial<FeeTokenOption> = {}): FeeTokenOption => ({
    uid: 'usdc',
    symbol: 'USDC',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    balance: 5_000_000n,
    balanceFormatted: '5.00',
    isNative: false,
    isSelectable: false,
    ...overrides,
  });

  const markup = (selectedFeeToken: FeeTokenOption) =>
    renderToStaticMarkup(
      <NetworkFeeRow
        blockReason={null}
        nativeSymbol="ETH"
        nativeTokenPrice={0}
        hasSelectablePaymentOption
        isPayingWithErc20
        selectedFeeToken={selectedFeeToken}
      />
    );

  it("renders the 'Estimation failed' sentinel as a warning, not a fee and not a spinner", () => {
    const html = markup(usdc({ gasCostFormatted: 'Estimation failed', gasCostMaxFormatted: undefined }));
    expect(html).not.toContain('Estimation failed USDC');
    expect(html).not.toContain('Estimating');
    expect(html).toContain('Estimation failed');
    expect(html).toContain('text-destructive');
  });

  it("renders the 'Insufficient' sentinel as an insufficient-funds warning", () => {
    const html = markup(usdc({ gasCostFormatted: 'Insufficient', gasCostMaxFormatted: undefined }));
    expect(html).not.toContain('Insufficient USDC');
    expect(html).not.toContain('Estimating');
    expect(html).toContain('Insufficient funds');
  });

  it("renders the amount parsed from an 'X required but sender has Y' error as a warning, not a fee", () => {
    const html = markup(usdc({ gasCostFormatted: '1.25', gasCostMaxFormatted: undefined }));
    expect(html).toContain('Insufficient funds');
    // The amount belongs in the tooltip detail (closed in static markup), never the fee slot.
    expect(html).not.toContain('1.25 USDC');
    expect(html).not.toContain('Up to');
    expect(html).not.toContain('Estimating');
  });

  it('renders a priced token whose balance cannot cover the ceiling as a warning, not a payable fee', () => {
    // A successful estimate can report hasSufficientBalance false: real cost and ceiling,
    // isSelectable false. A ceiling-only gate would render this as a normal, payable fee.
    const html = markup(usdc({ gasCostFormatted: '0.0421', gasCostMaxFormatted: '0.0512', isSelectable: false }));
    expect(html).toContain('Insufficient funds');
    expect(html).not.toContain('0.0421 USDC');
    expect(html).not.toContain('Up to');
    expect(html).not.toContain('Estimating');
  });

  it('says the batch spends a selected token it uses, matching the picker, not insufficient funds', () => {
    // 10 USDC held covers a 0.05 USDC fee, but the batch sends most of it away.
    const html = markup(
      usdc({
        balance: 10_000_000n,
        balanceFormatted: '10.00',
        gasCostFormatted: '0.05',
        gasCostMaxFormatted: '0.0625',
        isSelectable: false,
        usedByTransaction: true,
      })
    );
    expect(html).toContain('Used by this transaction');
    expect(html).not.toContain('Insufficient funds');
    expect(html).not.toContain('Up to');
  });

  it('still shows Estimating... while the estimate is genuinely in flight (undefined, selectable)', () => {
    const html = markup(usdc({ gasCostFormatted: undefined, gasCostMaxFormatted: undefined, isSelectable: true }));
    expect(html).toContain('Estimating');
    expect(html).not.toContain('text-destructive');
  });

  it('renders a settled zero-balance token as a warning, not a spinner that cannot resolve', () => {
    // All three zero-balance legs of useGasEstimation emit this exact state: both fee fields
    // undefined, isSelectable false. It is a verdict, not an estimate in flight.
    const html = markup(usdc({ gasCostFormatted: undefined, gasCostMaxFormatted: undefined, isSelectable: false }));
    expect(html).toContain('Insufficient funds');
    expect(html).not.toContain('Estimating');
  });

  it('renders a numeric cost with its ceiling, unchanged', () => {
    const html = markup(usdc({ gasCostFormatted: '0.0421', gasCostMaxFormatted: '0.0512', isSelectable: true }));
    expect(html).toContain('0.0421 USDC');
    expect(html).toContain('Up to 0.0512 USDC');
    expect(html).not.toContain('Estimating');
    expect(html).not.toContain('text-destructive');
  });

  // Paymaster rates at ETH = $3,000 with its 10% markup in both (see utils/feeCost.test.ts).
  const NATIVE_TO_USD = 3_300_000_000n;

  it('shows a quoted ERC-20 fee in dollars, like a native fee, with its ceiling', () => {
    const vvv = usdc({
      symbol: 'VVV',
      decimals: 18,
      isSelectable: true,
      gasCostFormatted: '0.0010',
      gasCostMaxFormatted: '0.0030',
      gasCost: 10n ** 15n,
      gasCostMax: 3n * 10n ** 15n,
      // VVV at $3: 0.001 VVV is $0.003.
      exchangeRate: 1_100n * 10n ** 18n,
      exchangeRateNativeToUsd: NATIVE_TO_USD,
    });
    // No native price: an ERC-20 fee is priced from its quote alone.
    const html = markup(vvv);
    expect(html).toContain('$0.0030');
    expect(html).toContain('≈ 0.001 VVV');
    expect(html).toContain('Up to 0.003 VVV');
  });

  it('prices a USDC fee at the USDC charged, not divided by the markup', () => {
    // The review's example: 0.01089 USDC charged is about $0.0109, not $0.0099.
    const html = markup(
      usdc({
        isSelectable: true,
        gasCostFormatted: '0.0109',
        gasCostMaxFormatted: '0.0200',
        gasCost: 10_890n,
        gasCostMax: 20_000n,
        exchangeRate: 3_300_000_000n,
        exchangeRateNativeToUsd: NATIVE_TO_USD,
      })
    );
    expect(html).toContain('$0.0109');
    expect(html).toContain('≈ 0.01089 USDC');
  });

  it('shows a dust ERC-20 fee in subscript notation, never as 0.0000', () => {
    const weth = usdc({
      symbol: 'WETH',
      decimals: 18,
      isSelectable: true,
      // core preformats both as "0.0000"
      gasCostFormatted: '0.0000',
      gasCostMaxFormatted: '0.0000',
      gasCost: 1_200_000_000_000n,
      gasCostMax: 2_270_000_000_000n,
      exchangeRate: 1_100_000_000_000_000_000n,
      exchangeRateNativeToUsd: NATIVE_TO_USD,
    });
    const html = markup(weth);
    expect(html).not.toContain('0.0000');
    expect(html).toMatch(/0\.0<sub[^>]*>5<\/sub>12 WETH/);
    expect(html).toMatch(/Up to 0\.0<sub[^>]*>5<\/sub>227 WETH/);
  });

  it('never shows an "Up to" line alongside a sentinel (the ceiling would be the sentinel itself)', () => {
    const html = markup(usdc({ gasCostFormatted: 'Estimation failed', gasCostMaxFormatted: undefined }));
    expect(html).not.toContain('Up to');
  });
});
