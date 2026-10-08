import { APPROVAL_TTL_MS, type SignedPayload } from '@jaw.id/agent';
import { verifyMessage, type Hex } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { callTool, connect, owner, setTestEnv, token, verifyLocally } from '@/connections/testkit';
import { eq } from 'drizzle-orm';
import { verifyBearer } from '@/connections/auth';
import { revokeByGrant } from '@/connections/rows';
import { getDb } from '@/db/client';
import { approvalRequests, connections } from '@/db/schema';
import { decideFromPage, outcomeResponse, readForPage } from './page-api';
import * as store from './store';
import { countPending } from './store';

setTestEnv();
beforeAll(useTestDb);

async function requestSignature(message = 'Sign in to example.com\nNonce: 8f2c') {
  const c = await connect();
  const result = await callTool(c.access_token, 'jaw_request_signature', { message });
  return { c, result, id: result.structuredContent?.requestId as string };
}

async function view(id: string) {
  const read = await readForPage(id);
  if (read.kind !== 'ok') throw new Error(read.kind);
  return read.view;
}

type Signer = ReturnType<typeof owner>;
const sign = (signer: Signer, p: SignedPayload) => {
  if (p.type === 'grant' || p.type === 'calls') throw new Error(`${p.type} is executed, not signed`);
  return p.type === 'message' ? signer.signMessage({ message: p.message }) : signer.signTypedData(p.typedData);
};
const messageOf = (p: SignedPayload) => {
  if (p.type !== 'message') throw new Error('not a message payload');
  return p.message;
};

describe('the wallet:send scope', () => {
  it('is what lets a connection ask for a signature; wallet:read alone is refused', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const refused = await callTool(reader.access_token, 'jaw_request_signature', { message: 'hello' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/wallet:send/);

    const sender = await connect(undefined, { scope: 'wallet:read wallet:send' });
    const asked = await callTool(sender.access_token, 'jaw_request_signature', { message: 'hello' });
    expect(asked.structuredContent).toMatchObject({ status: 'pending' });
  });
});

