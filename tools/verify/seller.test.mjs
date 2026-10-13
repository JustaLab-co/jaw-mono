import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(`${repo}/package.json`);
const { encodeFunctionData, erc20Abi, getAddress, keccak256, toHex } = require('viem');
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
const quoteUrl = (query) => `${base}/proxy/v2/swap/quote?${new URLSearchParams(query)}`;

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

const depositFor = (nonce) => getAddress('0x' + keccak256(nonce).slice(-40));

async function paidQuote(query, headers = {}) {
  const { header, nonce } = await proof();
  const res = await fetch(quoteUrl(query), { headers: { 'PAYMENT-SIGNATURE': header, ...headers } });
  return { res, body: await res.json(), nonce, header };
}

test('given a valid proof, /exact still answers 200 with the payer', async () => {
  const { header } = await proof();
  const res = await fetch(`${base}/exact`, { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).paidBy, payer.address);
  assert.equal(unb64(res.headers.get('payment-response')).network, 'eip155:84532');
});

test('given a valid query and no payment, the quote answers a 402 for 5000 on eip155:84532', async () => {
  const res = await fetch(quoteUrl(ERC20_QUERY));
  assert.equal(res.status, 402);
  const [req] = unb64(res.headers.get('payment-required')).accepts;
  assert.equal(req.network, 'eip155:84532');
  assert.equal(req.amount, '5000');
  assert.equal(req.asset, USDC);
});

test('given a network override, the 402 advertises it until reset', async () => {
  assert.equal((await control({ network: 'eip155:8453' })).status, 204);
  const res = await fetch(quoteUrl(ERC20_QUERY));
  assert.equal(unb64(res.headers.get('payment-required')).accepts[0].network, 'eip155:8453');
  await control({ network: '' });
  const again = await fetch(quoteUrl(ERC20_QUERY));
  assert.equal(unb64(again.headers.get('payment-required')).accepts[0].network, 'eip155:84532');
});

test('given an invalid query, the quote answers 400 unpaid in the backend envelope', async () => {
  const res = await fetch(quoteUrl({ ...ERC20_QUERY, amount: '0' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.statusCode, 400);
  assert.equal(body.result.data, null);
  assert.ok(body.result.error.some((m) => m.startsWith('amount ')));
  assert.equal(res.headers.get('payment-required'), null);
});

test('given a paid ERC-20 quote, the single deposit is transfer(depositAddress, amount) on the token', async () => {
  const { res, body, nonce } = await paidQuote(ERC20_QUERY);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('payment-response'));
  assert.equal(body.statusCode, 200);
  assert.equal(body.result.error, null);
  const q = body.result.data;
  const deposit = depositFor(nonce);
  assert.equal(q.quoteId, `aurora:${deposit}`);
  assert.equal(q.provider, 'aurora');
  assert.equal(q.inputAmount, '10000');
  assert.ok(BigInt(q.minOutputAmount) > 0n && BigInt(q.minOutputAmount) <= BigInt(q.expectedOutputAmount));
  assert.deepEqual(q.transactions, [
    {
      chainId: 84532,
      to: getAddress(USDC),
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit, 10000n] }),
      value: '0',
      description: 'deposit',
    },
  ]);
  assert.equal(q.deposit, undefined);
  const row = logRows().findLast((r) => r.event === 'payment');
  assert.equal(row.signatureValid, true);
  assert.equal(row.termsMatch, true);
});

test('given a paid native quote, the deposit sends the amount to the deposit address with no data', async () => {
  const { body, nonce } = await paidQuote(NATIVE_QUERY);
  assert.deepEqual(body.result.data.transactions, [
    { chainId: 84532, to: depositFor(nonce), data: '0x', value: '10000', description: 'deposit' },
  ]);
});

test('given two paid quotes, each gets a fresh deposit address', async () => {
  const a = await paidQuote(ERC20_QUERY);
  const b = await paidQuote(ERC20_QUERY);
  assert.notEqual(a.body.result.data.quoteId, b.body.result.data.quoteId);
});

