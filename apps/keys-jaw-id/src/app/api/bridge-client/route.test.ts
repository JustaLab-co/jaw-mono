import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const URL_ = 'https://keys.jaw.id/api/bridge-client';
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const post = (body: string, headers: Record<string, string> = { origin: 'https://keys.jaw.id' }) =>
  POST(new Request(URL_, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }));

describe('POST /api/bridge-client', () => {
  it('answers 204 and logs one line naming only the client', async () => {
    const response = await post(JSON.stringify({ client: 'jaw-cli/0.7.2' }));

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ msg: 'bridge client', client: 'jaw-cli/0.7.2' }));
  });

  it('answers 403 and logs nothing when the origin is missing', async () => {
    expect((await post(JSON.stringify({ client: 'jaw-mcp/abc1234' }), {})).status).toBe(403);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['bad JSON', '{nope'],
    ['no client', '{}'],
    ['a client that is not a string', JSON.stringify({ client: 5 })],
    ['a client that does not match', JSON.stringify({ client: 'jaw cli/1' })],
    ['an array body', '[]'],
  ])('answers 400 and logs nothing for %s', async (_, body) => {
    expect((await post(body)).status).toBe(400);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 403 and logs nothing for another origin', async () => {
    const response = await post(JSON.stringify({ client: 'jaw-cli/0.7.2' }), { origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 413 and logs nothing for a body over 256 bytes', async () => {
    const body = JSON.stringify({ client: 'jaw-cli/0.7.2', pad: 'x'.repeat(300) });

    expect((await post(body)).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 413 when content-length lies about a large body', async () => {
    const body = JSON.stringify({ client: 'jaw-cli/0.7.2', pad: 'x'.repeat(300) });

    expect((await post(body, { origin: 'https://keys.jaw.id', 'content-length': '10' })).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 413 when content-length announces a large body', async () => {
    const response = await post(JSON.stringify({ client: 'jaw-cli/0.7.2' }), {
      origin: 'https://keys.jaw.id',
      'content-length': '5000',
    });

    expect(response.status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 413 for a chunked body over 256 bytes and stops reading', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(100));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const request = new Request(URL_, {
      method: 'POST',
      body: stream,
      headers: { origin: 'https://keys.jaw.id' },
      duplex: 'half',
    } as RequestInit);

    expect((await POST(request)).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
    expect(pulled).toBeLessThan(10);
  });

  it('answers 204 for a chunked body split across chunks', async () => {
    const encoder = new TextEncoder();
    const parts = ['{"client":', '"jaw-cli/0.7.2"}'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        parts.forEach((part) => controller.enqueue(encoder.encode(part)));
        controller.close();
      },
    });
    const request = new Request(URL_, {
      method: 'POST',
      body: stream,
      headers: { origin: 'https://keys.jaw.id' },
      duplex: 'half',
    } as RequestInit);

    expect((await POST(request)).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs at a level that production builds keep', () => {
    const config = readFileSync(new URL('../../../../next.config.js', import.meta.url), 'utf8');
    const kept = /exclude:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';

    expect(kept).toContain("'warn'");
  });
});
