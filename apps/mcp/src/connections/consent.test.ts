import { consentTypedData } from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { verifyBearer } from './auth';
import { consent, type ConsentDetails } from './interaction';
import { provider } from './provider';
import {
  Browser,
  callTool,
  connect,
  follow,
  getDetails,
  ISSUER,
  owner,
  postConsent,
  REDIRECT,
  setTestEnv,
  startAuthorization,
} from './testkit';

setTestEnv();

beforeAll(useTestDb);

async function pending() {
  const browser = new Browser();
  const { uid } = await startAuthorization(browser);
  return { browser, uid: uid!, details: await getDetails(uid!) };
}

describe('consent hand-back', () => {
  it('builds the typed data from the interaction: client, scopes, chain, expiry and interaction id', async () => {
    const { uid, details } = await pending();
    expect(details.client).toEqual({
      clientId: 'jaw-cli',
      name: 'JAW CLI',
      host: null,
      official: true,
      reservedName: false,
    });
    expect(details.scopes).toEqual([
      { id: 'wallet:read', label: 'See your account, balances and payment history', required: true },
      { id: 'x402:pay', label: 'Pay x402 services from a daily USDC budget you approve', required: false },
      { id: 'wallet:send', label: 'Ask you to approve transfers, contract calls and signatures', required: false },
    ]);
    expect(details.typedData.domain).toEqual({ name: 'JAW', version: '1', chainId: 84532 });
    expect(details.typedData.message).toEqual({
      issuer: ISSUER,
      interaction: uid,
      clientId: 'jaw-cli',
      clientName: 'JAW CLI',
      scopes: 'wallet:read x402:pay wallet:send',
      expires: details.expiresAt,
    });
  });

  it.each([
    ['no scope at all', null, ['wallet:read']],
    ['only openid offline_access', 'openid offline_access', ['wallet:read']],
    ['wallet:read wallet:send', 'wallet:read wallet:send', ['wallet:read', 'wallet:send']],
    ['wallet:read x402:pay', 'wallet:read x402:pay', ['wallet:read', 'x402:pay']],
    ['the scopes out of order', 'wallet:send x402:pay wallet:read', ['wallet:read', 'x402:pay', 'wallet:send']],
    ['prototype keys next to wallet:read', 'constructor wallet:read toString', ['wallet:read']],
    ['prototype keys alone', 'constructor toString', ['wallet:read']],
  ])('serves an authorization with %s', async (_name, scope, expected) => {
    const { uid } = await startAuthorization(new Browser(), { scope });
    expect(uid).toBeDefined();
    expect((await getDetails(uid!)).scopes.map((s) => s.id)).toEqual(expected);
  });

  it.each(['wallet:send', 'x402:pay', 'x402:pay wallet:send'])(
    'refuses %s without wallet:read at the authorization endpoint, back to the client',
    async (scope) => {
      const start = await startAuthorization(new Browser(), { scope });
      expect(start.uid).toBeUndefined();
      expect(start.redirected?.searchParams.get('error')).toBe('invalid_scope');
    }
  );

  it('signs the scopes in canonical order, whatever order the client asked in', async () => {
    const { uid } = await startAuthorization(new Browser(), { scope: 'wallet:send x402:pay wallet:read' });
    expect((await getDetails(uid!)).typedData.message.scopes).toBe('wallet:read x402:pay wallet:send');
  });

  it('refuses a signature made for another interaction', async () => {
    const a = await pending();
    const b = await pending();
    const signer = owner();
    const res = await postConsent(b.uid, signer.address, await signer.signTypedData(a.details.typedData));
    expect(res.status).toBe(401);
    expect(await getDb().select().from(connections)).not.toContainEqual(
      expect.objectContaining({ interactionUid: b.uid })
    );
  });

  it('refuses a plain message signature over the consent terms, as a phishing page would collect', async () => {
    const { uid, details } = await pending();
    const victim = owner();
    const text = Object.entries(details.typedData.message)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const res = await postConsent(uid, victim.address, await victim.signMessage({ message: text }));
    expect(res.status).toBe(401);
  });

  it('refuses a signature from an account other than the one claimed', async () => {
    const { uid, details } = await pending();
    const res = await postConsent(uid, owner().address, await owner().signTypedData(details.typedData));
    expect(res.status).toBe(401);
  });

  it('answers 503, not bad_signature, when the chain cannot be asked', async () => {
    const { uid, details } = await pending();
    const signer = owner();
    const res = await consent(
      new Request(`${ISSUER}/interaction/${uid}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          address: signer.address,
          signature: await signer.signTypedData(details.typedData),
        }),
      }),
      uid,
      async () => {
        throw new Error('rpc down');
      }
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'verification_unavailable' });
  });

  it('accepts one consent per interaction', async () => {
    const { uid, details } = await pending();
    const signer = owner();
    const signature = await signer.signTypedData(details.typedData);
    expect((await postConsent(uid, signer.address, signature)).status).toBe(200);
    expect((await postConsent(uid, signer.address, signature)).status).toBe(409);
  });

  it('needs both the ticket and the browser that started the authorization', async () => {
    const attacker = await pending();
    const victim = owner();
    const res = await postConsent(attacker.uid, victim.address, await victim.signTypedData(attacker.details.typedData));
    const { next } = (await res.json()) as { next: string };

    const victimBrowser = new Browser();
    expect((await victimBrowser.get(next)).status).toBe(400);
    const guessed = `${ISSUER}/interaction/${attacker.uid}/complete?ticket=guess`;
    expect((await attacker.browser.get(guessed)).status).toBe(400);
    const [row] = await getDb().select().from(connections).where(eq(connections.interactionUid, attacker.uid));
    expect(row.status).toBe('pending');
  });

  it('completes once; the ticket is spent', async () => {
    const { browser, uid, details } = await pending();
    const signer = owner();
    const res = await postConsent(uid, signer.address, await signer.signTypedData(details.typedData));
    const { next } = (await res.json()) as { next: string };
    expect((await follow(browser, next)).searchParams.get('code')).toBeTruthy();
    expect((await new Browser().get(next)).status).toBe(400);
  });

  it('does not leave a connection active when the hand-back to the client fails', async () => {
    const { browser, uid, details } = await pending();
    const signer = owner();
    const res = await postConsent(uid, signer.address, await signer.signTypedData(details.typedData));
    const { next } = (await res.json()) as { next: string };
    const spy = vi.spyOn(provider(), 'interactionFinished').mockRejectedValueOnce(new Error('hand-back failed'));
    const failed = await browser.get(next).catch(() => undefined);
    spy.mockRestore();
    expect(failed?.status ?? 500).toBeGreaterThanOrEqual(400);
    const [row] = await getDb().select().from(connections).where(eq(connections.interactionUid, uid));
    expect(row.status).not.toBe('active');
  });

  it('stops honoring a token once its connection expires', async () => {
    const c = await connect();
    const sub = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    await getDb()
      .update(connections)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(connections.id, sub.connectionId));
    expect(await verifyBearer(c.access_token)).toBeUndefined();
  });

  it('sends the user back to the client with access_denied on abort', async () => {
    const { browser, uid } = await pending();
    const back = await follow(browser, `${ISSUER}/interaction/${uid}/abort`, REDIRECT);
    expect(back.searchParams.get('error')).toBe('access_denied');
  });
});

const signedFor = (d: ConsentDetails, scopes: string) =>
  consentTypedData(d.chainId, { ...d.typedData.message, scopes });
const rowsOf = (uid: string) => getDb().select().from(connections).where(eq(connections.interactionUid, uid));

describe('given an authorization for all three scopes, when the user narrows them at consent', () => {
  it('when wallet:send is unticked, then the row and the token hold wallet:read x402:pay and jaw_prepare_transfer is refused', async () => {
    const c = await connect(undefined, {}, undefined, ['wallet:read', 'x402:pay']);
    expect(c.scope).toBe('wallet:read x402:pay');
    expect((await rowsOf(c.uid))[0].scopes).toEqual(['wallet:read', 'x402:pay']);
    const result = await callTool(c.access_token, 'jaw_prepare_transfer', {
      to: '0x2222222222222222222222222222222222222222',
      amount: '0.01',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not granted wallet:send.');
  });

  it('when the POST carries no scopes field, then every requested scope is granted', async () => {
    const c = await connect();
    expect(c.scope).toBe('wallet:read x402:pay wallet:send');
  });

  it('when the POST lists the chosen scopes out of order, then the server checks the signature over the canonical order', async () => {
    const { uid, details } = await pending();
    const signer = owner();
    const signature = await signer.signTypedData(signedFor(details, 'wallet:read x402:pay'));
    const res = await postConsent(uid, signer.address, signature, ['x402:pay', 'wallet:read']);
    expect(res.status).toBe(200);
    expect((await rowsOf(uid))[0].scopes).toEqual(['wallet:read', 'x402:pay']);
  });

  it('when the POST repeats a scope, then it is granted once', async () => {
    const { uid, details } = await pending();
    const signer = owner();
    const signature = await signer.signTypedData(signedFor(details, 'wallet:read x402:pay'));
    const res = await postConsent(uid, signer.address, signature, ['wallet:read', 'wallet:read', 'x402:pay']);
    expect(res.status).toBe(200);
    expect((await rowsOf(uid))[0].scopes).toEqual(['wallet:read', 'x402:pay']);
  });

  it('when the user signed wallet:read x402:pay but the POST says all three, then bad_signature and no row', async () => {
    const { uid, details } = await pending();
    const signer = owner();
    const signature = await signer.signTypedData(signedFor(details, 'wallet:read x402:pay'));
    const res = await postConsent(uid, signer.address, signature, ['wallet:read', 'x402:pay', 'wallet:send']);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_signature' });
    expect(await rowsOf(uid)).toEqual([]);
  });

  it.each([
    ['empty', []],
    ['without wallet:read', ['x402:pay']],
    ['with a prototype key', ['wallet:read', 'constructor']],
    ['with an unknown id', ['wallet:read', 'wallet:admin']],
  ])('when the chosen set is %s, signed as sent, then invalid_scope and no row', async (_name, scopes) => {
    const { uid, details } = await pending();
    const signer = owner();
    const signature = await signer.signTypedData(signedFor(details, scopes.join(' ')));
    const res = await postConsent(uid, signer.address, signature, scopes);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
    expect(await rowsOf(uid)).toEqual([]);
  });

  it.each([
    ['a string', 'wallet:read'],
    ['null', null],
    ['a non-string entry', ['wallet:read', 1]],
    ['more than three entries', ['wallet:read', 'wallet:read', 'x402:pay', 'wallet:send']],
  ])('when scopes is %s, then invalid_request and no row', async (_name, scopes) => {
    const { uid, details } = await pending();
    const signer = owner();
    const res = await postConsent(uid, signer.address, await signer.signTypedData(details.typedData), scopes);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(await rowsOf(uid)).toEqual([]);
  });

  it('given a consent already recorded, when a second POST narrows the scopes, then 409 already_consented', async () => {
    const { uid, details } = await pending();
    const signer = owner();
    expect((await postConsent(uid, signer.address, await signer.signTypedData(details.typedData))).status).toBe(200);
    const narrowed = await signer.signTypedData(signedFor(details, 'wallet:read'));
    const res = await postConsent(uid, signer.address, narrowed, ['wallet:read']);
    expect(res.status).toBe(409);
    expect((await rowsOf(uid))[0].scopes).toEqual(['wallet:read', 'x402:pay', 'wallet:send']);
  });
});

describe('given an authorization for wallet:read x402:pay', () => {
  it('when the POST asks for wallet:send too, signed over that, then invalid_scope and no row', async () => {
    const { uid } = await startAuthorization(new Browser(), { scope: 'wallet:read x402:pay' });
    const details = await getDetails(uid!);
    const signer = owner();
    const all = ['wallet:read', 'x402:pay', 'wallet:send'];
    const signature = await signer.signTypedData(signedFor(details, all.join(' ')));
    const res = await postConsent(uid!, signer.address, signature, all);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
    expect(await rowsOf(uid!)).toEqual([]);
  });
});
