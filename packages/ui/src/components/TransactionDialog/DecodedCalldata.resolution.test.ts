// @vitest-environment jsdom
// Addresses inside decoded calldata are marked "attempted" before their reverse-resolve
// request lands, while the effect cleanup cancels the write. A second effect run without
// a remount (StrictMode's double-invoke, an rpcUrl change) then filters every address out
// as already-tried and resolution is blocked for good. These pin the retry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ENS_NAME = 'vitalik.eth';

const identityKey = (address: string, chainId: number) => `${address.toLowerCase()}:${chainId}`;

const reverseResolveWithAvatars = vi.fn(async (inputs: { address: string; chainId: number }[]) => {
  const out: Record<string, { name: string }> = {};
  for (const { address, chainId } of inputs) out[identityKey(address, chainId)] = { name: ENS_NAME };
  return out;
});

vi.mock('../../utils', () => ({
  reverseResolveWithAvatars: (...args: unknown[]) =>
    (reverseResolveWithAvatars as unknown as (...a: unknown[]) => unknown)(...args),
  identityKey: (address: string, chainId: number) => `${address.toLowerCase()}:${chainId}`,
  getChainLabel: async () => null,
  formatAddress: (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`,
}));
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
  });
}

const countNames = () => (container.textContent?.split(ENS_NAME).length ?? 1) - 1;

describe('DecodedCalldataView address resolution', () => {
  it('resolves calldata addresses when one call is rendered', async () => {
    await act(async () => {
      root.render(createElement(DecodedCalldataView, props));
    });
    await settle();

    expect(reverseResolveWithAvatars).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(ENS_NAME);
  });

  it('resolves calldata addresses when two calls are rendered together', async () => {
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

    expect(reverseResolveWithAvatars).toHaveBeenCalledTimes(2);
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
