// @vitest-environment jsdom
// `restoreAccount` is what `useSessionAccount` calls once its guard lets go, so
// a key requirement here would refuse the same keyless session one step later.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const restore = vi.fn();

vi.mock('@jaw.id/core', () => ({
  Account: { restore: (...args: unknown[]) => restore(...args) },
  PasskeyAccount: class {},
}));
vi.mock('../../lib/passkey-service', () => ({
  PasskeyService: class {
    fetchAccounts = () => [];
  },
}));

const { usePasskeys } = await import('./index');

const CHAIN = { id: 84532, rpcUrl: 'https://rpc.example', paymaster: undefined } as never;

function Probe({ apiKey, onDone }: { apiKey?: string; onDone: (err: unknown) => void }) {
  const { restoreAccount } = usePasskeys(apiKey ? { apiKey } : undefined);
  useEffect(() => {
    restoreAccount(CHAIN, 'cred-1', '0xpub')
      .then(() => onDone(null))
      .catch(onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

let root: Root | null = null;

async function restoreWith(apiKey?: string): Promise<unknown> {
  let outcome: unknown = 'never settled';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(
      createElement(QueryClientProvider, { client }, createElement(Probe, { apiKey, onDone: (e) => (outcome = e) }))
    );
  });
  await act(() => Promise.resolve());
  return outcome;
}

beforeEach(() => {
  restore.mockReset();
  restore.mockResolvedValue({ address: '0xabc' });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});

describe('usePasskeys restoreAccount', () => {
  it('restores with no api key anywhere', async () => {
    const outcome = await restoreWith(undefined);

    expect(outcome).toBeNull();
    expect((restore.mock.calls[0][0] as { apiKey?: string }).apiKey).toBeUndefined();
  });

  it('carries the key the hook was given', async () => {
    await restoreWith('k1');

    expect((restore.mock.calls[0][0] as { apiKey?: string }).apiKey).toBe('k1');
  });
});
