// @vitest-environment jsdom
// A payload that parses as JSON but can't be hashed used to throw inside Eip712Tree,
// which — with no boundary above it — left the caller's promise unsettled and the
// container stuck in the top layer. Core now refuses these upstream; this pins the
// dialog's own guard, for hosts driving @jaw.id/ui directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// Without this React logs "not configured to support act(...)" on every render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', () => ({
  SUPPORTED_CHAINS: [],
  // Pulled in transitively by the hooks barrel, via the permission-execution wildcard sentinels.
  ANY_TARGET: '0x3232323232323232323232323232323232323232',
  ANY_FN_SEL: '0x32323232',
  EMPTY_CALLDATA_FN_SEL: '0xe0e0e0e0',
  // Same reason: the chain icon hook reads the capabilities cache on render.
  peekCapabilities: () => undefined,
}));
vi.mock('../../hooks/useReverseIdentity', () => ({
  useReverseIdentity: () => ({ name: undefined, avatar: undefined }),
}));
vi.mock('../../hooks/useClearSigningTypedData', () => ({
  useClearSigningTypedData: () => ({ display: null, isLoading: false, chainId: 1 }),
}));

import { Eip712Dialog } from './index';
import type { Eip712DialogProps } from './types';

const VALID = JSON.stringify({
  domain: { name: 'Example', version: '1', chainId: 1 },
  primaryType: 'Permit',
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Permit: [{ name: 'owner', type: 'address' }],
  },
  message: { owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
});

// The worst case a host can hand the dialog: claiming the payload is signable.
const props = (typedDataJson: string): Eip712DialogProps => ({
  open: true,
  onOpenChange: () => undefined,
  typedDataJson,
  origin: 'https://app.example',
  appName: 'Example',
  accountAddress: '0x2222222222222222222222222222222222222222',
  onSign: async () => undefined,
  onCancel: () => undefined,
  isProcessing: false,
  isSuccess: false,
  signatureStatus: '',
  canSign: true,
  mainnetRpcUrl: 'https://rpc.example',
});

let root: Root | null = null;
async function render(json: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Eip712Dialog, props(json)));
  });
}
const signButton = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Sign') as
    | HTMLButtonElement
    | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
  root = null;
});

const UNSIGNABLE: Array<[string, string]> = [
  ['types missing entirely', '{"primaryType":"Permit","message":{}}'],
  ['primaryType absent from types', '{"primaryType":"Permit","types":{"Other":[]},"message":{}}'],
  ['types is not an object', '{"primaryType":"Permit","types":"nope","message":{}}'],
  ['payload is null', 'null'],
  ['payload is an array', '[]'],
  ['payload is a bare number', '42'],
  ['payload is not JSON', 'not json at all'],
];

describe('Eip712Dialog — unsignable payloads', () => {
  it.each(UNSIGNABLE)('renders the parse notice without throwing: %s', async (_label, json) => {
    await expect(render(json)).resolves.toBeUndefined();
    expect(document.body.innerHTML).toContain('Failed to parse typed data');
  });

  it.each(UNSIGNABLE)('keeps Sign disabled despite canSign=true: %s', async (_label, json) => {
    await render(json);
    expect(signButton()?.disabled).toBe(true);
  });
});

describe('Eip712Dialog — signable payload', () => {
  it('renders the review and enables Sign', async () => {
    await render(VALID);
    expect(document.body.innerHTML).not.toContain('Failed to parse typed data');
    expect(signButton()?.disabled).toBe(false);
  });
});
