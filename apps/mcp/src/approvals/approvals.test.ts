import { APPROVAL_TTL_MS } from '@jaw.id/agent';
import { verifyMessage, type Hex } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { callTool, connect, owner, setTestEnv, verifyLocally } from '@/connections/testkit';
import { verifyBearer } from '@/connections/auth';
import { decideFromPage, readForPage } from './page-api';
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
    expect(v.approve.message).toBe('Sign in to example.com\nNonce: 8f2c');
    const signature = await c.signer.signMessage({ message: v.approve.message });
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
        message: v.approve.message,
        signature: status.structuredContent.signature as Hex,
      })
    ).toBe(true);
  });

  it('refuses a second decision on the same request', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const approve = {
      verdict: 'approved',
      signature: await c.signer.signMessage({ message: v.approve.message }),
      previewHash: v.previewHash,
    };
    expect((await decideFromPage(id, approve, verifyLocally)).kind).toBe('ok');
    expect((await decideFromPage(id, approve, verifyLocally)).kind).toBe('not_pending');
    const reject = {
      verdict: 'rejected',
      signature: await c.signer.signMessage({ message: v.reject.message }),
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
    for (const [verdict, message] of [
      ['approved', v.approve.message],
      ['rejected', v.reject.message],
    ] as const) {
      const signature = await stranger.signMessage({ message });
      expect((await decideFromPage(id, { verdict, signature, previewHash: v.previewHash }, verifyLocally)).kind).toBe(
        'bad_signature'
      );
    }
    expect((await view(id)).status).toBe('pending');
  });

  it('refuses a signature over anything other than the stored payload', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await c.signer.signMessage({ message: `${v.approve.message} ` });
    expect(
      (await decideFromPage(id, { verdict: 'approved', signature, previewHash: v.previewHash }, verifyLocally)).kind
    ).toBe('bad_signature');
  });

  it('records a reject signed by the account', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await c.signer.signMessage({ message: v.reject.message });
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
    const signature = await c.signer.signMessage({ message: v.approve.message });
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
    const signature = await c.signer.signMessage({ message: v.approve.message });
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

  it('refuses when the page rendered a different preview', async () => {
    const { c, id } = await requestSignature();
    const v = await view(id);
    const signature = await c.signer.signMessage({ message: v.approve.message });
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
