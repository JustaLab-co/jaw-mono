import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { Browser, setTestEnv, startAuthorization } from './testkit';

setTestEnv();

const sockets: Socket[] = [];
const silent: Server = createServer((s) => void sockets.push(s));
const listen = async (s: Server, host: string) => {
  await new Promise<void>((resolve) => s.listen(0, host, resolve));
  return (s.address() as AddressInfo).port;
};

let db: PGlite;
let silentPort: number;
let closedPort: number;
beforeAll(async () => {
  db = await useTestDb();
  silentPort = await listen(silent, '::');
  const scratch = createServer();
  closedPort = await listen(scratch, '127.0.0.1');
  await new Promise((r) => scratch.close(r));
});
afterAll(async () => {
  sockets.forEach((s) => s.destroy());
  await new Promise((r) => silent.close(r));
  await db.close();
});

let seq = 0;
async function attempt(host: string) {
  const t0 = performance.now();
  const r = await startAuthorization(new Browser(), {
    clientId: `https://${host}/meta-${++seq}.json`,
    redirectUri: 'http://127.0.0.1:9100/cb',
    scope: 'wallet:read',
  });
  const ms = performance.now() - t0;
  const html = r.stopped ? await r.stopped.text() : '';
  const field = (name: string) => html.match(new RegExp(`${name}</strong>: ([^<]*)`))?.[1];
  return { reachedConsent: Boolean(r.uid), error: field('error'), description: field('error_description'), ms };
}

const NOT_ALLOWED = {
  reachedConsent: false,
  error: 'invalid_client',
  description: 'client_id metadata document fetch not allowed',
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('given a client_id on a private address', () => {
  it.each([
    ['127.0.0.1', () => `127.0.0.1:${silentPort}`],
    ['localhost', () => `localhost:${silentPort}`],
    ['[::1]', () => `[::1]:${silentPort}`],
    ['10/8', () => '10.0.0.1'],
    ['169.254/16', () => '169.254.169.254'],
  ])(
    'when an authorization starts on %s, then invalid_client and no socket reaches the local server',
    async (_, host) => {
      const before = sockets.length;
      expect(await attempt(host())).toMatchObject(NOT_ALLOWED);
      expect(sockets.length).toBe(before);
    },
    15_000
  );

  it('when it is a silent port, then it is refused with the error a closed port gets, within 1 s of it', async () => {
    const sample = async (host: string) => [await attempt(host), await attempt(host), await attempt(host)];
    const closed = await sample(`127.0.0.1:${closedPort}`);
    const quiet = await sample(`127.0.0.1:${silentPort}`);
    expect(new Set([...closed, ...quiet].map((o) => `${o.error} ${o.description}`))).toEqual(
      new Set([`${closed[0].error} ${closed[0].description}`])
    );
    expect(closed[0].error).toBe('invalid_client');
    expect(median(quiet.map((o) => o.ms)) - median(closed.map((o) => o.ms))).toBeLessThan(1_000);
  }, 40_000);
});
