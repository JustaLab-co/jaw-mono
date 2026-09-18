// @vitest-environment jsdom
// The second visit of a keyless user. The first goes through `useCreatePasskey`
// and never reaches here, which is why this refused where creating had worked,
// and the message it refused with named an env var at an end user.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const get = vi.fn();

vi.mock('@jaw.id/core', () => ({ Account: { get: (...args: unknown[]) => get(...args) } }));
vi.mock('../useAuth', () => ({ useAuth: () => ({ refetch: vi.fn() }) }));

const { useLogin } = await import('./index');

const CHAIN = { id: 84532, paymaster: undefined } as never;

function Probe({ apiKey, onDone }: { apiKey?: string; onDone: (err: unknown) => void }) {
  const login = useLogin();
  useEffect(() => {
    login
      .mutateAsync({ chainId: CHAIN, credentialId: 'cred-1', apiKey })
      .then(() => onDone(null))
      .catch(onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

let root: Root | null = null;

async function login(apiKey?: string): Promise<unknown> {
  let outcome: unknown = 'never settled';
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(
      createElement(QueryClientProvider, { client }, createElement(Probe, { apiKey, onDone: (err) => (outcome = err) }))
    );
  });
  await act(() => Promise.resolve());
  return outcome;
}

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({
    getMetadata: () => ({ username: 'someone', creationDate: '2026-01-01' }),
    getAddress: async () => '0xabc',
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});

describe('useLogin', () => {
  it('signs a returning user in with no api key', async () => {
    const outcome = await login(undefined);

    expect(outcome).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect((get.mock.calls[0][0] as { apiKey?: string }).apiKey).toBeUndefined();
  });

  it('still carries the key when there is one', async () => {
    await login('k1');

    expect((get.mock.calls[0][0] as { apiKey?: string }).apiKey).toBe('k1');
  });
});
