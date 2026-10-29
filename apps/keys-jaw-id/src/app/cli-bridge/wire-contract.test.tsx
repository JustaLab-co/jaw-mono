// @vitest-environment jsdom
import { act } from 'react';
import { decrypt } from '@jaw.id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', async () => (await import('./harness-state')).navigationMock);
vi.mock('@jaw.id/ui', async () => (await import('./harness-state')).uiMock);
vi.mock('@jaw.id/core', async (original) => (await import('./harness-state')).coreMock(await original<object>()));

import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import CLIBridgePage from './page';
import { FakeSocket, answers, created, deliver, root, secret, setUp, start, tearDown, unb64 } from './test-harness';

type Fixture = {
  name: string;
  sentBy: string[];
  frame?: Record<string, unknown>;
  fragment?: string;
  query?: string;
  expect?: Record<string, unknown>;
};

const fixturesDir = join(__dirname, 'fixtures');
const files = readdirSync(fixturesDir);
const fixtureFiles = files.filter((file) => file !== 'README.md' && file !== 'manifest.json');
const fixtures: Fixture[] = fixtureFiles
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({ name: file, ...JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) }));
const framesOf = (type: string) => fixtures.filter((f) => f.frame?.type === type);
const HANDLED_FRAME_TYPES = ['init', 'rpc_request', 'shutdown'];

beforeEach(setUp);
afterEach(tearDown);

async function lastReply(ws: FakeSocket) {
  const reply = ws.sent.at(-1)!;
  return JSON.parse(
    await decrypt(secret, {
      iv: unb64(reply.iv as string),
      cipherText: unb64(reply.ciphertext as string).buffer as ArrayBuffer,
    })
  );
}

describe('the fixture folder', () => {
  it('holds only the README, the manifest and fixtures, each well formed', () => {
    expect(fixtureFiles.filter((file) => !file.endsWith('.json'))).toEqual([]);
    for (const f of fixtures) {
      expect(f.sentBy.length, f.name).toBeGreaterThan(0);
      expect(Number('frame' in f) + Number('fragment' in f), f.name).toBe(1);
      if (f.frame) expect(HANDLED_FRAME_TYPES, f.name).toContain(f.frame.type);
    }
  });

  it('matches the manifest, so adding or deleting a fixture is a change to the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8'));
    expect(fixtureFiles.sort()).toEqual([...manifest].sort());
  });
});

describe('cli-bridge page handles what clients send', () => {
  const WORKSPACE_KEY = 'workspace-key';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url === '/api/cli-key' ? { apiKey: WORKSPACE_KEY } : {}),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each(framesOf('init'))('builds the SDK and answers ready for the init in $name', async ({ frame, expect: e }) => {
    const ws = await start();
    const before = ws.sent.length;

    await deliver(ws, frame!);
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(before));

    const ready = await lastReply(ws);
    expect(ready).toMatchObject({ type: 'ready', chainId: frame!.chainId, replays: true });
    expect(ready.apiKey).toBe(e!.readyApiKey);
    expect(created.configs).toHaveLength(1);
    const config = created.configs[0];
    expect(config.appName).toBe(e!.appName);
    expect(config.defaultChainId).toBe(e!.defaultChainId);
    expect(config.apiKey).toBe(e!.apiKey);
    expect(config.ens).toBe(e!.ens);
    expect(config.paymasters).toEqual(e!.paymasters);
    const posted = fetchMock.mock.calls.filter(([url]) => url === '/api/bridge-client');
    expect(posted.map(([, options]) => options.body)).toEqual(e!.client ? [JSON.stringify({ client: e!.client })] : []);
  });

  it.each(framesOf('rpc_request'))('hands the provider what $name says it should', async ({ frame, expect: e }) => {
    const asked = vi.fn(async () => '0xok');
    created.request = asked;
    const ws = await start();
    await deliver(ws, { type: 'init', chainId: 84532, apiKey: 'k' });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));

    await deliver(ws, frame!);

    const id = frame!.id as string;
    await vi.waitFor(async () => expect(await answers(ws, id)).toHaveLength(1));
    expect(await answers(ws, id)).toEqual([{ type: 'rpc_response', id, success: true, data: '0xok' }]);
    expect(asked).toHaveBeenCalledWith({ method: frame!.method, params: e!.params });
  });

  it.each(framesOf('shutdown'))('closes the tab on the frame in $name', async ({ frame }) => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    try {
      const ws = await start();

      await deliver(ws, frame!);

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it.each(fixtures.filter((f) => f.fragment))(
    'connects and proves the link in $name as its query and fragment allow',
    async ({ query, fragment, expect: e }) => {
      const params = new URLSearchParams(query);
      const link = new URLSearchParams(fragment);
      created.query = query!;
      window.location.hash = fragment!;
      await act(async () => root.render(<CLIBridgePage />));
      await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
      const ws = FakeSocket.all[0];
      expect(ws.url).toBe(`${params.get('relay')}?session=${encodeURIComponent(params.get('session')!)}&role=browser`);

      await act(async () => ws.onopen!());

      const exchange = ws.sent[0];
      expect(exchange.type).toBe('key_exchange');
      if (!e!.proof) return expect(exchange).not.toHaveProperty('proof');
      const proof = createHmac('sha256', Buffer.from(link.get('s')!, 'base64url'))
        .update(`jaw-bridge-key/1\n${params.get('session')}\n${link.get('pk')}\n${exchange.publicKey}`)
        .digest('hex');
      expect(exchange.proof).toBe(proof);
    }
  );
});
