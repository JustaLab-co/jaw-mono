// @vitest-environment jsdom
// An ERC-3009 authorization moves money when it is submitted, so the dialog shows it
// as a payment: amount in token units, payee, whether the registry knows the token,
// and no Sign button when the payment is not from the signing account.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', () => ({
  SUPPORTED_CHAINS: [{ id: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }],
  ANY_TARGET: '0x3232323232323232323232323232323232323232',
  ANY_FN_SEL: '0x32323232',
  EMPTY_CALLDATA_FN_SEL: '0xe0e0e0e0',
  peekCapabilities: () => undefined,
  handleGetCapabilitiesRequest: async () => ({}),
  JAW_BASE_URL: 'https://api.jaw.test',
}));
// Anything else that reaches for the network (chain and token icons) finds it offline.
vi.stubGlobal('fetch', async () => {
  throw new Error('offline');
});
vi.mock('../../hooks/useReverseIdentity', () => ({
  useReverseIdentity: () => ({ name: undefined, avatar: undefined }),
}));
// ENS for the payee. Keyed the way the hook keys its result.
vi.mock('../../hooks/useAddressIdentities', async () => {
  const { identityKey } = await import('../../utils');
  const fx = await import('../../utils/erc3009.fixtures');
  return {
    useAddressIdentities: (inputs: Array<{ address: string; chainId: number }>) =>
      Object.fromEntries(
        inputs
          .filter((i) => i.address.toLowerCase() === fx.PAYEE.toLowerCase())
          .map((i) => [identityKey(i.address, i.chainId), { ensName: 'payee.eth', ensAvatar: undefined }])
      ),
  };
});
// The two network edges: the registry fetch and the on-chain token read.
const chain = vi.hoisted(() => ({ tokens: new Map<string, { decimals: number; symbol: string }>() }));
vi.mock('../../utils/clearSigning', async (original) => {
  const fx = await import('../../utils/erc3009.fixtures');
  return {
    ...(await original<typeof import('../../utils/clearSigning')>()),
    getDefaultDescriptorSource: () => fx.circleRegistrySource(),
    createTokenResolver: () => async (address: string) => {
      const info = chain.tokens.get(address.toLowerCase());
      return info ? { address, ...info } : null;
    },
  };
});

import { Eip712Dialog } from './index';
import type { Eip712DialogProps } from './types';
import { BASE, erc3009TypedData, PAYEE, PAYER, USDC_BASE } from '../../utils/erc3009.fixtures';

const OTHER_TOKEN = '0x2222222222222222222222222222222222222222';

let root: Root | null = null;

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  document.body.innerHTML = '';
  root = null;
  chain.tokens.clear();
});

const props = (typedData: unknown, accountAddress = PAYER): Eip712DialogProps => ({
  open: true,
  onOpenChange: () => undefined,
  typedDataJson: JSON.stringify(typedData),
  origin: 'https://shop.example',
  appName: 'Shop',
  accountAddress,
  chainId: BASE,
  onSign: async () => undefined,
  onCancel: () => undefined,
  isProcessing: false,
  isSuccess: false,
  signatureStatus: '',
  canSign: true,
  mainnetRpcUrl: 'https://rpc.example',
});

async function render(typedData: unknown, accountAddress?: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(createElement(Eip712Dialog, props(typedData, accountAddress)));
  });
}

const text = () => document.body.textContent ?? '';
const signButton = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Sign') as HTMLButtonElement;
// The amount and the network sit on their own lines, so each is matched as a whole line.
const line = (t: string) => [...document.querySelectorAll('p')].some((p) => p.textContent?.trim() === t);
const IDENTICON = 'img[src^="data:image/svg"]';
const logos = (symbol: string) => [...document.querySelectorAll<HTMLImageElement>(`img[alt="${symbol}"]`)];
const amountRow = (t: string) => [...document.querySelectorAll('p')].find((p) => p.textContent === t)?.parentElement;
const tokenRow = () =>
  [...document.querySelectorAll('span')].find((s) => s.textContent?.trim() === 'Token')?.parentElement;
const rowValue = (label: string) => {
  const labelEl = [...document.querySelectorAll('span')].find((s) => s.textContent?.trim() === label);
  return labelEl?.parentElement?.textContent?.slice(label.length) ?? '';
};

