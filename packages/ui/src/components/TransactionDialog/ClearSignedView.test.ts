// @vitest-environment jsdom
// Address rows of a clear-signed call are named through the shared identity hook, on the
// call's chain. The copy button keeps the raw address whatever name is shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toCoinType } from 'viem';

import { clearAddressIdentityCache } from '../../utils/addressIdentity';
import type { ClearSigningDisplay } from '../../utils/clearSigning';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPENDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BASE = 8453;

vi.mock('../../utils/resolveChainLabel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/resolveChainLabel')>()),
  getChainLabel: async (chainId: number) => (chainId === BASE ? 'base' : null),
}));
vi.mock('../TokenIcon', () => ({ TokenIcon: () => null }));
vi.mock('../IdentityAvatar', () => ({ IdentityAvatar: () => null }));
vi.mock('../CopyButton', () => ({ CopyButton: () => null }));

import { ClearSignedView } from './ClearSignedView';

const display: ClearSigningDisplay = {
  intent: 'Approve',
  rows: [{ label: 'Spender', value: SPENDER, rawValue: SPENDER, kind: 'address' }],
};

let container: HTMLDivElement;
let root: Root;
let ensRequests: URL[];

beforeEach(() => {
  clearAddressIdentityCache();
  ensRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      ensRequests.push(url);
      const data = url.searchParams.getAll('address').map((param) => {
        const [address, chainId] = param.split('@eip155:');
        return { address: address.toLowerCase(), name: 'spender.eth', coinType: Number(toCoinType(Number(chainId))) };
      });
      return new Response(JSON.stringify({ result: { data } }), { status: 200 });
    })
  );
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('ClearSignedView address rows', () => {
  it('names the address on the call chain', async () => {
    await act(async () => {
      root.render(
        createElement(ClearSignedView, { display, chainId: BASE, mainnetRpcUrl: 'https://rpc.test/mainnet' })
      );
    });
    await settle();

    expect(container.textContent).toContain('spender.eth@base');
    expect(ensRequests).toHaveLength(1);
    expect(ensRequests[0].searchParams.getAll('address')).toEqual([`${SPENDER}@eip155:${BASE}`]);
  });
});

describe('ClearSignedView date rows', () => {
  const twoDaysAgo = String(Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60);
  const PAST = 'This date is in the past.';

  async function rowsShown(rows: ClearSigningDisplay['rows']) {
    await act(async () => {
      root.render(createElement(ClearSignedView, { display: { intent: 'Transfer', rows }, chainId: BASE }));
    });
    await settle();
    return [...container.querySelectorAll('div.flex.items-baseline')].map((row) => ({
      label: row.firstElementChild?.textContent,
      warns: row.querySelector(`[aria-label="${PAST}"]`) !== null,
    }));
  }

  it('does not flag a start in the past, and still flags a deadline in the past', async () => {
    const shown = await rowsShown([
      { label: 'Valid after', value: '', kind: 'date', rawValue: twoDaysAgo, dateKind: 'start' },
      { label: 'Valid before', value: '', kind: 'date', rawValue: twoDaysAgo },
    ]);
    expect(shown).toEqual([
      { label: 'Valid after', warns: false },
      { label: 'Valid before', warns: true },
    ]);
  });
});
