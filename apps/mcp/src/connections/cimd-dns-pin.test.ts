import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { Browser, setTestEnv, startAuthorization } from './testkit';

const CIMD = 'https://client.example.test/agent.json';
const fetched: string[] = [];

vi.mock('node:dns', async (original) => {
  const dns = await original<typeof import('node:dns')>();
  const lookup = ((host: string, opts: object, cb: (...a: unknown[]) => void) =>
    host.endsWith('.example.test')
      ? cb(null, [{ address: '93.184.216.34', family: 4 }])
      : dns.lookup(host, opts, cb)) as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});

// Records what goes through the address-checked fetch, and serves the document
// instead of reaching the network.
vi.mock('@/lib/safe-fetch', async (original) => {
  const real = await original<typeof import('@/lib/safe-fetch')>();
  return {
    ...real,
    safeFetch: () => async (url: string | URL | Request) => {
      fetched.push(String(url));
      return Response.json({
        client_id: CIMD,
        client_name: 'Example Agent',
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1:9100/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    },
  };
});

setTestEnv();
const { config } = await import('./config');
const { createProvider } = await import('./provider');

let db: PGlite;

beforeAll(async () => {
  db = await useTestDb();
  (globalThis as { jawMcpProvider?: unknown }).jawMcpProvider = createProvider(config());
});

afterAll(() => db.close());

describe('the client metadata fetch', () => {
  it('goes through the fetch that connects only to the public address it checked', async () => {
    const start = await startAuthorization(new Browser(), { clientId: CIMD, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(fetched).toContain(CIMD);
    expect(start.uid).toBeDefined();
  });
});
