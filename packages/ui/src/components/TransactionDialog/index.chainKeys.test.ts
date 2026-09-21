// @vitest-environment jsdom
// The dialog resolves one name per address and chain and hands both maps to every row.
// Filed by address alone, a batch carrying the same `to` on two chains collapsed the two
// answers onto one entry and rendered whichever landed last on both rows, one of them
// under the other chain's label. This pins the write side; the read side is pinned in
// DecodedCalldata.resolution.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TO = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const MAINNET = 1;
const BASE = 8453;
const LABELS: Record<number, string> = { [MAINNET]: 'mainnet', [BASE]: 'base' };

const reverseResolveWithAvatars = vi.fn(async (inputs: { address: string; chainId: number }[]) => {
  const out: Record<string, { name: string }> = {};
  for (const { address, chainId } of inputs) {
    out[`${address.toLowerCase()}:${chainId}`] = { name: 'vitalik.eth' };
  }
  return out;
});

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  reverseResolveWithAvatars: (...args: unknown[]) =>
    (reverseResolveWithAvatars as unknown as (...a: unknown[]) => unknown)(...args),
  getChainLabel: async (chainId: number) => LABELS[chainId] ?? null,
}));

// Network-bound or purely visual pieces. Everything that decides which name lands on
// which row stays real: the effect, CallSections and PartyRow.
vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../../hooks/useDecodedCalldata', () => ({
  useDecodedCalldata: () => ({ clearSigned: null, decoded: null, isLoading: false }),
}));
vi.mock('../../utils/clearSigning', () => ({
  caip10: (chainId: number, address?: string) => `eip155:${chainId}:${address}`,
  getDefaultDescriptorSource: () => ({ getCalldataIndex: async () => new Map() }),
}));
vi.mock('../ShellDialog', () => ({
  ShellDialog: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
}));
vi.mock('../ui/accordion', () => ({
  Accordion: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  AccordionItem: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  AccordionTrigger: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  AccordionContent: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
}));
vi.mock('../ProcessingScreen', () => ({ ProcessingScreen: () => null }));
vi.mock('./AssetPreview', () => ({ AssetPreview: () => null }));
vi.mock('../NetworkFeeRow', () => ({ NetworkFeeRow: () => null }));
vi.mock('../TokenIcon', () => ({ TokenIcon: () => null }));
vi.mock('../IdentityAvatar', () => ({ IdentityAvatar: () => null }));
vi.mock('../AppAvatar', () => ({ AppAvatar: () => null }));

import { TransactionDialog } from './index';

const props = {
  open: true,
  onOpenChange: () => undefined,
  transactions: [
    { to: TO, value: '0x1', chainId: MAINNET },
    { to: TO, value: '0x1', chainId: BASE },
  ],
  walletAddress: '0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b',
  gasFee: '0',
  gasFeeLoading: false,
  gasEstimationError: '',
  sponsored: true,
  onConfirm: async () => undefined,
  onCancel: () => undefined,
  isProcessing: false,
  networkName: 'Ethereum',
  mainnetRpcUrl: 'https://rpc.test/mainnet',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  reverseResolveWithAvatars.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Flush the effect's promise chain (resolve -> getChainLabel -> setState). */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TransactionDialog files names by address and chain', () => {
  it('shows each row the name read on its own chain', async () => {
    await act(async () => {
      root.render(createElement(TransactionDialog, props));
    });
    await settle();

    expect(container.textContent).toContain('vitalik.eth@mainnet');
    expect(container.textContent).toContain('vitalik.eth@base');
  });

  it('asks for the address once per chain', async () => {
    await act(async () => {
      root.render(createElement(TransactionDialog, props));
    });
    await settle();

    const inputs = reverseResolveWithAvatars.mock.calls[0][0] as { address: string; chainId: number }[];
    expect(inputs.filter((i) => i.address === TO).map((i) => i.chainId)).toEqual([MAINNET, BASE]);
  });
});
