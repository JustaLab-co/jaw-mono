import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(`${repo}/package.json`);
const { encodeFunctionData, erc20Abi, getAddress, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const payer = privateKeyToAccount('0x' + '11'.repeat(32));
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seller-test-'));
const logFile = path.join(dir, 'seller.log');
let seller;
let base;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  seller = spawn('node', [path.join(here, 'seller.mjs'), repo, String(port), logFile], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(logFile), 'seller did not start');
});

after(() => {
  seller.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

const logRows = () =>
  fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const control = (params) => fetch(`${base}/_swap?${new URLSearchParams(params)}`, { method: 'POST' });

const DEPOSITORY = getAddress('0x4cd00e387622c35bddb9b4c962c136462338bc31');
const requestOf = (q) => q.quoteId.slice('relay:'.length);

const ACCOUNT = '0x742149f6aB17d7d2FD3A29ae2782b26EDa9c6F82';
const ERC20_QUERY = {
  originChainId: '84532',
  destinationChainId: '42161',
  originToken: USDC.toLowerCase(),
  destinationToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  amount: '10000',
  depositor: ACCOUNT,
  recipient: ACCOUNT,
  tradeType: 'EXACT_INPUT',
};
const NATIVE_QUERY = { ...ERC20_QUERY, originToken: '0x0000000000000000000000000000000000000000' };
const moveQuoteUrl = (query) => `${base}/proxy/v2/move-asset/quote?${new URLSearchParams(query)}`;
const fixture = (p) => JSON.parse(fs.readFileSync(`${repo}/apps/mcp/src/swap/fixtures/prod-${p}-quote.json`, 'utf8'));

async function proof(nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))) {
  const authorization = {
    from: payer.address,
    to: PAY_TO,
    value: '5000',
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce,
  };
  const signature = await payer.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      ...authorization,
      value: 5000n,
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
    },
  });
  return { header: b64({ x402Version: 2, payload: { authorization, signature } }), nonce };
}

test('given a valid proof, /exact still answers 200 with the payer', async () => {
  const { header } = await proof();
  const res = await fetch(`${base}/exact`, { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).paidBy, payer.address);
  assert.equal(unb64(res.headers.get('payment-response')).network, 'eip155:84532');
});

test('given an EVM query with no key and no payment, move-asset/quote answers a Relay quote', async () => {
  const res = await fetch(moveQuoteUrl(ERC20_QUERY));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('payment-required'), null);
  const { data } = (await res.json()).result;
  assert.equal(data.provider, 'relay');
  assert.match(data.quoteId, /^relay:0x[0-9a-f]{64}$/);
});

test('given mode across or relay, move-asset/quote answers the quote captured from prod as it came', async () => {
  for (const provider of ['across', 'relay']) {
    await control({ mode: provider });
    const res = await fetch(moveQuoteUrl(ERC20_QUERY));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), fixture(provider));
  }
  await control({ mode: '' });
});

test('given mode 422 or 502, move-asset/quote answers the NoProviderAvailable envelope', async () => {
  for (const status of [422, 502]) {
    await control({ mode: String(status) });
    const res = await fetch(moveQuoteUrl(ERC20_QUERY));
    assert.equal(res.status, status);
    assert.match((await res.json()).result.error, /^NoProviderAvailable: aurora=/);
  }
  await control({ mode: '' });
});

const moveQuote = async (query = ERC20_QUERY) => (await (await fetch(moveQuoteUrl(query))).json()).result.data;

test('given an ERC-20 query, the single deposit is transfer(depository, amount) on the token', async () => {
  const q = await moveQuote();
  assert.equal(q.inputAmount, '10000');
  assert.ok(BigInt(q.minOutputAmount) > 0n && BigInt(q.minOutputAmount) <= BigInt(q.expectedOutputAmount));
  assert.deepEqual(q.transactions, [
    {
      chainId: 84532,
      to: getAddress(USDC),
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [DEPOSITORY, 10000n] }),
      value: '0',
      description: 'deposit',
    },
  ]);
  assert.equal(q.deposit, undefined);
});

test('given a native query, the deposit sends the amount to the depository with no data', async () => {
  const q = await moveQuote(NATIVE_QUERY);
  assert.deepEqual(q.transactions, [
    { chainId: 84532, to: DEPOSITORY, data: '0x', value: '10000', description: 'deposit' },
  ]);
});

