import { describe, it, expect, afterEach } from 'vitest';
import { GET } from './route';

const original = process.env.JAW_CLI_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.JAW_CLI_API_KEY;
  else process.env.JAW_CLI_API_KEY = original;
});

describe('GET /api/cli-key', () => {
  it('serves the configured key without letting anything cache it', async () => {
    process.env.JAW_CLI_API_KEY = 'workspace-key';

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ apiKey: 'workspace-key' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  // A deploy missing the variable should say so rather than answer with nothing
  // and leave the bridge operating keyless against a proxy that refuses it.
  it('refuses when the key is not configured', async () => {
    delete process.env.JAW_CLI_API_KEY;

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'JAW_CLI_API_KEY is not configured' });
  });

  // Deliberately not the shape of `/api/trusted-hosts`, which is readable by any
  // dApp's SDK. The exposure accepted here is somebody who loads keys.jaw.id,
  // not any page on the web taking the key from its own JavaScript.
  it('is not readable cross origin', async () => {
    process.env.JAW_CLI_API_KEY = 'workspace-key';

    const response = await GET();

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
