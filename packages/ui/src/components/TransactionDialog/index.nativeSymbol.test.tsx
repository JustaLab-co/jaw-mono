// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

const priced = vi.hoisted(() => vi.fn<(symbol?: string) => number>(() => 0));
vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: priced }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { TransactionDialog } from './index';

const PAYMASTER = '0xcCE758d01775d6c9fc822A4e33B70f019DBDc963';

// The deposit on Polygon: 0.1 POL sent, no native entry in the fee-token list, and a chain
// object from the dapp without nativeCurrency. This showed "0.1 ETH" at ETH's price.
const render = (chainId: number) =>
  renderToStaticMarkup(
    <TransactionDialog
      open
      onOpenChange={() => undefined}
      transactions={[{ to: PAYMASTER, value: '0x16345785d8a0000', data: '0xd0e30db0', chainId }]}
      walletAddress="0xd5d2000000000000000000000000000000007691"
      gasFee="0.1929"
      gasFeeLoading={false}
      gasEstimationError=""
      sponsored={false}
      feeTokens={[]}
      onConfirm={async () => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      networkName="Polygon"
    />
  );

describe("TransactionDialog's native coin", () => {
  beforeEach(() => priced.mockClear());

  it("labels and prices Polygon's coin as POL when nothing else names it", () => {
    const html = render(137);

    expect(html).toContain('POL');
    expect(html).not.toMatch(/\bETH\b/);
    expect(priced).toHaveBeenCalledWith('POL');
    expect(priced).not.toHaveBeenCalledWith('ETH');
  });

  it('asks for no price on a chain whose coin it cannot name, rather than pricing it as ETH', () => {
    const html = render(999_999);

    expect(html).not.toMatch(/\bETH\b/);
    expect(priced).not.toHaveBeenCalledWith('ETH');
    expect(priced).toHaveBeenCalledWith(undefined);
  });
});
