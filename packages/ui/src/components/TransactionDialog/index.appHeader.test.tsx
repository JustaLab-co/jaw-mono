import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../../hooks/useDecodedCalldata', () => ({
  useDecodedCalldata: () => ({ clearSigned: null, decoded: null, isLoading: false }),
}));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { TransactionDialog } from './index';

const render = (extra: { appName?: string; origin?: string }) =>
  renderToStaticMarkup(
    <TransactionDialog
      open
      onOpenChange={() => undefined}
      transactions={[{ to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', value: '0x1', chainId: 84532 }]}
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

describe('TransactionDialog app header', () => {
  it('names the requesting app and its host', () => {
    const html = render({ appName: 'Claude (via JAW MCP)', origin: 'https://mcp.jaw.id' });
    expect(html).toContain('Claude (via JAW MCP)');
    expect(html).toContain('mcp.jaw.id');
  });

  it('shows no header without an app name', () => {
    const html = render({ origin: 'https://mcp.jaw.id' });
    expect(html).not.toContain('mcp.jaw.id');
  });

  it('shows no header without an origin', () => {
    const html = render({ appName: 'Claude (via JAW MCP)' });
    expect(html).not.toContain('Claude (via JAW MCP)');
  });
});
