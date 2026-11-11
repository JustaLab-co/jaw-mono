// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', async () => (await import('./harness-state')).navigationMock);
vi.mock('@jaw.id/ui', async () => (await import('./harness-state')).uiMock);
vi.mock('@jaw.id/core', async (original) => (await import('./harness-state')).coreMock(await original<object>()));

import { answers, created, deliver, init, setUp, start, tearDown } from './test-harness';

const SIGNER_KEY = 'JAWSDK:SignerConfig:SignerType';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

function signInAs(account: string) {
  localStorage.setItem('jawsdk.store', JSON.stringify({ state: { account: { accounts: [account] } }, version: 0 }));
  localStorage.setItem(SIGNER_KEY, 'appSpecific');
}

beforeEach(() => {
  setUp();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  );
});
afterEach(tearDown);

async function connectRequest(ws: Awaited<ReturnType<typeof start>>, id = 'a1') {
  await deliver(ws, { type: 'rpc_request', id, method: 'eth_requestAccounts', params: [] });
  await vi.waitFor(async () => expect(await answers(ws, id)).toHaveLength(1));
  return (await answers(ws, id))[0];
}

describe('cli-bridge page when the init names the account', () => {
  it('given a session for that account, keeps it and answers with it', async () => {
    signInAs(A);
    created.request = async () => [A];
    const ws = await start();

    await init(ws, { account: A });

    expect(localStorage.getItem(SIGNER_KEY)).toBe('appSpecific');
    expect(created.handlerOptions).toEqual([{ originLabel: 'via JAW bridge', expectedAccount: A }]);
    expect(await connectRequest(ws)).toMatchObject({ success: true, data: [A], address: A });
  });

  it('given a session for that account in another letter case, keeps it', async () => {
    signInAs(A.toUpperCase().replace('0X', '0x'));
    const ws = await start();

    await init(ws, { account: A });

    expect(localStorage.getItem(SIGNER_KEY)).toBe('appSpecific');
  });

  it('given a session for another account, drops that session so the wallet asks, and tells the dialog which account', async () => {
    signInAs(B);
    const ws = await start();

    await init(ws, { account: A });

    expect(localStorage.getItem(SIGNER_KEY)).toBeNull();
    expect(created.handlerOptions).toEqual([{ originLabel: 'via JAW bridge', expectedAccount: A }]);
  });

  it('given a session for another account, leaves the passkey login of the rest of keys.jaw.id alone', async () => {
    signInAs(B);
    localStorage.setItem('JAWSDK:PasskeyManager:authState', '{"credentialId":"c"}');
    const ws = await start();

    await init(ws, { account: A });

    expect(localStorage.getItem('JAWSDK:PasskeyManager:authState')).toBe('{"credentialId":"c"}');
  });

  it('given no session, builds the SDK as it does for any client', async () => {
    const ws = await start();

    await init(ws, { account: A });

    expect(created.configs).toHaveLength(1);
    expect(localStorage.getItem(SIGNER_KEY)).toBeNull();
  });

  it('never answers a connect with an account other than the one asked for', async () => {
    created.request = async () => [B];
    const ws = await start();
    await init(ws, { account: A });

    const reply = await connectRequest(ws);

    expect(reply).toMatchObject({
      success: false,
      error: { message: `This wallet is signed in as ${B}. The request is for ${A}.` },
    });
    expect(reply).not.toHaveProperty('address');
  });

  it('refuses an init whose account is not an address and builds no SDK', async () => {
    const ws = await start();

    const reply = await init(ws, { account: 'adz.jawbot.eth' });

    expect(reply).toEqual({ type: 'error', reason: 'Invalid account: expected an address' });
    expect(created.configs).toEqual([]);
  });

  it('a later init for another account builds a new SDK for it', async () => {
    const ws = await start();
    await init(ws, { account: A });

    await init(ws, { account: B });

    expect(created.handlerOptions).toEqual([
      { originLabel: 'via JAW bridge', expectedAccount: A },
      { originLabel: 'via JAW bridge', expectedAccount: B },
    ]);
  });
});

describe('cli-bridge page when the init names no account', () => {
  it('behaves as before: keeps a session for any account and answers with it', async () => {
    signInAs(B);
    created.request = async () => [B];
    const ws = await start();

    await init(ws, {});

    expect(localStorage.getItem(SIGNER_KEY)).toBe('appSpecific');
    expect(created.handlerOptions).toEqual([{ originLabel: 'via JAW bridge' }]);
    expect(await connectRequest(ws)).toMatchObject({ success: true, data: [B], address: B });
  });

  it('forgets the account of an earlier init', async () => {
    created.request = async () => [B];
    const ws = await start();
    await init(ws, { account: A });

    await init(ws, {});

    expect(await connectRequest(ws)).toMatchObject({ success: true, address: B });
  });
});
