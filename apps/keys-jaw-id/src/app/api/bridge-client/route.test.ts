import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const URL_ = 'https://keys.jaw.id/api/bridge-client';
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const post = (body: string, headers: Record<string, string> = { origin: 'https://keys.jaw.id' }) =>
  POST(new Request(URL_, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }));

describe('POST /api/bridge-client', () => {
  it('answers 204 and logs one line naming only the client', async () => {
    const response = await post(JSON.stringify({ client: 'jaw-cli/0.7.2' }));

    expect(response.status).toBe(204);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(JSON.stringify({ msg: 'bridge client', client: 'jaw-cli/0.7.2' }));
  });

  it('answers 403 and logs nothing when the origin is missing', async () => {
    expect((await post(JSON.stringify({ client: 'jaw-mcp/abc1234' }), {})).status).toBe(403);
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ['bad JSON', '{nope'],
    ['no client', '{}'],
    ['a client that is not a string', JSON.stringify({ client: 5 })],
    ['a client that does not match', JSON.stringify({ client: 'jaw cli/1' })],
    ['an array body', '[]'],
  ])('answers 400 and logs nothing for %s', async (_, body) => {
    expect((await post(body)).status).toBe(400);
    expect(info).not.toHaveBeenCalled();
  });

  it('answers 403 and logs nothing for another origin', async () => {
    const response = await post(JSON.stringify({ client: 'jaw-cli/0.7.2' }), { origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(info).not.toHaveBeenCalled();
  });

  it('answers 413 and logs nothing for a body over 256 bytes', async () => {
    const body = JSON.stringify({ client: 'jaw-cli/0.7.2', pad: 'x'.repeat(300) });

    expect((await post(body)).status).toBe(413);
    expect(info).not.toHaveBeenCalled();
  });

  it('answers 413 when content-length lies about a large body', async () => {
    const body = JSON.stringify({ client: 'jaw-cli/0.7.2', pad: 'x'.repeat(300) });

    expect((await post(body, { origin: 'https://keys.jaw.id', 'content-length': '10' })).status).toBe(413);
    expect(info).not.toHaveBeenCalled();
  });

  it('answers 413 when content-length announces a large body', async () => {
    const response = await post(JSON.stringify({ client: 'jaw-cli/0.7.2' }), {
      origin: 'https://keys.jaw.id',
      'content-length': '5000',
    });

    expect(response.status).toBe(413);
    expect(info).not.toHaveBeenCalled();
  });
});
