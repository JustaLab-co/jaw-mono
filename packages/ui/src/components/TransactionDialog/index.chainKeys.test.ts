// @vitest-environment jsdom
// Every row names its address on the chain it is drawn for. Filed by address alone, a
// batch carrying the same `to` on two chains collapsed the two answers onto one entry and
// rendered whichever landed last on both rows, one of them under the other chain's label.
// The calldata rows are pinned in DecodedCalldata.resolution.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toCoinType } from 'viem';

import { clearAddressIdentityCache } from '../../utils/addressIdentity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TO = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const MAINNET = 1;
const BASE = 8453;
const LABELS: Record<number, string> = { [MAINNET]: 'mainnet', [BASE]: 'base' };

vi.mock('../../utils/resolveChainLabel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/resolveChainLabel')>()),
  getChainLabel: async (chainId: number) => LABELS[chainId] ?? null,
}));

/** Answer every reverse lookup with the same name, and record what was asked. */
function stubNetwork() {
  const ensRequests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.startsWith('/ens/v2/reverse')) return new Response('{}', { status: 200 });
      ensRequests.push(url);
      const data = url.searchParams.getAll('address').map((param) => {
        const [address, chainId] = param.split('@eip155:');
        return { address: address.toLowerCase(), name: 'vitalik.eth', coinType: Number(toCoinType(Number(chainId))) };
      });
      return new Response(JSON.stringify({ result: { data } }), { status: 200 });
    })
  );
  return ensRequests;
}

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

let ensRequests: URL[];

beforeEach(() => {
  clearAddressIdentityCache();
  ensRequests = stubNetwork();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Let the lookups answer and the resulting renders land. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
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

    expect(ensRequests).toHaveLength(1);
    const asked = ensRequests[0].searchParams.getAll('address');
    expect(asked.filter((a) => a.startsWith(TO))).toEqual([`${TO}@eip155:${MAINNET}`, `${TO}@eip155:${BASE}`]);
  });
});
