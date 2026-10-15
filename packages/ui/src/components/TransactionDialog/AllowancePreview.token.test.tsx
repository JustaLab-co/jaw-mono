// @vitest-environment jsdom
// `approve(address,uint256)` is the same call on an ERC-20 and an ERC-721, so the preview reads
// the token to tell an amount from a token id. It only changes what is shown.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readContract = vi.fn();
vi.mock('../../utils/publicClient', () => ({
  getJawPublicClient: () => ({ readContract }),
}));

import { AllowancePreview } from './AllowancePreview';
import { formatAddress } from '../../utils/formatAddress';
import type { AllowanceChange } from '../../utils/allowances';
import type { AssetDelta } from '../../utils/assetPreview';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';

const change = (over: Partial<AllowanceChange> = {}): AllowanceChange => ({
  token: TOKEN,
  spender: SPENDER,
  amount: 5_000_000n,
  added: false,
  allTokens: false,
  unlimited: false,
  revoke: false,
  ambiguous: true,
  ...over,
});

type Reads = { nft: boolean | Error; decimals: number | Error };

function answer({ nft, decimals }: Reads) {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    const value = functionName === 'supportsInterface' ? nft : decimals;
    if (value instanceof Error) throw value;
    return value;
  });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function show(changes: AllowanceChange[], knownTokens: AssetDelta[] = [], chainId: number | null = 8453) {
  await act(async () => {
    root.render(
      <AllowancePreview changes={changes} knownTokens={knownTokens} chainId={chainId ?? undefined} apiKey="k" />
    );
  });
}

const amountEl = () => host.querySelector<HTMLElement>('[class^="text-value"]')!;
const spenderEl = () =>
  [...host.querySelectorAll<HTMLElement>('span.truncate')].find((e) => e.textContent === formatAddress(SPENDER))!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  readContract.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AllowancePreview token reads', () => {
  it('names an ERC-721 approval by token id and warns on the spender', async () => {
    answer({ nft: true, decimals: new Error('reverted') });
    await show([change({ amount: 42n })]);
    expect(amountEl().textContent).toBe('NFT #42');
    expect(host.textContent).not.toContain('(raw)');
    expect(spenderEl().className).toContain('text-warning');
  });

  it('asks the approved token for the ERC-721 interface id', async () => {
    answer({ nft: true, decimals: 0 });
    await show([change()]);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN, functionName: 'supportsInterface', args: ['0x80ac58cd'] })
    );
  });

  it('shows token id zero as an NFT, not as a revoke', async () => {
    answer({ nft: true, decimals: new Error('reverted') });
    await show([change({ amount: 0n, revoke: true })]);
    expect(amountEl().textContent).toBe('NFT #0');
  });

  it('does not call a huge token id unlimited', async () => {
    answer({ nft: true, decimals: new Error('reverted') });
    const id = (1n << 255n) + 7n;
    await show([change({ amount: id, unlimited: true })]);
    expect(amountEl().textContent).toBe(`NFT #${id}`);
    expect(amountEl().className).not.toContain('text-warning');
  });

  it('formats an amount with the decimals() of a token that is not an NFT', async () => {
    answer({ nft: new Error('no such function'), decimals: 6 });
    await show([change()]);
    expect(amountEl().textContent).toBe('5');
    expect(spenderEl().className).not.toContain('text-warning');
  });

  it('labels a zero approve Revoke once decimals() proves an ERC-20', async () => {
    answer({ nft: false, decimals: 18 });
    await show([change({ amount: 0n, revoke: true })]);
    expect(amountEl().textContent).toBe('Revoke');
  });

  it('keeps the raw amount when the token cannot be read', async () => {
    answer({ nft: new Error('rpc down'), decimals: new Error('rpc down') });
    await show([change()]);
    expect(amountEl().textContent).toBe('5000000 (raw)');
    expect(spenderEl().className).not.toContain('text-warning');
  });

  it('shows a placeholder, not the raw number, while the token is being read', async () => {
    readContract.mockImplementation(() => new Promise(() => undefined));
    await show([change()]);
    expect(amountEl().textContent).toBe('Reading token…');
  });

  it('keeps the unlimited label while the token is being read', async () => {
    readContract.mockImplementation(() => new Promise(() => undefined));
    await show([change({ amount: 1n << 256n, unlimited: true })]);
    expect(amountEl().textContent).toBe('Unlimited');
    expect(amountEl().className).toContain('text-warning');
  });

  it('does not read a token whose decimals the simulation already gave', async () => {
    answer({ nft: true, decimals: 6 });
    const usdc: AssetDelta = {
      address: TOKEN.toLowerCase(),
      symbol: 'USDC',
      decimals: 6,
      diff: -1n,
      direction: 'out',
      amountFormatted: '1',
      isNative: false,
    };
    await show([change()], [usdc]);
    expect(readContract).not.toHaveBeenCalled();
    expect(amountEl().textContent).toBe('5');
  });

  it('does not read for calls that are not ambiguous', async () => {
    answer({ nft: true, decimals: 6 });
    await show([change({ ambiguous: false })]);
    expect(readContract).not.toHaveBeenCalled();
    expect(amountEl().textContent).toBe('5000000 (raw)');
  });

  it('does not read without a chain', async () => {
    answer({ nft: true, decimals: 6 });
    await show([change()], [], null);
    expect(readContract).not.toHaveBeenCalled();
    expect(amountEl().textContent).toBe('5000000 (raw)');
  });
});
