// @vitest-environment jsdom
// The grant screen keeps Confirm shut while `loading` is true, so this is what
// stands between the user and signing a transfer they have not seen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Account, PermissionsDetail } from '@jaw.id/core';
import { useSpenderPrefund, type UseSpenderPrefundArgs, type UseSpenderPrefundResult } from './useSpenderPrefund';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPENDER = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const PERMISSIONS: PermissionsDetail = { spends: [{ token: TOKEN, allowance: '1000000', unit: 'day' }] };
const QUOTE = { kind: 'transfer' as const, token: TOKEN, spender: SPENDER, amount: 6_000n };

let root: Root | null = null;
let latest: UseSpenderPrefundResult | null = null;

function Probe(props: UseSpenderPrefundArgs) {
  latest = useSpenderPrefund(props);
  return null;
}

async function render(props: UseSpenderPrefundArgs) {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root!.render(createElement(Probe, props)));
  return (next: UseSpenderPrefundArgs) => act(async () => root!.render(createElement(Probe, next)));
}

const accountWith = (quoteSpenderPrefund: ReturnType<typeof vi.fn>) => ({ quoteSpenderPrefund }) as unknown as Account;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
});

describe('useSpenderPrefund', () => {
  it('settles at once, with nothing, when the request did not ask', async () => {
    const quote = vi.fn();
    await render({ account: accountWith(quote), enabled: false, spender: SPENDER, permissions: PERMISSIONS });

    expect(latest).toEqual({ quote: null, loading: false });
    expect(quote).not.toHaveBeenCalled();
  });

  // The account restores asynchronously. Settling before it arrives would open
  // Confirm on a screen that has not shown the transfer yet.
  it('stays loading until the account is there to quote with', async () => {
    const quote = vi.fn().mockResolvedValue(QUOTE);
    const rerender = await render({ account: null, enabled: true, spender: SPENDER, permissions: PERMISSIONS });

    expect(latest?.loading).toBe(true);

    await rerender({ account: accountWith(quote), enabled: true, spender: SPENDER, permissions: PERMISSIONS });

    expect(quote).toHaveBeenCalledWith(SPENDER, PERMISSIONS, undefined);
    expect(latest).toEqual({ quote: QUOTE, loading: false });
  });

  it('settles to no prefund when the quote fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const quote = vi.fn().mockRejectedValue(new Error('rpc down'));
    await render({ account: accountWith(quote), enabled: true, spender: SPENDER, permissions: PERMISSIONS });

    expect(latest).toEqual({ quote: null, loading: false });
  });

  // The amount shown is the amount sent, so a re-render must not re-price it.
  it('quotes once for the same request', async () => {
    const quote = vi.fn().mockResolvedValue(QUOTE);
    const account = accountWith(quote);
    const rerender = await render({ account, enabled: true, spender: SPENDER, permissions: PERMISSIONS });
    await rerender({ account, enabled: true, spender: SPENDER, permissions: PERMISSIONS });

    expect(quote).toHaveBeenCalledTimes(1);
  });

  // Keys rebuilds the request object on every render of the modal's parent. A
  // new object saying the same thing is the same request.
  it('does not re-quote when the same request arrives as a new object', async () => {
    const quote = vi.fn().mockResolvedValue(QUOTE);
    const account = accountWith(quote);
    const rerender = await render({ account, enabled: true, spender: SPENDER, permissions: PERMISSIONS });
    await rerender({ account, enabled: true, spender: SPENDER, permissions: structuredClone(PERMISSIONS) });
    await rerender({ account: accountWith(quote), enabled: true, spender: SPENDER, permissions: { ...PERMISSIONS } });

    expect(quote).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({ quote: QUOTE, loading: false });
  });

  it('quotes again when the request itself changes', async () => {
    const quote = vi.fn().mockResolvedValue(QUOTE);
    const account = accountWith(quote);
    const rerender = await render({ account, enabled: true, spender: SPENDER, permissions: PERMISSIONS });
    await rerender({
      account,
      enabled: true,
      spender: SPENDER,
      permissions: { spends: [{ token: TOKEN, allowance: '2000000', unit: 'day' }] },
    });

    expect(quote).toHaveBeenCalledTimes(2);
  });
});
