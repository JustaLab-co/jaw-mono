// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useBridgeContracts', () => ({ useBridgeContracts: () => ({ contracts: {}, settled: true }) }));
vi.mock('../../hooks/useBridgeBatch', () => ({ useBridgeBatch: () => ({ bridge: undefined, settled: true }) }));
vi.mock('../../hooks/useAddressIdentities', () => ({
  useAddressIdentity: () => ({}),
  useAddressIdentities: () => ({}),
}));
vi.mock('../../hooks/useReverseIdentity', () => ({ useReverseIdentity: () => ({}) }));
vi.mock('../../hooks/useDecodedCalldata', () => ({ useDecodedCalldata: () => undefined }));

import { TransactionDialog } from './index';
import { INSUFFICIENT_FUNDS_ERROR } from '../../utils/transactionFailure';
import type { FeeTokenOption } from '../FeeTokenSelector';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const eth = (balance: bigint): FeeTokenOption => ({
  uid: 'eth',
  symbol: 'ETH',
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  decimals: 18,
  balance,
  balanceFormatted: '0',
  isNative: true,
  isSelectable: balance > 0n,
});

let root: Root | null = null;

async function renderConfirm(over: { gasFeeLoading?: boolean; estimatingTokenCosts?: boolean; funded?: boolean }) {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <TransactionDialog
        open
        onOpenChange={() => undefined}
        transactions={[{ to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', value: '0x1', chainId: 8453 }]}
        walletAddress="0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b"
        gasFee=""
        gasFeeLoading={over.gasFeeLoading ?? false}
        gasEstimationError={over.funded ? '' : INSUFFICIENT_FUNDS_ERROR}
        sponsored={false}
        feeTokens={[eth(over.funded ? 1_000_000_000_000_000n : 0n)]}
        estimatingTokenCosts={over.estimatingTokenCosts ?? false}
        onConfirm={async () => undefined}
        onCancel={() => undefined}
        isProcessing={false}
        networkName="Base"
        mainnetRpcUrl="https://mainnet.example"
      />
    )
  );
  // The primary action is the last button: Cancel comes first.
  return [...container.querySelectorAll('button')].at(-1)!;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('TransactionDialog Confirm while the fee is estimating', () => {
  it('enables Confirm once a funded fee has settled', async () => {
    const confirm = await renderConfirm({ funded: true });

    expect(confirm.textContent).toBe('Confirm');
    expect(confirm.disabled).toBe(false);
  });

  it('holds Confirm while gas loads', async () => {
    const confirm = await renderConfirm({ funded: true, gasFeeLoading: true });

    expect(confirm.disabled).toBe(true);
  });

  it('holds Confirm while the fee-token costs load', async () => {
    const confirm = await renderConfirm({ funded: true, estimatingTokenCosts: true });

    expect(confirm.disabled).toBe(true);
  });

  it('holds Confirm without calling the shortfall final while the estimate is pending', async () => {
    const confirm = await renderConfirm({ gasFeeLoading: true });

    expect(confirm.textContent).toBe('Confirm');
    expect(confirm.disabled).toBe(true);
  });

  it('reads Insufficient Funds once the shortfall is settled', async () => {
    const confirm = await renderConfirm({});

    expect(confirm.textContent).toBe('Insufficient Funds');
    expect(confirm.disabled).toBe(true);
  });
});