describe('Eip712Dialog, ERC-3009 payment', () => {
  it('shows a USDC payment in token units, with the payee', async () => {
    chain.tokens.set(USDC_BASE.toLowerCase(), { decimals: 6, symbol: 'USDC' });
    await render(erc3009TypedData());
    await vi.waitFor(() => expect(line('1 USDC')).toBe(true));
    expect(rowValue('To')).toContain('payee.eth');
  });

  // The domain card below already names the network, and the card carries no closing line (Leo, 2026-11-16).
  it('shows just the amount and symbol, without repeating the network or a closing line', async () => {
    chain.tokens.set(USDC_BASE.toLowerCase(), { decimals: 6, symbol: 'USDC' });
    await render(erc3009TypedData());
    await vi.waitFor(() => expect(line('1 USDC')).toBe(true));
    expect(line('on Base')).toBe(false);
    expect(text()).not.toContain('Signing sends');
  });

  it('marks the token verified when the registry knows it', async () => {
    chain.tokens.set(USDC_BASE.toLowerCase(), { decimals: 6, symbol: 'USDC' });
    await render(erc3009TypedData());
    await vi.waitFor(() => expect(rowValue('Token')).toContain('Verified'));
    expect(rowValue('Token')).not.toContain('Unverified');
  });

  it('reads any token from its contract and marks it unverified when the registry does not know it', async () => {
    chain.tokens.set(OTHER_TOKEN, { decimals: 18, symbol: 'TKN' });
    await render(
      erc3009TypedData({
        domain: { name: 'Token', version: '1', verifyingContract: OTHER_TOKEN },
        message: { value: '1500000000000000000' },
      })
    );
    await vi.waitFor(() => expect(line('1.5 TKN')).toBe(true));
    await vi.waitFor(() => expect(rowValue('Token')).toContain('Unverified'));
  });

  it('shows the raw amount, and says why, when the token cannot be read', async () => {
    await render(erc3009TypedData({ domain: { name: 'Token', version: '1', verifyingContract: OTHER_TOKEN } }));
    await vi.waitFor(() => expect(line('1,000,000')).toBe(true));
    expect(text()).toContain("Couldn't read this token, so the amount is in its smallest unit.");
  });

  // Same rule as the permission screen: a token with no logo shows the identicon of its address,
  // so each contract keeps a look of its own instead of an empty spot.
  it("shows the token's identicon where its logo would be when it has none", async () => {
    chain.tokens.set(OTHER_TOKEN, { decimals: 18, symbol: 'TKN' });
    await render(
      erc3009TypedData({
        domain: { name: 'Token', version: '1', verifyingContract: OTHER_TOKEN },
        message: { value: '1500000000000000000' },
      })
    );
    await vi.waitFor(() => expect(line('1.5 TKN')).toBe(true));
    expect(logos('TKN')).toHaveLength(2);
    await act(async () => logos('TKN').forEach((img) => img.dispatchEvent(new Event('error'))));
    expect(amountRow('1.5 TKN')?.querySelector(IDENTICON)).not.toBeNull();
    expect(tokenRow()?.querySelector(IDENTICON)).not.toBeNull();
  });

  it('shows ReceiveWithAuthorization as the same payment', async () => {
    chain.tokens.set(USDC_BASE.toLowerCase(), { decimals: 6, symbol: 'USDC' });
    await render(erc3009TypedData({ primaryType: 'ReceiveWithAuthorization' }));
    await vi.waitFor(() => expect(line('1 USDC')).toBe(true));
  });

  it('keeps the raw details one click away', async () => {
    await render(erc3009TypedData());
    expect(text()).toContain('Show raw details');
  });
});

describe('Eip712Dialog, ERC-3009 payment from another account', () => {
  it('warns and turns Sign off when the payment is not from the signing account', async () => {
    const someoneElse = '0x3333333333333333333333333333333333333333';
    await render(erc3009TypedData({ message: { from: someoneElse } }));
    expect(text()).toContain('This payment is from 0x3333...3333, not the account signing.');
    expect(signButton().disabled).toBe(true);
  });

  it('leaves Sign on when the payment is from the signing account, whatever the address case', async () => {
    await render(erc3009TypedData(), PAYER.toLowerCase());
    expect(text()).not.toContain('not the account signing');
    expect(signButton().disabled).toBe(false);
  });

  it('does not apply to other typed data, such as a permit for another owner', async () => {
    const permit = {
      domain: { name: 'USD Coin', version: '2', chainId: BASE, verifyingContract: USDC_BASE },
      primaryType: 'Permit',
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
        ],
      },
      message: { owner: '0x3333333333333333333333333333333333333333', spender: PAYEE, value: '1' },
    };
    await render(permit);
    expect(text()).not.toContain('not the account signing');
    expect(signButton().disabled).toBe(false);
  });
});