test('given two quotes, each gets a fresh request id', async () => {
  assert.notEqual((await moveQuote()).quoteId, (await moveQuote()).quoteId);
});

test('given mode invalid, move-asset/quote answers 200 with a body that is not a quote', async () => {
  await control({ mode: 'invalid' });
  const res = await fetch(moveQuoteUrl(ERC20_QUERY));
  await control({ mode: '' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.data, null);
});

test('given each quote check mode, the quote breaks only that rule', async () => {
  const cases = {
    'two-tx': (q) => assert.equal(q.transactions.length, 2),
    'no-tx': (q) => assert.equal(q.transactions.length, 0),
    'wrong-chain': (q) => assert.equal(q.transactions[0].chainId, 84533),
    'quote-id': (q) => assert.doesNotMatch(q.quoteId, /^relay:0x[0-9a-f]{64}$/),
    provider: (q) => assert.notEqual(q.provider, 'relay'),
  };
  for (const [mode, expect] of Object.entries(cases)) {
    await control({ mode });
    expect(await moveQuote());
  }
  await control({ mode: 'reused' });
  const first = await moveQuote();
  const again = await moveQuote();
  await control({ mode: '' });
  assert.equal(again.quoteId, first.quoteId, 'reused repeats the previous request id');
  assert.notEqual((await moveQuote()).quoteId, first.quoteId);
});

const freshRequest = async () => requestOf(await moveQuote());
const auroraKey = () => getAddress(`0x${randomBytes(20).toString('hex')}`);
const trackBy = (provider, id) => ({ provider, [provider === 'relay' ? 'requestId' : 'depositAddress']: id });
const statusOf = async (id, provider = 'relay') => {
  const res = await fetch(`${base}/proxy/v2/move-asset/deposit/status?${new URLSearchParams(trackBy(provider, id))}`);
  return { res, body: await res.json() };
};
const submit = async (body) => {
  const res = await fetch(`${base}/proxy/v2/move-asset/deposit/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
};
const submitRelay = (requestId, txHash = TX_HASH) =>
  submit({ provider: 'relay', requestId, txHash, originChainId: 84532 });
const TX_HASH = '0x' + 'cd'.repeat(32);
const DEFAULTS = { quote: 'ok', deposit: 'PENDING_DEPOSIT', submit: 201 };
async function defaults(at = base) {
  const res = await fetch(`${at}/proxy/v2/move-asset/quote?${new URLSearchParams(ERC20_QUERY)}`);
  const quote = (await res.json()).result.data?.transactions?.length === 1 ? 'ok' : 'broken';
  const requestId = '0x' + 'ab'.repeat(32);
  const status = await fetch(
    `${at}/proxy/v2/move-asset/deposit/status?${new URLSearchParams({ provider: 'relay', requestId })}`
  );
  const sent = await fetch(`${at}/proxy/v2/move-asset/deposit/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'relay', requestId, txHash: TX_HASH, originChainId: 84532 }),
  });
  return { quote, deposit: (await status.json()).result.data.state, submit: sent.status };
}

test('given a quoted request, status is PENDING_DEPOSIT until submit, then walks to SUCCESS', async () => {
  const requestId = await freshRequest();
  const before = await statusOf(requestId.toUpperCase().replace('0X', '0x'));
  assert.equal(before.res.status, 200);
  assert.deepEqual(before.body, {
    statusCode: 200,
    result: {
      data: { provider: 'relay', requestId: requestId.toUpperCase().replace('0X', '0x'), state: 'PENDING_DEPOSIT' },
      error: null,
    },
  });
  const sent = await submitRelay(requestId);
  assert.equal(sent.res.status, 201);
  assert.equal(sent.body.statusCode, 200);
  assert.deepEqual(sent.body.result.data, {
    provider: 'relay',
    requestId,
    state: 'KNOWN_DEPOSIT_TX',
    txHash: TX_HASH,
  });
  const states = [];
  for (let i = 0; i < 4; i++) states.push((await statusOf(requestId)).body.result.data.state);
  assert.deepEqual(states, ['PROCESSING', 'SUCCESS', 'SUCCESS', 'SUCCESS']);
  assert.equal((await statusOf(requestId)).body.result.data.txHash, TX_HASH);
});

