// @vitest-environment jsdom
// Keyless, nothing anywhere carries an api key: not the handshake, not the rpc
// url keys parses it out of. Treating that as missing data left `account` null
// for the whole session, and every dialog answered "Account not initialized" on
// Confirm, on a guard that never clears.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const restoreAccount = vi.fn();

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    credentialId: 'cred-1',
    publicKey: '0xpub',
    walletAddress: '0xabc',
    isAuthenticated: true,
  }),
}));
vi.mock('../usePasskeys', () => ({ usePasskeys: () => ({ restoreAccount }) }));

const { useSessionAccount } = await import('./index');

const CHAIN = { id: 84532, rpcUrl: 'https://api.justaname.id/proxy/v1/rpc/handle', paymaster: undefined };

function Probe({ chain, apiKey }: { chain: typeof CHAIN; apiKey?: string }) {
  const { account } = useSessionAccount({ origin: 'https://dapp.example', chain, apiKey });
  return createElement('span', null, account ? 'ready' : 'none');
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(chain: typeof CHAIN, apiKey?: string) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe, { chain, apiKey }));
  });
  await act(() => Promise.resolve());
}

async function rerender(chain: typeof CHAIN, apiKey?: string) {
  await act(async () => {
    root!.render(createElement(Probe, { chain, apiKey }));
  });
  await act(() => Promise.resolve());
}

beforeEach(() => {
  restoreAccount.mockReset();
  restoreAccount.mockResolvedValue({ address: '0xabc' });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});

describe('useSessionAccount', () => {
  it('restores the account when no api key exists anywhere', async () => {
    await mount(CHAIN);

    expect(restoreAccount).toHaveBeenCalledTimes(1);
    expect(restoreAccount.mock.calls[0][3]).toBeUndefined();
    expect(container.textContent).toBe('ready');
  });

  it('still passes the key when the rpc url carries one', async () => {
    await mount({ ...CHAIN, rpcUrl: `${CHAIN.rpcUrl}?api-key=k1` });

    expect(restoreAccount.mock.calls[0][3]).toBe('k1');
  });

  // keys learns the key from the handshake and again from each request, so it
  // can arrive after a keyless restore has already started.
  it('restores again when the key arrives mid-flight', async () => {
    let release: (value: unknown) => void = () => undefined;
    restoreAccount.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    await mount(CHAIN);

    await rerender(CHAIN, 'k1');
    expect(restoreAccount).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ address: '0xabc' });
    });
    await act(() => Promise.resolve());

    expect(restoreAccount).toHaveBeenCalledTimes(2);
    expect(restoreAccount.mock.calls[1][3]).toBe('k1');
  });

  it('prefers the key it was handed over the one in the url', async () => {
    await mount({ ...CHAIN, rpcUrl: `${CHAIN.rpcUrl}?api-key=from-url` }, 'from-caller');

    expect(restoreAccount.mock.calls[0][3]).toBe('from-caller');
  });
});
