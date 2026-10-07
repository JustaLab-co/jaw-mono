import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { consent } from './interaction';
import {
  Browser,
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
  it('builds the message from the interaction: client, scopes, chain and interaction id', async () => {
    const { uid, details } = await pending();
    expect(details.client).toEqual({ id: 'jaw-cli', name: 'JAW CLI', host: null });
    expect(details.scopes).toEqual([{ id: 'wallet:read', label: expect.any(String) }]);
    expect(details.message.split('\n')[0]).toBe('JAW connection consent');
    expect(details.message).toContain(`Interaction: ${uid}`);
    expect(details.message).toContain('Scopes: wallet:read');
    expect(details.message).toContain('Chain ID: 84532');
  });

  it('refuses a signature made for another interaction', async () => {
    const a = await pending();
    const b = await pending();
    const signer = owner();
    const res = await postConsent(b.uid, signer.address, await signer.signMessage({ message: a.details.message }));
    expect(res.status).toBe(401);
    expect(await getDb().select().from(connections)).not.toContainEqual(
      expect.objectContaining({ interactionUid: b.uid })
    );
  });

  it('refuses a signature from an account other than the one claimed', async () => {
    const { uid, details } = await pending();
    const res = await postConsent(uid, owner().address, await owner().signMessage({ message: details.message }));
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
          signature: await signer.signMessage({ message: details.message }),
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
    const signature = await signer.signMessage({ message: details.message });
    expect((await postConsent(uid, signer.address, signature)).status).toBe(200);
    expect((await postConsent(uid, signer.address, signature)).status).toBe(409);
  });

  it('needs both the ticket and the browser that started the authorization', async () => {
    const attacker = await pending();
    const victim = owner();
    const res = await postConsent(
      attacker.uid,
      victim.address,
      await victim.signMessage({ message: attacker.details.message })
    );
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
    const res = await postConsent(uid, signer.address, await signer.signMessage({ message: details.message }));
    const { next } = (await res.json()) as { next: string };
    expect((await follow(browser, next)).searchParams.get('code')).toBeTruthy();
    expect((await new Browser().get(next)).status).toBe(400);
  });

  it('sends the user back to the client with access_denied on abort', async () => {
    const { browser, uid } = await pending();
    const back = await follow(browser, `${ISSUER}/interaction/${uid}/abort`, REDIRECT);
    expect(back.searchParams.get('error')).toBe('access_denied');
  });
});
