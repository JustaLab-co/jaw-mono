import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

vi.mock('../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../hooks/useDecodedCalldata', () => ({
  useDecodedCalldata: () => ({ clearSigned: null, decoded: null, isLoading: false }),
}));
vi.mock('./ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { TransactionDialog } from './TransactionDialog';
import { PermissionDialog } from './PermissionDialog';
import { INSUFFICIENT_FUNDS_ERROR } from '../utils/transactionFailure';

const ALICE = '0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b';
const SPENDER = '0x1111111111111111111111111111111111111111';

/** The button with that label, or undefined when there is none. */
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
const DISABLED = / disabled=""/;

type Loading = 'gasFeeLoading' | 'isLoadingTokenInfo' | 'prefundLoading';
type Block = { gasEstimationError: string; onAddFunds?: () => void } & Partial<Record<Loading, boolean>>;
const FUNDS: Block = { gasEstimationError: INSUFFICIENT_FUNDS_ERROR, onAddFunds: () => undefined };

const transaction = (block: Block) =>
  renderToStaticMarkup(
    <TransactionDialog
      open
      onOpenChange={() => undefined}
      transactions={[{ to: SPENDER, value: '0x1', chainId: 84532 }]}
      walletAddress={ALICE}
      gasFee="0"
      gasFeeLoading={false}
      sponsored={false}
      onConfirm={async () => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      networkName="Base Sepolia"
      mainnetRpcUrl=""
      {...block}
    />
  );

const permission = (mode: 'grant' | 'revoke') => (block: Block) =>
  renderToStaticMarkup(
    <PermissionDialog
      open
      onOpenChange={() => undefined}
      mode={mode}
      spenderAddress={SPENDER}
      accountAddress={ALICE}
      origin="https://app.example"
      calls={[{ target: SPENDER, selector: '0xa9059cbb', functionSignature: 'transfer(address,uint256)' }]}
      expiryDate=""
      networkName="Base Sepolia"
      chainId={84532}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      gasFee="0"
      mainnetRpcUrl=""
      {...block}
    />
  );

const PERMISSION_LOADING: Loading[] = ['gasFeeLoading', 'isLoadingTokenInfo'];

describe.each([
  ['a transaction', transaction, 'Confirm', ['gasFeeLoading'] as Loading[]],
  ['a grant', permission('grant'), 'Grant', [...PERMISSION_LOADING, 'prefundLoading'] as Loading[]],
  ['a revoke', permission('revoke'), 'Revoke', PERMISSION_LOADING],
])('the primary button of %s', (_, render, confirm, loading) => {
  it('Given a funds block and onAddFunds, When it renders, Then it reads "Add funds" and is enabled', () => {
    const add = button(render(FUNDS), 'Add funds');

    expect(add).toBeDefined();
    expect(add).not.toMatch(DISABLED);
  });

  it.each(loading)(
    'Given a funds block while %s, When it renders, Then it stays the disabled "Insufficient Funds"',
    (flag) => {
      const html = render({ ...FUNDS, [flag]: true });

      expect(button(html, 'Add funds')).toBeUndefined();
      expect(button(html, 'Insufficient Funds')).toMatch(DISABLED);
    }
  );

  it('Given a will-fail block, When it renders, Then it does not offer Add funds', () => {
    const html = render({ gasEstimationError: 'execution reverted', onAddFunds: () => undefined });

    expect(button(html, 'Add funds')).toBeUndefined();
    expect(button(html, confirm)).toMatch(DISABLED);
  });

  it('Given no block, When it renders, Then it reads as today', () => {
    const html = render({ gasEstimationError: '', onAddFunds: () => undefined });

    expect(button(html, 'Add funds')).toBeUndefined();
    expect(button(html, confirm)).toBeDefined();
  });

  it('Given a funds block without onAddFunds, When it renders, Then it stays the disabled "Insufficient Funds"', () => {
    const html = render({ gasEstimationError: INSUFFICIENT_FUNDS_ERROR });

    expect(button(html, 'Add funds')).toBeUndefined();
    expect(button(html, 'Insufficient Funds')).toMatch(DISABLED);
  });
});
