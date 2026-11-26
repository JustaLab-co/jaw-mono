// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', async () => (await import('../../cli-bridge/harness-state')).navigationMock);
vi.mock('@jaw.id/ui', async () => (await import('../../cli-bridge/harness-state')).uiMock);
vi.mock('@jaw.id/core', async (original) =>
  (await import('../../cli-bridge/harness-state')).coreMock(await original<object>())
);

import ShortLinkPage from './page';
import { FakeSocket, created, host, root, setUp, tearDown } from '../../cli-bridge/test-harness';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../cli-bridge/fixtures/short-link-current.json'), 'utf8')
) as { shortLink: { id: string; key: string; blob: string }; expect: { opened: Record<string, string> } };
const { id, key, blob } = fixture.shortLink;
const { session, relay } = fixture.expect.opened;

let calls: string[];

beforeEach(() => {
  setUp();
  calls = [];
  created.params = { id };
  window.history.replaceState(null, '', `/a/${id}`);
  const replace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    calls.push(`replaceState ${String(args[2])}`);
    replace(...args);
  });
});

afterEach(() => {
  tearDown();
  vi.restoreAllMocks();
});

function serve(answer: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(`fetch ${url} with hash "${window.location.hash}"`);
      return url === `/api/a/${id}` ? answer() : new Response('{}');
    })
  );
}

/** Renders the page at the current address; a new `mount` remounts it, as a reload does. */
async function open(hash: string, mount = 'first') {
  window.location.hash = hash;
  await act(async () => root.render(<ShortLinkPage key={mount} />));
}

describe('/a/[id]', () => {
  it('strips the fragment before its first request', async () => {
    serve(() => new Response(JSON.stringify({ blob })));

    await open(key);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));

    expect(calls[0]).toBe(`replaceState /a/${id}`);
    expect(calls[1]).toBe(`fetch /api/a/${id} with hash ""`);
    expect(window.location.href).not.toContain(key);
  });

  it('connects to the relay and session the blob names', async () => {
    serve(() => new Response(JSON.stringify({ blob })));

    await open(key);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));

    expect(FakeSocket.all[0].url).toBe(`${relay}?session=${encodeURIComponent(session)}&role=browser`);
  });

  it.each([
    ['a missing or expired entry', () => new Response('{}', { status: 404 })],
    ['a tampered blob', () => new Response(JSON.stringify({ blob: `${blob.slice(0, -2)}AA` }))],
  ])('shows the damaged state for %s and opens no socket', async (_, answer) => {
    serve(answer);

    await open(key);
    await vi.waitFor(() => expect(host.textContent).toContain('This link is damaged or has expired'));

    expect(FakeSocket.all).toHaveLength(0);
  });

  it('given a batch blob, when the page has no batch screen, then it opens no socket and keeps nothing for a reload', async () => {
    const plain = {
      v: 2,
      account: '0x1111111111111111111111111111111111111111',
      members: [{ id, key, chainId: 84532 }],
    };
    const aes = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(9);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`jaw-short-link/1\n${id}`) },
      aes,
      new TextEncoder().encode(JSON.stringify(plain))
    );
    serve(
      () => new Response(JSON.stringify({ blob: Buffer.concat([iv, new Uint8Array(sealed)]).toString('base64url') }))
    );

    await open(key);
    await vi.waitFor(() => expect(host.textContent).toContain('This link is damaged or has expired'));

    expect(FakeSocket.all).toHaveLength(0);
    expect(sessionStorage.getItem(`short-link-seen:${id}`)).toBeNull();
  });

  it('given the tab opened the link before, when it reloads without the key after the request ended, then it shows the request as done', async () => {
    serve(() => new Response(JSON.stringify({ blob })));
    await open(key);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    sessionStorage.setItem(`cli-bridge-ended:${session}`, '1');

    await open('', 'reloaded');

    await vi.waitFor(() => expect(host.textContent).toContain('Done'));
    expect(host.textContent).not.toContain('damaged');
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('given the tab opened the link before, when it reloads without the key mid-request, then it says the tab lost its link', async () => {
    serve(() => new Response(JSON.stringify({ blob })));
    await open(key);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));

    await open('', 'reloaded');

    await vi.waitFor(() => expect(host.textContent).toContain('This tab lost its link'));
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('shows the damaged state without a request when the fragment is gone, as after a reload', async () => {
    serve(() => new Response(JSON.stringify({ blob })));

    await open('');
    await vi.waitFor(() => expect(host.textContent).toContain('This link is damaged or has expired'));

    expect(calls.filter((c) => c.startsWith('fetch'))).toEqual([]);
    expect(FakeSocket.all).toHaveLength(0);
  });
});
