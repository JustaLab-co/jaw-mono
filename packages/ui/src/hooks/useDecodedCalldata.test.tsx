// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { encodeFunctionData, maxUint256, parseAbi } from 'viem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// whatsabi cannot read the contract, so only the descriptor knows the call.
vi.mock('@shazow/whatsabi', () => ({
  whatsabi: {
    autoload: async () => {
      throw new Error('no bytecode');
    },
    loaders: { OpenChainSignatureLookup: class {} },
  },
}));
vi.mock('../utils/clearSigning', async (original) => ({
  ...(await original<typeof import('../utils/clearSigning')>()),
  resolveCalldataDescriptor: async () => ({
    descriptor: {},
    formatKey: 'approve(address spender, uint256 amount)',
    format: {},
  }),
  applyFormat: async () => ({ intent: 'Approve', rows: [{ label: 'Amount', value: 'Unlimited', kind: 'raw' }] }),
}));

import { useDecodedCalldata, type DecodeResult } from './useDecodedCalldata';

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const approve = encodeFunctionData({
  abi: parseAbi(['function approve(address spender, uint256 amount)']),
  functionName: 'approve',
  args: ['0x1111111111111111111111111111111111111111', maxUint256],
});

let container: HTMLDivElement;
let root: Root;
let result: DecodeResult;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function decode(data: string) {
  const Probe = () => {
    result = useDecodedCalldata(TOKEN, data, 8453);
    return null;
  };
  await act(async () => root.render(createElement(Probe)));
  await vi.waitFor(() => expect(result.isLoading).toBe(false));
  return result;
}

describe('useDecodedCalldata with a descriptor and no bytecode ABI', () => {
  it('finds a suffix after a clear-signed call with the descriptor signature', async () => {
    const { clearSigned, decoded } = await decode(`${approve}8021802180218021`);
    expect(clearSigned?.intent).toBe('Approve');
    expect(decoded?.functionName).toBe('approve');
    expect(decoded?.trailing).toBe('0x8021802180218021');
  });

  it('reports no suffix for an exact clear-signed call', async () => {
    const { decoded } = await decode(approve);
    expect(decoded?.functionName).toBe('approve');
    expect(decoded?.trailing).toBeUndefined();
  });
});