test('given an Aurora deposit address, status and submit walk the same way and echo the address', async () => {
  const address = auroraKey();
  const before = await statusOf(address.toLowerCase(), 'aurora');
  assert.deepEqual(before.body.result.data, { provider: 'aurora', depositAddress: address, state: 'PENDING_DEPOSIT' });
  const sent = await submit({ provider: 'aurora', depositAddress: address, txHash: TX_HASH });
  assert.equal(sent.res.status, 201);
  assert.deepEqual(sent.body.result.data, {
    provider: 'aurora',
    depositAddress: address,
    state: 'KNOWN_DEPOSIT_TX',
    txHash: TX_HASH,
  });
  assert.equal((await statusOf(address, 'aurora')).body.result.data.state, 'PROCESSING');
});

test('given a pinned state and no submit, status answers it without a txHash', async () => {
  const requestId = await freshRequest();
  await control({ state: 'PROCESSING', requestId });
  const { body } = await statusOf(requestId);
  assert.equal(body.result.data.state, 'PROCESSING');
  assert.equal('txHash' in body.result.data, false);
  await control({ state: 'REFUNDED', requestId });
  assert.equal((await statusOf(requestId)).body.result.data.state, 'REFUNDED');
});

test('given a state pinned to an Aurora deposit address, status answers it', async () => {
  const address = auroraKey();
  await control({ state: 'REFUNDED', depositAddress: address });
  assert.equal((await statusOf(address, 'aurora')).body.result.data.state, 'REFUNDED');
});

test('given an unknown pinned state, status maps it like the backend mapper', async () => {
  const requestId = await freshRequest();
  await control({ state: 'WAITING_FOR_GODOT', requestId });
  const { data } = (await statusOf(requestId)).body.result;
  assert.equal(data.state, 'PROCESSING');
  assert.equal(data.rawState, 'WAITING_FOR_GODOT');
});

test('given submitFails=1, the first submit answers 502 as a failed provider does and the second goes through', async () => {
  const requestId = await freshRequest();
  await control({ submitFails: '1' });
  const first = await submitRelay(requestId);
  assert.equal(first.res.status, 502);
  assert.deepEqual(first.body, {
    statusCode: 502,
    result: { data: null, error: 'ProviderQuoteInvalid[relay]: upstream failed' },
  });
  assert.equal((await statusOf(requestId)).body.result.data.state, 'PENDING_DEPOSIT');
  const second = await submitRelay(requestId);
  assert.equal(second.res.status, 201);
});

test('given an expired quote, submit answers 422 as a refusing provider does and status stays PENDING_DEPOSIT', async () => {
  const requestId = await freshRequest();
  await control({ expire: requestId });
  const sent = await submitRelay(requestId);
  assert.equal(sent.res.status, 422);
  assert.equal((await statusOf(requestId)).body.result.data.state, 'PENDING_DEPOSIT');
});

test('given an invalid submit body, submit answers 400 in the backend envelope', async () => {
  const requestId = await freshRequest();
  const { res, body } = await submitRelay(requestId, '0x1234');
  assert.equal(res.status, 400);
  assert.deepEqual(body, { statusCode: 400, result: { data: null, error: ['txHash must be a 32-byte hex string'] } });
  const missing = await submit({ provider: 'relay', requestId, txHash: TX_HASH });
  assert.equal(missing.res.status, 400);
});

test('given a provider other than aurora or relay, submit and status answer 501', async () => {
  const requestId = await freshRequest();
  assert.equal((await submit({ provider: 'across', requestId, txHash: TX_HASH })).res.status, 501);
  assert.equal((await statusOf(requestId, 'across')).res.status, 501);
});

test('given reset, the control state goes back to its defaults', async () => {
  await control({ mode: 'two-tx', submitFails: '3', state: 'REFUNDED' });
  const res = await fetch(`${base}/_swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
  assert.equal(res.status, 204);
  assert.deepEqual(await defaults(), DEFAULTS);
});

test('given a fresh seller, the control state starts from the defaults', async () => {
  const port = await freePort();
  const file = path.join(dir, 'fresh.log');
  const fresh = spawn('node', [path.join(here, 'seller.mjs'), repo, String(port), file], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await defaults(`http://localhost:${port}`), DEFAULTS);
  } finally {
    fresh.kill();
  }
});

test('every swap route and control call is logged', () => {
  const paths = new Set(logRows().map((r) => r.path));
  for (const p of [
    '/proxy/v2/move-asset/quote',
    '/proxy/v2/move-asset/deposit/submit',
    '/proxy/v2/move-asset/deposit/status',
    '/_swap',
  ])
    assert.ok(paths.has(p), p);
});