test('given the same proof and Idempotency-Key, the quote is replayed; without the key it answers 402', async () => {
  const first = await paidQuote(ERC20_QUERY, { 'Idempotency-Key': 'swap:swp_1' });
  const payments = logRows().filter((r) => r.event === 'payment').length;
  const replay = await fetch(quoteUrl(ERC20_QUERY), {
    headers: { 'PAYMENT-SIGNATURE': first.header, 'Idempotency-Key': 'swap:swp_1' },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), first.body);
  const resent = await fetch(quoteUrl(ERC20_QUERY), { headers: { 'PAYMENT-SIGNATURE': first.header } });
  assert.equal(resent.status, 402);
  assert.equal(logRows().filter((r) => r.event === 'payment').length, payments);
});

test('given mode 422 or 502, the quote refuses before the challenge in the NoProviderAvailable envelope', async () => {
  for (const status of [422, 502]) {
    await control({ mode: String(status) });
    const res = await fetch(quoteUrl(ERC20_QUERY));
    assert.equal(res.status, status);
    assert.equal(res.headers.get('payment-required'), null);
    const body = await res.json();
    assert.equal(body.statusCode, status);
    assert.equal(body.result.data, null);
    assert.match(body.result.error, /^NoProviderAvailable: aurora=/);
  }
  await control({ mode: '' });
});

test('given mode invalid, a paid quote answers 200 with a body that is not a quote', async () => {
  await control({ mode: 'invalid' });
  const { res, body } = await paidQuote(ERC20_QUERY);
  await control({ mode: '' });
  assert.equal(res.status, 200);
  assert.equal(body.result.data, null);
});

test('given mode paid-502, a paid quote answers 502 with the receipt', async () => {
  await control({ mode: 'paid-502' });
  const { res, body } = await paidQuote(ERC20_QUERY);
  await control({ mode: '' });
  assert.equal(res.status, 502);
  assert.ok(res.headers.get('payment-response'));
  assert.equal(body.result.data, null);
});

test('given each quote check mode, the paid quote breaks only that rule', async () => {
  const cases = {
    'two-tx': (q) => assert.equal(q.transactions.length, 2),
    'no-tx': (q) => assert.equal(q.transactions.length, 0),
    'wrong-chain': (q) => assert.equal(q.transactions[0].chainId, 84533),
    'quote-id': (q) => assert.doesNotMatch(q.quoteId, /^aurora:0x[0-9a-fA-F]{40}$/),
    provider: (q) => assert.notEqual(q.provider, 'aurora'),
    'deposit-field': (q) => assert.ok(q.deposit),
    'tx-to': (q) => assert.notEqual(q.transactions[0].to, getAddress(USDC)),
    'tx-value': (q) => assert.notEqual(q.transactions[0].value, '0'),
    'tx-data': (q, deposit) =>
      assert.notEqual(
        q.transactions[0].data,
        encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit, 10000n] })
      ),
    'trailing-bytes': (q, deposit) =>
      assert.equal(
        q.transactions[0].data,
        encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit, 10000n] }) + '00'
      ),
    'input-amount': (q, deposit) => {
      assert.equal(q.inputAmount, '10001');
      assert.equal(
        q.transactions[0].data,
        encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit, 10001n] })
      );
    },
    'output-amount': (q) => assert.ok(BigInt(q.minOutputAmount) > BigInt(q.expectedOutputAmount)),
    'zero-min': (q) => assert.equal(q.minOutputAmount, '0'),
    'deposit-self': (q) => assert.equal(q.quoteId, `aurora:${getAddress(ACCOUNT)}`),
  };
  for (const [mode, expect] of Object.entries(cases)) {
    await control({ mode });
    const { body, nonce } = await paidQuote(ERC20_QUERY);
    expect(body.result.data, depositFor(nonce));
  }
  await control({ mode: 'reused' });
  const { body } = await paidQuote(ERC20_QUERY);
  await control({ mode: '' });
  const last = await paidQuote(ERC20_QUERY);
  assert.equal(
    body.result.data.quoteId,
    `aurora:${getAddress(ACCOUNT)}`,
    'reused repeats the previous deposit address'
  );
  assert.notEqual(last.body.result.data.quoteId, body.result.data.quoteId);
});

