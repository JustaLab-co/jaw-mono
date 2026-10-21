import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { maxUint256 } from 'viem';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../../hooks/useDecodedCalldata', () => ({
  useDecodedCalldata: () => ({ clearSigned: null, decoded: null, isLoading: false }),
}));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { TransactionDialog } from './index';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';
const approveMax = `0x095ea7b3${SPENDER.slice(2).padStart(64, '0')}${maxUint256.toString(16)}`;

const render = (data: string[]) =>
  renderToStaticMarkup(
    <TransactionDialog
      open
      onOpenChange={() => undefined}
      transactions={[
        { to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', value: '0x1', chainId: 84532 },
        ...data.map((d) => ({ to: TOKEN, data: d, chainId: 84532 })),
      ]}
      walletAddress="0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b"
      gasFee="0"
      gasFeeLoading={false}
      gasEstimationError=""
      sponsored
      onConfirm={async () => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      networkName="Base Sepolia"
    />
  );

describe('TransactionDialog allowances', () => {
  // A token approval in the batch is one of its calls, listed with the others. It gets no card of
  // its own: one titled "Permissions granted" read as a JAW permission, which an approval is not.
  it('gives an approve in the batch no card of its own', () => {
    const html = render([approveMax]);
    expect(html).not.toContain('Permissions granted');
    expect(html).not.toContain('Unlimited');
  });
});
