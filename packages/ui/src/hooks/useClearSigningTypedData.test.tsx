// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Only the two network edges are replaced: the registry fetch and the on-chain token read.
// Descriptor matching and formatting run for real.
vi.mock('../utils/clearSigning', async (original) => {
  const fx = await import('../utils/erc3009.fixtures');
  return {
    ...(await original<typeof import('../utils/clearSigning')>()),
    getDefaultDescriptorSource: () => fx.circleRegistrySource(),
    createTokenResolver: () => fx.readUsdcOnly,
  };
});

import { useClearSigningTypedData } from './useClearSigningTypedData';
import { BASE, erc3009TypedData, USDC_BASE } from '../utils/erc3009.fixtures';

let container: HTMLDivElement;
let root: Root;
let result: ReturnType<typeof useClearSigningTypedData>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function resolve(typedData: unknown) {
  const Probe = () => {
    result = useClearSigningTypedData(JSON.stringify(typedData), BASE);
    return null;
  };
  await act(async () => root.render(createElement(Probe)));
  await vi.waitFor(() => expect(result.display).not.toBeNull());
  if (!result.display) throw new Error('expected a clear-signing display');
  return result.display;
}

describe('useClearSigningTypedData with a registry entry whose token is `@.to`', () => {
  // ERC-7730, EIP-712 container: `@.to` is the verifying contract. For an ERC-3009
  // authorization that is the token being moved, so 1000000 is 1 USDC.
  it('shows the amount in the verifying contract token', async () => {
    const display = await resolve(erc3009TypedData());
    const amount = display.rows.find((r) => r.label === 'Amount');
    expect(amount).toMatchObject({ kind: 'tokenAmount', value: '1', symbol: 'USDC' });
    expect(amount?.tokenAddress?.toLowerCase()).toBe(USDC_BASE.toLowerCase());
  });
});
