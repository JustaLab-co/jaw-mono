// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useAddressIdentities', () => ({ useAddressIdentities: () => ({}) }));

import { PermissionDialog } from './index';
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

const usdc = (isSelectable: boolean): FeeTokenOption => ({
  uid: 'usdc',
  symbol: 'USDC',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  balance: 10_000_000n,
  balanceFormatted: '10',
  isNative: false,
  isSelectable,
  gasCostFormatted: '0.02',
  gasCostMaxFormatted: '0.05',
});

let root: Root | null = null;

async function renderGrant(over: {
  gasFeeLoading?: boolean;
  estimatingTokenCosts?: boolean;
  funded?: boolean;
  feeToken?: FeeTokenOption;
}) {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <PermissionDialog
        open
        onOpenChange={() => undefined}
        mode="grant"
        spenderAddress="0x2222222222222222222222222222222222222222"
        origin="https://dapp.example"
        calls={[
          {
            target: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            selector: '0xa9059cbb',
            functionSignature: 'transfer(address,uint256)',
          },
        ]}
        expiryDate="11/19/2026"
        networkName="Base"
        chainId={8453}
        mainnetRpcUrl="https://mainnet.example"
        onConfirm={() => undefined}
        onCancel={() => undefined}
        isProcessing={false}
        gasFee=""
        gasFeeLoading={over.gasFeeLoading ?? false}
        gasEstimationError={over.funded ? '' : INSUFFICIENT_FUNDS_ERROR}
        estimatingTokenCosts={over.estimatingTokenCosts ?? false}
        feeTokens={[eth(over.funded ? 1_000_000_000_000_000n : 0n), ...(over.feeToken ? [over.feeToken] : [])]}
        selectedFeeToken={over.feeToken}
        isPayingWithErc20={!!over.feeToken}
      />
    )
  );
  return [...container.querySelectorAll('button')].at(-1)!;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('PermissionDialog Grant while the fee is estimating', () => {
  it('enables Grant once a funded fee has settled', async () => {
    const grant = await renderGrant({ funded: true });

    expect(grant.textContent).toBe('Grant');
    expect(grant.disabled).toBe(false);
  });

  it('holds Grant while gas loads', async () => {
    const grant = await renderGrant({ funded: true, gasFeeLoading: true });

    expect(grant.disabled).toBe(true);
  });

  it('holds Grant while the fee-token costs load', async () => {
    const grant = await renderGrant({ funded: true, estimatingTokenCosts: true });

    expect(grant.disabled).toBe(true);
  });

  it('holds Grant without calling the shortfall final while the estimate is pending', async () => {
    const grant = await renderGrant({ gasFeeLoading: true });

    expect(grant.textContent).toBe('Grant');
    expect(grant.disabled).toBe(true);
  });

  it('does not call the shortfall final while the fee-token costs load', async () => {
    const grant = await renderGrant({ estimatingTokenCosts: true });

    expect(grant.textContent).not.toBe('Insufficient Funds');
    expect(grant.disabled).toBe(true);
  });

  it('reads Insufficient Funds once the shortfall is settled', async () => {
    const grant = await renderGrant({});

    expect(grant.textContent).toBe('Insufficient Funds');
    expect(grant.disabled).toBe(true);
  });

  it('enables Grant with a selected ERC-20 fee the account can pay', async () => {
    const grant = await renderGrant({ funded: true, feeToken: usdc(true) });

    expect(grant.disabled).toBe(false);
  });

  it('holds Grant on a selected ERC-20 fee that is no longer payable', async () => {
    const grant = await renderGrant({ funded: true, feeToken: usdc(false) });

    expect(grant.disabled).toBe(true);
  });
});
