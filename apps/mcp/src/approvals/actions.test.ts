import { rejectionTypedData, type ApprovalPageView, type Call, type GasQuote, type SignedPayload } from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, connect, setTestEnv, verifyLocally } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { approvalRequests } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import * as read from '@/tools/read';
import * as bundler from './bundler';
import type { ReadUserOp } from './bundler';
import { decideFromPage, outcomeResponse, readForPage } from './page-api';

setTestEnv();
beforeAll(useTestDb);

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ALICE: Address = '0x2222222222222222222222222222222222222222';
const PAYMASTER: Address = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';
const GAS: GasQuote = { estimate: '21000', context: { token: USDC, gas: '90000' } };
const CALLS_ID: Hex = `0x${'c1'.repeat(32)}`;
const TX: Hex = `0x${'7a'.repeat(32)}`;

const quote = vi.spyOn(bundler, 'quoteGas');
const resolve = vi.spyOn(read, 'resolveName');
beforeEach(() => {
  quote.mockReset().mockResolvedValue(GAS);
  resolve.mockReset().mockImplementation(async (name) => ({
    name,
    address: name === 'alice.eth' ? ALICE : null,
    chainId: 'eip155:1',
    summary: '',
  }));
});

async function view(id: string) {
  const outcome = await readForPage(id);
  if (outcome.kind !== 'ok') throw new Error(outcome.kind);
  return outcome.view;
}

const callsOf = (payload: SignedPayload) => {
  if (payload.type !== 'calls') throw new Error(`not calls: ${payload.type}`);
  return payload.calls;
};

const approveFor = (amount: bigint) => ({
  to: USDC,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PAYMASTER, amount] }),
});

/** A bundler that saw the userOp ran these calls from this sender. */
const ran =
  (calls: { to: Address; value: bigint; data: Hex }[], sender?: Address, success = true): ReadUserOp =>
  async ({ account }) => ({ status: 'included', success, sender: sender ?? account, txHash: TX, calls });

const asExecuted = (calls: Call[]) => calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }));

async function decideCalls(id: string, v: ApprovalPageView, readUserOp: ReadUserOp) {
  return decideFromPage(
    id,
    { verdict: 'approved', callsId: CALLS_ID, previewHash: v.previewHash },
    verifyLocally,
    new Date(),
    undefined,
    readUserOp
  );
}

async function prepareTransfer(to = 'alice.eth', amount = '0.01') {
  const c = await connect();
  const result = await callTool(c.access_token, 'jaw_prepare_transfer', { to, amount });
  return { c, result, id: result.structuredContent?.requestId as string };
}

describe('jaw_prepare_transfer', () => {
  it('resolves the ENS name on the server and previews name, address, amount and gas in USDC', async () => {
    const { c, result, id } = await prepareTransfer();
    expect(result.structuredContent).toMatchObject({ status: 'pending', account: c.signer.address });
    const v = await view(id);
    expect(v.preview).toMatchObject({
      kind: 'transfer',
      to: ALICE,
      name: 'alice.eth',
      token: USDC,
      amount: '10000',
      gas: { token: USDC, estimate: '21000', max: '90000' },
    });
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ALICE, 10_000n] });
    expect(callsOf(v.approve)).toEqual([{ to: USDC, value: '0x0', data: transfer }]);
    expect(v.paymaster).toEqual(GAS.context);
    expect(quote).toHaveBeenCalledWith(c.signer.address, 84532, [{ to: USDC, value: '0x0', data: transfer }]);
  });

  it('takes an address as is, without ENS', async () => {
    const { id } = await prepareTransfer(ALICE, '1');
    expect((await view(id)).preview).toMatchObject({ kind: 'transfer', to: ALICE, amount: '1000000' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a name that does not resolve, and stores nothing', async () => {
    const { result } = await prepareTransfer('nobody.eth');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nobody\.eth does not resolve/);
    expect(quote).not.toHaveBeenCalled();
  });

  it('refuses with the reason when the gas cannot be quoted, and stores nothing', async () => {
    quote.mockRejectedValueOnce(new Error('execution reverted'));
    const { c, result } = await prepareTransfer();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/gas/i);
    const rows = await getDb().select().from(approvalRequests).where(eq(approvalRequests.account, c.signer.address));
    expect(rows).toEqual([]);
  });

  it('round trip: the page sends the stored calls, the server checks the bundler, status shows the transaction', async () => {
    const { c, id } = await prepareTransfer();
    const v = await view(id);
    const executed = [approveFor(90_000n), ...asExecuted(callsOf(v.approve))];
    const decided = await decideCalls(id, v, ran(executed));
    expect(decided).toMatchObject({ kind: 'ok', view: { status: 'approved' } });
    const status = await callTool(c.access_token, 'jaw_request_status', { requestId: id });
    expect(status.structuredContent).toMatchObject({ status: 'approved', callsId: CALLS_ID, txHash: TX });
  });
});