describe('the wallet:send scope on the token', () => {
  it('is refused once a refresh narrowed the token to wallet:read', async () => {
    const c = await connect();
    const narrowed = await token({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      client_id: 'jaw-cli',
      scope: 'wallet:read',
    });
    const refused = await callTool(narrowed.body.access_token, 'jaw_request_signature', { message: 'hello' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/wallet:send/);
  });
});

describe('input Postgres cannot store, and errors a client must not see', () => {
  it('refuses a message with a NUL or a lone surrogate before it reaches the database', async () => {
    const c = await connect();
    for (const message of ['a\u0000b', 'a\uD800b']) {
      const result = await callTool(c.access_token, 'jaw_request_signature', { message });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('The message contains a NUL character or a broken surrogate pair.');
    }
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    expect(await countPending(tenant.connectionId)).toBe(0);
  });

  it('answers a failing tool with a fixed text and keeps the SQL out of it', async () => {
    const c = await connect();
    const leak = Object.assign(new Error('Failed query: insert into "approval_requests" params: secret'), {
      cause: { code: '22P05' },
    });
    vi.spyOn(store, 'insertUnderCap').mockRejectedValueOnce(leak);
    const result = await callTool(c.access_token, 'jaw_request_signature', { message: 'hello' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/insert|params|secret|approval_requests/);
  });
});

describe('approvals', () => {
  it('round trip: the owner signs the stored message and status returns a signature that verifies', async () => {
    const { c, result, id } = await requestSignature();
    expect(result.structuredContent).toMatchObject({
      status: 'pending',
      account: c.signer.address,
      chainId: 'eip155:84532',
      approveUrl: `http://keys.test/approve/${id}`,
    });

    const v = await view(id);
    expect(messageOf(v.approve)).toBe('Sign in to example.com\nNonce: 8f2c');
    const signature = await sign(c.signer, v.approve);
    const decided = await decideFromPage(
      id,
      { verdict: 'approved', signature, previewHash: v.previewHash },
      verifyLocally
    );
    expect(decided).toMatchObject({ kind: 'ok', view: { status: 'approved' } });

    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent).toMatchObject({ status: 'approved', signature });
    expect(
      await verifyMessage({
        address: c.signer.address,
        message: messageOf(v.approve),
        signature: status.structuredContent.signature as Hex,
      })
    ).toBe(true);
  });

  it('verifies on the chain the request was made for', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const seen: number[] = [];
    const spy = async (a: Parameters<typeof verifyLocally>[0] & { chainId: number }) => {
      seen.push(a.chainId);
      return verifyLocally(a);
    };
    const signature = await sign(c.signer, v.approve);
    await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, spy);
    expect(seen).toEqual([v.chainId]);
  });

  it('refuses a second decision on the same request', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const approve = {
      verdict: 'approved',
      signature: await sign(c.signer, v.approve),
      previewHash: v.previewHash,
    };
    expect((await decideFromPage(id, approve, verifyLocally)).kind).toBe('ok');
    expect((await decideFromPage(id, approve, verifyLocally)).kind).toBe('not_pending');
    const reject = {
      verdict: 'rejected',
      signature: await sign(c.signer, v.reject),
      previewHash: v.previewHash,
    };
    expect(await decideFromPage(id, reject, verifyLocally)).toMatchObject({
      kind: 'not_pending',
      view: { status: 'approved' },
    });
  });

  it('refuses another account, for approve and for reject, and leaves the request pending', async () => {
    const { id } = await requestSignature();
    const v = await view(id);
    const stranger = owner();
    for (const [verdict, payload] of [
      ['approved', v.approve],
      ['rejected', v.reject],
    ] as const) {
      const signature = await sign(stranger, payload);
      expect((await decideFromPage(id, { verdict, signature, previewHash: v.previewHash }, verifyLocally)).kind).toBe(
        'bad_signature'
      );
    }
    expect((await view(id)).status).toBe('pending');
  });

  it('refuses a signature over anything other than the stored payload', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await c.signer.signMessage({ message: `${messageOf(v.approve)} ` });
    expect(
      (await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, verifyLocally)).kind
    ).toBe('bad_signature');
  });

  it('records a reject signed by the account', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await sign(c.signer, v.reject);
    expect(
      await decideFromPage(id, { verdict: 'rejected', signature, previewHash: v.previewHash }, verifyLocally)
    ).toMatchObject({
      kind: 'ok',
      view: { status: 'rejected' },
    });
    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent).toMatchObject({ status: 'rejected' });
    expect(status.structuredContent.signature).toBeUndefined();
  });

  it('refuses a decision after expiry and reports the request expired', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await sign(c.signer, v.approve);
    const late = new Date(Date.now() + APPROVAL_TTL_MS + 1000);
    expect(
      await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, verifyLocally, late)
    ).toMatchObject({
      kind: 'not_pending',
      view: { status: 'expired' },
    });
  });

  it('reports an unreachable chain as unavailable and leaves the request pending', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await sign(c.signer, v.approve);
    const down = async () => {
      throw new Error('rpc down');
    };
    expect((await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, down)).kind).toBe(
      'verification_unavailable'
    );
    expect((await view(id)).status).toBe('pending');
  });

  it('shows the requesting client id beside its self-declared name', async () => {
    const { id } = await requestSignature();
    expect((await view(id)).preview.requester).toMatchObject({ name: 'JAW CLI', clientId: 'jaw-cli', official: true });
  });

  it('caps the requests one connection can leave waiting', async () => {
    const c = await connect();
    for (let i = 0; i < 20; i++) {
      expect((await callTool(c.access_token, 'jaw_request_signature', { message: `m${i}` })).isError).toBeFalsy();
    }
    expect(await callTool(c.access_token, 'jaw_request_signature', { message: 'one too many' })).toMatchObject({
      isError: true,
    });
  });

  it('keeps the cap under 50 parallel requests: exactly 20 end up pending', async () => {
    const c = await connect();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => callTool(c.access_token, 'jaw_request_signature', { message: `p${i}` }))
    );
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    expect(await countPending(tenant.connectionId)).toBe(20);
  });

  it('refuses a decision once the connection is revoked', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    const [row] = await getDb().select().from(connections).where(eq(connections.id, tenant.connectionId));
    await revokeByGrant(row.grantId as string);
    const signature = await sign(c.signer, v.approve);
    expect(
      (await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, verifyLocally)).kind
    ).toBe('connection_revoked');
    expect((await view(id)).status).toBe('pending');
  });

  it('refuses a decision once the connection has expired', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    await getDb()
      .update(connections)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(connections.id, tenant.connectionId));
    const signature = await sign(c.signer, v.approve);
    expect(
      (await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, verifyLocally)).kind
    ).toBe('connection_revoked');
  });

  it('does not record a decision when the connection is revoked while the signature is checked', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as { connectionId: string };
    const [row] = await getDb().select().from(connections).where(eq(connections.id, tenant.connectionId));
    const revokingVerify = async (a: Parameters<typeof verifyLocally>[0]) => {
      await revokeByGrant(row.grantId as string);
      return verifyLocally(a);
    };
    const signature = await sign(c.signer, v.approve);
    expect(
      (await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, revokingVerify)).kind
    ).toBe('connection_revoked');
    expect((await view(id)).status).toBe('pending');
  });

  it('refuses a request on a chain the server cannot verify, with a 4xx, and leaves it pending', async () => {
    const { c, id } = await requestSignature();
    await getDb().update(approvalRequests).set({ chainId: 1 }).where(eq(approvalRequests.id, id));
    const v = await view(id);
    const signature = await sign(c.signer, v.approve);
    const outcome = await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash });
    expect(outcome.kind).toBe('unsupported_chain');
    expect(outcomeResponse(outcome).status).toBe(422);
    expect((await view(id)).status).toBe('pending');
  });

  it('refuses when the page rendered a different preview', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await sign(c.signer, v.approve);
    const stale = `0x${'00'.repeat(32)}`;
    expect((await decideFromPage(id, { verdict: 'approved', signature, previewHash: stale }, verifyLocally)).kind).toBe(
      'preview_changed'
    );
  });

  it('hides a request from every other connection', async () => {
    const { id } = await requestSignature();
    const other = await connect();
    const status = await callTool(other.access_token, 'jaw_request_status', { requestId: id });
    expect(status).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'No such request for this connection.' }],
    });
    expect(JSON.stringify(status)).not.toContain('example.com');
  });

  it('refuses messages that start with the reserved prefix', async () => {
    const { result } = await requestSignature('JAW connection consent\nInteraction: abc');
    expect(result).toMatchObject({ isError: true });
  });

  it('answers not_found for malformed and unknown ids', async () => {
    expect((await readForPage('../../x')).kind).toBe('not_found');
    expect((await readForPage('AAAAAAAAAAAAAAAAAAAAAA')).kind).toBe('not_found');
  });
});
