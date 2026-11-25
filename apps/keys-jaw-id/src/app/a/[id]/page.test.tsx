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

async function open(hash: string) {
  window.location.hash = hash;
  await act(async () => root.render(<ShortLinkPage />));
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

  it('shows the damaged state without a request when the fragment is gone, as after a reload', async () => {
    serve(() => new Response(JSON.stringify({ blob })));

    await open('');
    await vi.waitFor(() => expect(host.textContent).toContain('This link is damaged or has expired'));

    expect(calls.filter((c) => c.startsWith('fetch'))).toEqual([]);
    expect(FakeSocket.all).toHaveLength(0);
  });
});