describe('jaw_prepare_calls', () => {
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ALICE, 5n] });
  const CALLS = [
    { to: USDC, data: transfer },
    { to: ALICE, data: '0xdeadbeef', value: '1' },
  ];

  async function prepareCalls(calls: object[] = CALLS) {
    const c = await connect();
    const result = await callTool(c.access_token, 'jaw_prepare_calls', { calls });
    return { c, result, id: result.structuredContent?.requestId as string };
  }

  it('previews decoded calls and raw calldata with a warning, and serves the calls unchanged', async () => {
    const { id } = await prepareCalls();
    const v = await view(id);
    expect(v.preview).toMatchObject({
      kind: 'calls',
      calls: [
        { to: USDC, function: 'transfer(address,uint256)', warnings: [] },
        { to: ALICE, data: '0xdeadbeef', value: '0x1', warnings: [{ code: 'unknown_function' }] },
      ],
      gas: { estimate: '21000', max: '90000' },
    });
    expect(callsOf(v.approve)).toEqual([
      { to: USDC, data: transfer, value: '0x0' },
      { to: ALICE, data: '0xdeadbeef', value: '0x1' },
    ]);
  });

  it('refuses more than ten calls', async () => {
    const { result } = await prepareCalls(Array.from({ length: 11 }, () => CALLS[0]));
    expect(result.isError).toBe(true);
  });

  it('refuses executed calls that differ from the stored ones, and leaves the request pending', async () => {
    const { id } = await prepareCalls();
    const v = await view(id);
    const [first, second] = asExecuted(callsOf(v.approve));
    const outcome = await decideCalls(id, v, ran([first, { ...second, data: '0xdeadbeee' }]));
    expect(outcome.kind).toBe('calls_mismatch');
    expect(outcomeResponse(outcome).status).toBe(422);
    expect((await view(id)).status).toBe('pending');
  });

  it('refuses calls run by another sender, or that reverted', async () => {
    const { id } = await prepareCalls();
    const v = await view(id);
    const executed = asExecuted(callsOf(v.approve));
    expect((await decideCalls(id, v, ran(executed, ALICE))).kind).toBe('calls_mismatch');
    expect((await decideCalls(id, v, ran(executed, undefined, false))).kind).toBe('calls_mismatch');
  });

  it('asks the page to retry while the userOp is not mined, and says when the bundler cannot be read', async () => {
    const { id } = await prepareCalls();
    const v = await view(id);
    const pending = await decideCalls(id, v, async () => ({ status: 'pending' }));
    expect(pending.kind).toBe('calls_pending');
    expect(outcomeResponse(pending).status).toBe(409);
    const down = await decideCalls(id, v, async () => {
      throw new Error('bundler down');
    });
    expect(down.kind).toBe('verification_unavailable');
  });

  it('refuses by hash a stored payload changed after the preview', async () => {
    const { id } = await prepareCalls();
    const v = await view(id);
    const [row] = await getDb().select().from(approvalRequests).where(eq(approvalRequests.id, id));
    const body = row.body as { calls: Call[] };
    body.calls[1].data = '0xdeadbeee';
    await getDb().update(approvalRequests).set({ body }).where(eq(approvalRequests.id, id));
    const outcome = await decideCalls(id, v, ran(asExecuted(callsOf(v.approve))));
    expect(outcome.kind).toBe('preview_changed');
    expect(outcomeResponse(outcome).status).toBe(409);
  });

  it('records a reject signed under the JAW domain', async () => {
    const { c, id } = await prepareCalls();
    const v = await view(id);
    const signature = await c.signer.signTypedData(rejectionTypedData(84532, id));
    const outcome = await decideFromPage(
      id,
      { verdict: 'rejected', signature, previewHash: v.previewHash },
      verifyLocally
    );
    expect(outcome).toMatchObject({ kind: 'ok', view: { status: 'rejected' } });
  });
});

