import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../../hooks/useDecodedCalldata', () => ({
  useDecodedCalldata: () => ({ clearSigned: null, decoded: null, isLoading: false }),
}));
// The token read itself is covered in AllowancePreview.token.test.
vi.mock('../../hooks/useApprovalTokenKind', () => ({ useApprovalTokenKind: () => ({ status: 'unknown' }) }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { TransactionDialog } from './index';
import type { AssetDelta } from '../../utils/assetPreview';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';
const EOA = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const approve5 = `0x095ea7b3${SPENDER.slice(2).padStart(64, '0')}${(5_000_000).toString(16).padStart(64, '0')}`;
const approveMax = `0x095ea7b3${SPENDER.slice(2).padStart(64, '0')}${'f'.repeat(64)}`;

const usdc = (direction: 'in' | 'out'): AssetDelta => ({
  address: TOKEN.toLowerCase(),
  symbol: 'USDC',
  decimals: 6,
  diff: 1n,
  direction,
  amountFormatted: '1',
  isNative: false,
});
const eth: AssetDelta = {
  address: '0x0000000000000000000000000000000000000000',
  symbol: 'ETH',
  decimals: 18,
  diff: -1n,
  direction: 'out',
  amountFormatted: '0.001',
  isNative: true,
};

type Extra = Partial<Parameters<typeof TransactionDialog>[0]>;
const render = (extra: Extra, transactions = [{ to: TOKEN, data: approve5, chainId: 84532 }]) =>
  renderToStaticMarkup(
    <TransactionDialog
      open
      onOpenChange={() => undefined}
      transactions={transactions}
      walletAddress="0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b"
      gasFee="0"
      gasFeeLoading={false}
      gasEstimationError=""
      sponsored
      onConfirm={async () => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      networkName="Base Sepolia"
      {...extra}
    />
  );

describe('TransactionDialog wiring', () => {
  it('the approval icon is looked up on the chain of the first call', () => {
    expect(render({}, [{ to: TOKEN, data: approveMax, chainId: 84532 }])).toContain('/tokens/84532/');
  });

  it('under a permission the balance columns say Sends and Receives', () => {
    const out = render({ assetsOut: [usdc('out')], onBehalfOf: SPENDER });
    expect(out).toContain('Sends');
    expect(out).not.toContain('You send');
  });

  it('a plain native send shows no balance columns, any other call does', () => {
    const send = render({ assetsOut: [eth] }, [{ to: EOA, value: '0x1', chainId: 84532 }]);
    expect(send).not.toContain('You send');
    expect(send).toContain('You&#x27;re Sending');
    expect(render({ assetsOut: [usdc('out')] })).toContain('You send');
  });

  it('while processing, the app logo stands on the flow', () => {
    const out = render({
      isProcessing: true,
      appName: 'Claude (via JAW MCP)',
      appLogoUrl: 'https://logo.example/app.png',
    });
    expect(out).toContain('src="https://logo.example/app.png"');
    expect(out).toContain('Submitting transaction');
  });
});
