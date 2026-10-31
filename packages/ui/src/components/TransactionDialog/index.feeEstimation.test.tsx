// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { TransactionDialog } from './index';
import { INSUFFICIENT_FUNDS_ERROR } from '../../utils/transactionFailure';
import type { FeeTokenOption } from '../FeeTokenSelector';

const eth = (balance: bigint): FeeTokenOption => ({
  uid: 'eth',
  symbol: 'ETH',
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  decimals: 18,
  balance,
  balanceFormatted: '0',
  isNative: true,
  // The producer offers native whenever it holds any balance.
  isSelectable: balance > 0n,
});

const usdc = (over: Partial<FeeTokenOption> = {}): FeeTokenOption => ({
  uid: 'usdc',
  symbol: 'USDC',
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  decimals: 6,
  balance: 10_000_000n,
  balanceFormatted: '10',
  isNative: false,
  isSelectable: false,
  ...over,
});

const render = (feeTokens: FeeTokenOption[], onRetryEstimation?: () => void) =>
  renderToStaticMarkup(
    <TransactionDialog
      open
      onOpenChange={() => undefined}
      transactions={[{ to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', value: '0x1', chainId: 8453 }]}
      walletAddress="0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b"
      gasFee=""
      gasFeeLoading={false}
      gasEstimationError={INSUFFICIENT_FUNDS_ERROR}
      sponsored={false}
      feeTokens={feeTokens}
      onRetryEstimation={onRetryEstimation}
      onConfirm={async () => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      networkName="Base"
    />
  );

describe('TransactionDialog fee estimation failure', () => {
  it('does not claim insufficient funds when a funded token failed to estimate', () => {
    const html = render([
      eth(0n),
      usdc({ gasCostFormatted: 'Estimation failed', estimationFailure: 'execution reverted' }),
    ]);
    expect(html).not.toContain('Insufficient');
    expect(html).toContain('Fee estimation failed');
  });

  it('does not claim insufficient funds when ETH is dust and a funded token failed to estimate', () => {
    // A few wei make ETH selectable, but its leg still ends in a prefund shortfall.
    const html = render([
      eth(5n),
      usdc({ gasCostFormatted: 'Estimation failed', estimationFailure: 'execution reverted' }),
    ]);
    expect(html).not.toContain('Insufficient');
    expect(html).toContain('Fee estimation failed');
  });

  it('offers a retry when the caller can re-run the estimation', () => {
    const failed = [eth(0n), usdc({ gasCostFormatted: 'Estimation failed', estimationFailure: 'reverted' })];
    expect(render(failed, () => undefined)).toContain('Retry');
    expect(render(failed)).not.toContain('Retry');
  });

  it('still says insufficient funds when ETH and USDC are both empty', () => {
    const html = render([eth(0n), usdc({ balance: 0n, balanceFormatted: '0' })]);
    expect(html).toContain('Insufficient funds');
    expect(html).not.toContain('Fee estimation failed');
  });

  it('still says insufficient funds on a prefund shortfall', () => {
    const html = render([eth(0n), usdc({ gasCostFormatted: 'Insufficient' })]);
    expect(html).toContain('Insufficient funds');
  });
});