describe('the wallet:send scope on the prepare tools', () => {
  it('refuses both prepare tools on a wallet:read connection', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    for (const [tool, args] of [
      ['jaw_prepare_transfer', { to: ALICE, amount: '1' }],
      ['jaw_prepare_calls', { calls: [{ to: ALICE, data: '0x' }] }],
    ] as const) {
      const refused = await callTool(reader.access_token, tool, args);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/wallet:send/);
    }
    expect(quote).not.toHaveBeenCalled();
  });
});

describe('jaw_request_signature with typed data', () => {
  const MAIL = {
    domain: { name: 'Mail', version: '1', chainId: 84532 },
    types: { Mail: [{ name: 'contents', type: 'string' }] },
    primaryType: 'Mail',
    message: { contents: 'hello' },
  };

  it('refuses typed data under the reserved JAW domain', async () => {
    const c = await connect();
    const result = await callTool(c.access_token, 'jaw_request_signature', {
      typedData: rejectionTypedData(84532, 'q3L0x7mJ2c1VfN8aYw4p9A'),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/JAW/);
  });

  it('takes exactly one of message and typed data', async () => {
    const c = await connect();
    expect((await callTool(c.access_token, 'jaw_request_signature', {})).isError).toBe(true);
    expect((await callTool(c.access_token, 'jaw_request_signature', { message: 'hi', typedData: MAIL })).isError).toBe(
      true
    );
  });

  it('round trip: the owner signs the stored typed data and the server verifies it', async () => {
    const c = await connect();
    const asked = await callTool(c.access_token, 'jaw_request_signature', { typedData: MAIL });
    const id = asked.structuredContent.requestId as string;
    const v = await view(id);
    expect(v.preview).toMatchObject({ kind: 'typed-data', primaryType: 'Mail', warnings: [] });
    if (v.approve.type !== 'typed_data') throw new Error('not typed data');
    const signature = await c.signer.signTypedData(v.approve.typedData);
    const outcome = await decideFromPage(
      id,
      { verdict: 'approved', signature, previewHash: v.previewHash },
      verifyLocally
    );
    expect(outcome).toMatchObject({ kind: 'ok', view: { status: 'approved' } });
  });
});

describe('Sign in with Ethereum through jaw_request_signature', () => {
  const login = (address: Address, chainId = 84532) =>
    createSiweMessage({
      address,
      chainId,
      domain: 'app.example',
      uri: 'https://app.example/login',
      version: '1',
      nonce: 'n0nce1234',
      issuedAt: new Date(),
    });

  it('refuses a login for another address or chain', async () => {
    const c = await connect();
    const other = await callTool(c.access_token, 'jaw_request_signature', { message: login(ALICE) });
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toMatch(/another account/);
    const chain = await callTool(c.access_token, 'jaw_request_signature', { message: login(c.signer.address, 8453) });
    expect(chain.isError).toBe(true);
  });

  it('previews a login with a warning naming the site, and verifies the signed message', async () => {
    const c = await connect();
    const message = login(c.signer.address);
    const asked = await callTool(c.access_token, 'jaw_request_signature', { message });
    const id = asked.structuredContent.requestId as string;
    const v = await view(id);
    expect(v.preview).toMatchObject({ kind: 'siwe', domain: 'app.example', warnings: ['siwe_login'] });
    expect(v.approve).toEqual({ type: 'message', message });
    const signature = await c.signer.signMessage({ message });
    const outcome = await decideFromPage(
      id,
      { verdict: 'approved', signature, previewHash: v.previewHash },
      verifyLocally
    );
    expect(outcome).toMatchObject({ kind: 'ok', view: { status: 'approved' } });
  });
});