const freshDeposit = async () => depositFor((await paidQuote(ERC20_QUERY)).nonce);
const statusOf = async (depositAddress, provider = 'aurora') => {
  const res = await fetch(
    `${base}/proxy/v2/move-asset/deposit/status?${new URLSearchParams({ provider, depositAddress })}`
  );
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
const TX_HASH = '0x' + 'cd'.repeat(32);

test('given a quoted deposit, status is PENDING_DEPOSIT until submit, then walks to SUCCESS', async () => {
  const deposit = await freshDeposit();
  const before = await statusOf(deposit.toLowerCase());
  assert.equal(before.res.status, 200);
  assert.deepEqual(before.body, {
    statusCode: 200,
    result: { data: { provider: 'aurora', depositAddress: deposit, state: 'PENDING_DEPOSIT' }, error: null },
  });
  const sent = await submit({ provider: 'aurora', depositAddress: deposit, txHash: TX_HASH });
  assert.equal(sent.res.status, 200);
  assert.deepEqual(sent.body.result.data, {
    provider: 'aurora',
    depositAddress: deposit,
    state: 'KNOWN_DEPOSIT_TX',
    txHash: TX_HASH,
  });
  const states = [];
  for (let i = 0; i < 4; i++) states.push((await statusOf(deposit)).body.result.data.state);
  assert.deepEqual(states, ['PROCESSING', 'SUCCESS', 'SUCCESS', 'SUCCESS']);
  assert.equal((await statusOf(deposit)).body.result.data.txHash, TX_HASH);
});

test('given a pinned state, status answers it with a hash the wallet never sent', async () => {
  const deposit = await freshDeposit();
  await control({ state: 'PROCESSING', depositAddress: deposit });
  const { body } = await statusOf(deposit);
  assert.equal(body.result.data.state, 'PROCESSING');
  assert.match(body.result.data.txHash, /^0x[0-9a-f]{64}$/);
  await control({ state: 'REFUNDED', depositAddress: deposit });
  assert.equal((await statusOf(deposit)).body.result.data.state, 'REFUNDED');
});

test('given an unknown pinned state, status maps it like the Aurora mapper', async () => {
  const deposit = await freshDeposit();
  await control({ state: 'WAITING_FOR_GODOT', depositAddress: deposit });
  const { data } = (await statusOf(deposit)).body.result;
  assert.equal(data.state, 'PROCESSING');
  assert.equal(data.rawState, 'WAITING_FOR_GODOT');
});

test('given submitFails=1, the first submit fails and the second goes through', async () => {
  const deposit = await freshDeposit();
  await control({ submitFails: '1' });
  const first = await submit({ provider: 'aurora', depositAddress: deposit, txHash: TX_HASH });
  assert.equal(first.res.status, 500);
  assert.equal((await statusOf(deposit)).body.result.data.state, 'PENDING_DEPOSIT');
  const second = await submit({ provider: 'aurora', depositAddress: deposit, txHash: TX_HASH });
  assert.equal(second.res.status, 200);
});

test('given an expired quote, submit fails and status stays PENDING_DEPOSIT', async () => {
  const deposit = await freshDeposit();
  await control({ expire: deposit });
  const sent = await submit({ provider: 'aurora', depositAddress: deposit, txHash: TX_HASH });
  assert.equal(sent.res.status, 500);
  assert.equal((await statusOf(deposit)).body.result.data.state, 'PENDING_DEPOSIT');
});

test('given an invalid submit body, submit answers 400 in the backend envelope', async () => {
  const deposit = await freshDeposit();
  const { res, body } = await submit({ provider: 'aurora', depositAddress: deposit, txHash: '0x1234' });
  assert.equal(res.status, 400);
  assert.deepEqual(body, { statusCode: 400, result: { data: null, error: ['txHash must be a 32-byte hex string'] } });
});

test('given a provider other than aurora, submit and status answer 501', async () => {
  const deposit = await freshDeposit();
  assert.equal((await submit({ provider: 'relay', depositAddress: deposit, txHash: TX_HASH })).res.status, 501);
  assert.equal((await statusOf(deposit, 'relay')).res.status, 501);
});

test('every swap route and control call is logged', () => {
  const paths = new Set(logRows().map((r) => r.path));
  for (const p of [
    '/proxy/v2/swap/quote',
    '/proxy/v2/move-asset/deposit/submit',
    '/proxy/v2/move-asset/deposit/status',
    '/_swap',
  ])
    assert.ok(paths.has(p), p);
});
