// @vitest-environment jsdom
// Addresses inside decoded calldata are named through the shared identity hook. These pin
// that they resolve, that StrictMode's double-invoked effects cannot strand them, that
// views rendered together share one request, and that each view reads the name for its
// own chain.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toCoinType } from 'viem';

import { clearAddressIdentityCache } from '../../utils/addressIdentity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ENS_NAME = 'vitalik.eth';
const LABELS: Record<number, string> = { 1: 'mainnet', 8453: 'base' };

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
        return { address: address.toLowerCase(), name: ENS_NAME, coinType: Number(toCoinType(Number(chainId))) };
      });
      return new Response(JSON.stringify({ result: { data } }), { status: 200 });
    })
  );
  return ensRequests;
}

vi.mock('./ClearSignedView', () => ({ ClearSignedView: () => null }));
vi.mock('../TokenIcon', () => ({ TokenIcon: () => null }));
vi.mock('../IdentityAvatar', () => ({ IdentityAvatar: () => null }));
vi.mock('../VerificationDigest', () => ({ DigestRow: () => null }));

import { DecodedCalldataView } from './DecodedCalldata';

const decode = {
  clearSigned: null,
  isLoading: false,
  decoded: {
    functionName: 'transfer',
    signature: 'transfer(address, uint256)',
    params: [
      { name: 'to', type: 'address', value: RECIPIENT, rawValue: RECIPIENT },
      { name: 'amount', type: 'uint256', value: '1000' },
    ],
  },
};

const props = {
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  data: '0xa9059cbb',
  chainId: 8453,
  mainnetRpcUrl: 'https://rpc.test/mainnet',
  decode,
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

const countNames = () => (container.textContent?.split(ENS_NAME).length ?? 1) - 1;

describe('DecodedCalldataView address resolution', () => {
  it('resolves calldata addresses when one call is rendered', async () => {
    await act(async () => {
      root.render(createElement(DecodedCalldataView, props));
    });
    await settle();

    expect(ensRequests).toHaveLength(1);
    expect(container.textContent).toContain(`${ENS_NAME}@base`);
  });

  it('resolves both calls rendered together with one request', async () => {
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(DecodedCalldataView, { ...props, key: 'a' }),
          createElement(DecodedCalldataView, { ...props, key: 'b' })
        )
      );
    });
    await settle();

    expect(ensRequests).toHaveLength(1);
    expect(countNames()).toBe(2);
  });
});

// StrictMode double-invokes effects, so the first run's cleanup fires before the second
// run starts — the case that used to strand every address as permanently "attempted".
describe('DecodedCalldataView address resolution under StrictMode', () => {
  it('still resolves with one call', async () => {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(DecodedCalldataView, props)));
    });
    await settle();

    expect(container.textContent).toContain(ENS_NAME);
  });

  it('still resolves with two calls', async () => {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(DecodedCalldataView, { ...props, key: 'a' }),
          createElement(DecodedCalldataView, { ...props, key: 'b' })
        )
      );
    });
    await settle();

    expect(countNames()).toBe(2);
  });
});

// A batch can carry the same address on rows drawn for different chains. Filed by address
// alone, whichever answer landed last was rendered on both rows, one of them under the
// other chain's label.
describe('DecodedCalldataView reads the name for its own chain', () => {
  const MAINNET_NAME = `${ENS_NAME}@mainnet`;
  const BASE_NAME = `${ENS_NAME}@base`;

  it('shows the name read on its chain, not another one', async () => {
    await act(async () => {
      root.render(createElement(DecodedCalldataView, { ...props, chainId: 1 }));
    });
    await settle();

    expect(container.textContent).toContain(MAINNET_NAME);
    expect(container.textContent).not.toContain(BASE_NAME);
  });

  it('renders one row per chain, asking for the address on each', async () => {
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(DecodedCalldataView, { ...props, key: 'mainnet', chainId: 1 }),
          createElement(DecodedCalldataView, { ...props, key: 'base', chainId: 8453 })
        )
      );
    });
    await settle();

    expect(container.textContent).toContain(MAINNET_NAME);
    expect(container.textContent).toContain(BASE_NAME);
    expect(ensRequests[0].searchParams.getAll('address')).toEqual([
      `${RECIPIENT}@eip155:1`,
      `${RECIPIENT}@eip155:8453`,
    ]);
  });
});
