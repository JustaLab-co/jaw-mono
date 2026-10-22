import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const moveQuoteUrl = (query) => `${base}/proxy/v2/move-asset/quote?${new URLSearchParams(query)}`;
const SOLANA_QUERY = {
  ...ERC20_QUERY,
  destinationChainId: '792703809',
  destinationToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  recipient: 'So11111111111111111111111111111111111111112',
};
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

const randomHex = () => toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2);
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

test('given the allowlisted api key and no payment, the quote answers 200 with a fresh deposit address and no receipt', async () => {
  const headers = { 'x-api-key': 'verify-swap-key' };
  const a = await fetch(quoteUrl(ERC20_QUERY), { headers });
  const b = await fetch(quoteUrl(ERC20_QUERY), { headers });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('payment-response'), null);
  const [qa, qb] = [(await a.json()).result.data, (await b.json()).result.data];
  assert.match(qa.quoteId, /^aurora:0x[0-9a-fA-F]{40}$/);
  const deposit = getAddress(qa.quoteId.slice(7));
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [deposit, BigInt(ERC20_QUERY.amount)],
  });
  assert.equal(qa.transactions[0].data, data);
  assert.notEqual(qa.quoteId, qb.quoteId);
});

test('given another api key, the quote answers the 402 challenge', async () => {
  const res = await fetch(quoteUrl(ERC20_QUERY), { headers: { 'x-api-key': 'not-listed' } });
  assert.equal(res.status, 402);
});

test('given the allowlisted api key and an invalid query, the quote answers 400 in the backend envelope', async () => {
  const res = await fetch(quoteUrl({ ...ERC20_QUERY, amount: '0' }), { headers: { 'x-api-key': 'verify-swap-key' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).result.data, null);
});

test('given an invalid query and no payment, the quote still answers the 402 challenge', async () => {
  const res = await fetch(quoteUrl({ ...ERC20_QUERY, amount: '0' }));
  assert.equal(res.status, 402);
  assert.equal(unb64(res.headers.get('payment-required')).accepts[0].amount, '5000');
});

test('given an invalid query and a payment, the quote answers 400 in the backend envelope', async () => {
  const { res, body } = await paidQuote({ ...ERC20_QUERY, amount: '0' });
  assert.equal(res.status, 400);
  assert.equal(body.statusCode, 400);
  assert.equal(body.result.data, null);
  assert.ok(body.result.error.some((m) => m.startsWith('amount ')));
  assert.equal(res.headers.get('payment-response'), null);
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

test('given an EVM query with no key and no payment, move-asset/quote answers an Aurora quote', async () => {
  const res = await fetch(moveQuoteUrl(ERC20_QUERY));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('payment-required'), null);
  const { data } = (await res.json()).result;
  assert.equal(data.provider, 'aurora');
  assert.match(data.quoteId, /^aurora:0x[0-9a-fA-F]{40}$/);
});

test('given mode across-prod or relay-prod, move-asset/quote answers the quote captured from prod as it came', async () => {
  for (const provider of ['across', 'relay']) {
    await control({ mode: `${provider}-prod` });
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

test('given a Solana destination, move-asset/quote refuses it and swap/quote with the key quotes it', async () => {
  assert.equal((await fetch(moveQuoteUrl(SOLANA_QUERY))).status, 400);
  const res = await fetch(quoteUrl(SOLANA_QUERY), { headers: { 'x-api-key': 'verify-swap-key' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.data.provider, 'aurora');
  const evm = await fetch(quoteUrl({ ...SOLANA_QUERY, destinationChainId: '42161' }), {
    headers: { 'x-api-key': 'verify-swap-key' },
  });
  assert.equal(evm.status, 400);
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
const DEFAULTS = {
  network: 'eip155:84532',
  quote: 'ok',
  deposit: 'PENDING_DEPOSIT',
  submit: 201,
  relay: 'echoed PENDING_DEPOSIT',
};
async function defaults(at = base) {
  const challenge = await fetch(`${at}/proxy/v2/swap/quote?${new URLSearchParams(ERC20_QUERY)}`);
  const network = unb64(challenge.headers.get('payment-required')).accepts[0].network;
  const { header } = await proof();
  const paid = await fetch(`${at}/proxy/v2/swap/quote?${new URLSearchParams(ERC20_QUERY)}`, {
    headers: { 'PAYMENT-SIGNATURE': header },
  });
  const quote = (await paid.json()).result.data?.transactions?.length === 1 ? 'ok' : 'broken';
  const address = getAddress('0x' + 'ab'.repeat(20));
  const status = await fetch(
    `${at}/proxy/v2/move-asset/deposit/status?${new URLSearchParams({ provider: 'aurora', depositAddress: address })}`
  );
  const sent = await fetch(`${at}/proxy/v2/move-asset/deposit/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'aurora', depositAddress: address, txHash: '0x' + 'cd'.repeat(32) }),
  });
  const id = '0x' + 'ef'.repeat(32);
  const relayRead = await fetch(
    `${at}/proxy/v2/move-asset/deposit/status?${new URLSearchParams({ provider: 'relay', requestId: id })}`
  );
  const relay = (await relayRead.json()).result.data;
  return {
    network,
    quote,
    deposit: (await status.json()).result.data.state,
    submit: sent.status,
    relay: `${relay.requestId === id ? 'echoed' : 'other'} ${relay.state}${relay.rawState ? ` ${relay.rawState}` : ''}`,
  };
}
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
  assert.equal(sent.res.status, 201);
  assert.equal(sent.body.statusCode, 200);
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

test('given a pinned state and no submit, status answers it without a txHash', async () => {
  const deposit = await freshDeposit();
  await control({ state: 'PROCESSING', depositAddress: deposit });
  const { body } = await statusOf(deposit);
  assert.equal(body.result.data.state, 'PROCESSING');
  assert.equal('txHash' in body.result.data, false);
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
  assert.equal(second.res.status, 201);
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

test('given an unknown provider, submit and status answer 501', async () => {
  const deposit = await freshDeposit();
  assert.equal((await submit({ provider: 'uniswap', depositAddress: deposit, txHash: TX_HASH })).res.status, 501);
  assert.equal((await statusOf(deposit, 'uniswap')).res.status, 501);
});

const ZERO = '0x0000000000000000000000000000000000000000';
const SEPOLIA_USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const ROUTES_BY_NAME = {
  'testnet usdc': {
    originChainId: '84532',
    originToken: USDC.toLowerCase(),
    destinationChainId: '11155111',
    destinationToken: SEPOLIA_USDC,
    amount: '1000000',
  },
  'testnet eth': {
    originChainId: '84532',
    originToken: ZERO,
    destinationChainId: '11155111',
    destinationToken: ZERO,
    amount: '1000000000000000',
  },
  'mainnet usdc': {
    originChainId: '8453',
    originToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    destinationChainId: '42161',
    destinationToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    amount: '10000000',
  },
  'mainnet eth': {
    originChainId: '8453',
    originToken: ZERO,
    destinationChainId: '42161',
    destinationToken: ZERO,
    amount: '10000000000000000',
  },
};
const routeQuery = (name, extra = {}) => ({
  ...ROUTES_BY_NAME[name],
  depositor: ACCOUNT,
  recipient: ACCOUNT,
  tradeType: 'EXACT_INPUT',
  ...extra,
});
const moveQuote = async (query) => {
  const res = await fetch(moveQuoteUrl(query));
  return { res, body: await res.json() };
};

const CHECK = `
const { checkAcross } = await import(${JSON.stringify(`${repo}/apps/mcp/src/swap/check/across.ts`)});
const { checkRelay } = await import(${JSON.stringify(`${repo}/apps/mcp/src/swap/check/relay.ts`)});
const out = [];
for (const { request, quote } of JSON.parse(await Bun.stdin.text())) {
  const now = Math.floor(Date.now() / 1000);
  const deps = { now: () => now, isOrderTaken: async () => false, isDepositAddressTaken: async () => false, ownerWindowSec: 240 };
  const r = quote.provider === 'across' ? checkAcross(request, quote, now, 240) : await checkRelay(request, quote, deps);
  out.push(r.ok ? { code: 'pass', calls: r.calls.map((c) => ({ kind: c.kind, to: c.to, value: c.value })) } : { code: r.code });
}
console.log(JSON.stringify(out));
`;
function mcpCheck(cases) {
  const file = path.join(dir, 'check.ts');
  fs.writeFileSync(file, CHECK);
  const input = JSON.stringify(
    cases.map(({ query, quote }) => ({
      request: {
        originChainId: Number(query.originChainId),
        originToken: getAddress(query.originToken),
        amount: query.amount,
        account: getAddress(query.depositor),
        destinationChainId: Number(query.destinationChainId),
        destinationToken: query.destinationToken.toLowerCase(),
        recipient: query.recipient.toLowerCase(),
      },
      quote,
    }))
  );
  const run = spawnSync('bun', [file], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('given mode across or relay, move-asset/quote answers a quote for the request that the server checks accept', async () => {
  const cases = [];
  for (const mode of ['across', 'relay'])
    for (const name of Object.keys(ROUTES_BY_NAME)) {
      await control({ mode });
      const query = routeQuery(name);
      const { res, body } = await moveQuote(query);
      assert.equal(res.status, 200, `${mode} ${name}`);
      assert.equal(body.result.data.provider, mode);
      cases.push({ mode, name, query, quote: body.result.data });
    }
  await control({ mode: '' });
  const results = mcpCheck(cases);
  cases.forEach(({ mode, name }, i) => assert.equal(results[i].code, 'pass', `${mode} ${name}`));
  const kinds = (i) => results[i].calls.map((c) => c.kind).join(',');
  assert.equal(kinds(0), 'approve,deposit');
  assert.equal(kinds(1), 'deposit');
  assert.equal(results[0].calls[1].to, getAddress('0x82B564983aE7274c86695917BBf8C99ECb6F0F8F'));
  assert.equal(results[1].calls[0].to, getAddress('0x10D8b8DaA26d307489803e10477De69C0492B610'));
  assert.equal(results[1].calls[0].value, ROUTES_BY_NAME['testnet eth'].amount);
  assert.equal(kinds(4), 'approve,deposit');
  assert.equal(kinds(5), 'deposit');
  assert.equal(results[4].calls[1].to, getAddress('0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3'));
  const relayIds = cases.filter((c) => c.mode === 'relay').map((c) => c.quote.quoteId);
  assert.equal(new Set(relayIds).size, relayIds.length, 'every Relay quote has its own requestId');
  for (const id of relayIds) assert.match(id, /^relay:0x[0-9a-f]{64}$/);
  for (const c of cases.filter((c) => c.mode === 'across'))
    assert.match(c.quote.quoteId, /^across:[A-Za-z0-9-]{1,64}$/);
});

test('given mode relay-solver or relay-router, the Relay quote fails the server check as allowlist drift', async () => {
  const cases = [];
  for (const mode of ['relay-solver', 'relay-router']) {
    await control({ mode });
    const query = routeQuery('testnet usdc');
    cases.push({ query, quote: (await moveQuote(query)).body.result.data });
  }
  await control({ mode: '' });
  assert.deepEqual(
    mcpCheck(cases).map((r) => r.code),
    ['solver_unknown', 'router_mismatch']
  );
});

test('given a providers filter, move-asset/quote answers only a listed provider and logs what was asked', async () => {
  await control({ mode: 'across' });
  const asked = async (providers) => await moveQuote(routeQuery('testnet usdc', { providers }));
  assert.equal((await asked('aurora,across,relay')).body.result.data.provider, 'across');
  assert.equal((await asked('ACROSS')).body.result.data.provider, 'across');
  assert.equal((await asked('aurora')).body.result.data.provider, 'aurora');
  assert.equal(logRows().findLast((r) => r.event === 'quote').providers, 'aurora');
  const none = await asked('relay');
  assert.equal(none.res.status, 422);
  assert.equal(none.body.result.error, 'NoProviderAvailable: relay=not enabled');
  for (const bad of ['uniswap', '', 'aurora,,across', 'aurora,aurora', 'aurora,'])
    assert.equal((await asked(bad)).res.status, 400, bad);
  await control({ filter: 'off' });
  assert.equal((await asked('aurora')).body.result.data.provider, 'across');
  await control({ mode: '', filter: '' });
  assert.equal((await moveQuote(routeQuery('testnet usdc'))).body.result.data.provider, 'aurora');
  assert.equal(logRows().findLast((r) => r.event === 'quote').providers, null);
});

const relayStatus = async (requestId) => {
  const res = await fetch(
    `${base}/proxy/v2/move-asset/deposit/status?${new URLSearchParams({ provider: 'relay', requestId })}`
  );
  return { res, body: await res.json() };
};
const acrossStatus = async (depositId, originChainId = '84532') => {
  const query = new URLSearchParams({ provider: 'across', originChainId, depositId });
  const res = await fetch(`${base}/proxy/v2/move-asset/deposit/status?${query}`);
  return { res, body: await res.json() };
};
const freshId = () => String(Math.floor(Math.random() * 1e12));

test('given a Relay deposit, status is PENDING_DEPOSIT by requestId until submit, then walks to SUCCESS', async () => {
  const id = '0x' + randomHex();
  const before = await relayStatus(id.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(before.body.result.data, { provider: 'relay', requestId: id, state: 'PENDING_DEPOSIT' });
  const sent = await submit({ provider: 'relay', requestId: id, txHash: TX_HASH, originChainId: 84532 });
  assert.equal(sent.res.status, 201);
  assert.deepEqual(sent.body.result.data, {
    provider: 'relay',
    requestId: id,
    state: 'KNOWN_DEPOSIT_TX',
    txHash: TX_HASH,
  });
  const states = [];
  for (let i = 0; i < 3; i++) states.push((await relayStatus(id)).body.result.data.state);
  assert.deepEqual(states, ['PROCESSING', 'SUCCESS', 'SUCCESS']);
  assert.equal((await submit({ provider: 'relay', requestId: id, txHash: TX_HASH })).res.status, 400);
  assert.equal((await relayStatus('0x1234')).res.status, 400);
});

test('given an Across deposit, status is PENDING_DEPOSIT not_found by origin chain and depositId until submit, then walks to SUCCESS', async () => {
  const id = freshId();
  const before = await acrossStatus(id);
  assert.deepEqual(before.body.result.data, {
    provider: 'across',
    originChainId: 84532,
    depositId: id,
    state: 'PENDING_DEPOSIT',
    rawState: 'not_found',
  });
  const sent = await submit({ provider: 'across', originChainId: 84532, depositId: id, txHash: TX_HASH });
  assert.equal(sent.res.status, 201);
  assert.deepEqual(sent.body.result.data, {
    provider: 'across',
    originChainId: 84532,
    depositId: id,
    state: 'PROCESSING',
    txHash: TX_HASH,
  });
  const states = [];
  for (let i = 0; i < 3; i++) states.push((await acrossStatus(id)).body.result.data.state);
  assert.deepEqual(states, ['PROCESSING', 'SUCCESS', 'SUCCESS']);
  assert.equal(
    (await acrossStatus(id, '8453')).body.result.data.state,
    'PENDING_DEPOSIT',
    'another chain is another deposit'
  );
  assert.equal((await acrossStatus('0x07')).res.status, 400);
  assert.equal((await acrossStatus('01')).res.status, 400);
});

test('given a pinned state with rawState, Across and Relay answer it as the backend maps it', async () => {
  const id = '0x' + randomHex();
  await submit({ provider: 'relay', requestId: id, txHash: TX_HASH, originChainId: 84532 });
  const pinned = async (params) => {
    await control(params);
    return (await relayStatus(id)).body.result.data;
  };
  assert.deepEqual(await pinned({ state: 'PROCESSING', rawState: 'failure' }), {
    provider: 'relay',
    requestId: id,
    state: 'PROCESSING',
    txHash: TX_HASH,
    rawState: 'failure',
  });
  assert.deepEqual(await pinned({ state: 'PROCESSING', rawState: 'no_tx' }), {
    provider: 'relay',
    requestId: id,
    state: 'PROCESSING',
    rawState: 'no_tx',
  });
  assert.equal((await pinned({ state: 'SUCCESS', rawState: 'actions_failed' })).rawState, 'actions_failed');
  assert.deepEqual(await pinned({ state: 'REFUNDED', rawState: '' }), {
    provider: 'relay',
    requestId: id,
    state: 'REFUNDED',
    txHash: TX_HASH,
  });
  await control({ state: 'SUCCESS' });
  const unsent = (await relayStatus('0x' + randomHex())).body.result.data;
  assert.equal(unsent.state, 'PROCESSING', 'a state past PENDING_DEPOSIT with no hash is no_tx');
  assert.equal(unsent.rawState, 'no_tx');
  await control({ state: '' });
});

test('given deposit=echo, foreign-hash or unknown, status and submit break only that part of the answer', async () => {
  const id = '0x' + randomHex();
  const depositId = freshId();
  const across = { provider: 'across', originChainId: 84532, depositId, txHash: TX_HASH };
  const relay = { provider: 'relay', requestId: id, txHash: TX_HASH, originChainId: 84532 };
  await control({ deposit: 'unknown' });
  const pending = await submit(relay);
  assert.equal(pending.res.status, 201);
  assert.equal(pending.body.result.data.state, 'PENDING_DEPOSIT');
  assert.equal(pending.body.result.data.rawState, 'unknown');
  assert.equal((await submit(across)).body.result.data.rawState, 'not_found');
  assert.equal((await acrossStatus(depositId)).body.result.data.state, 'PENDING_DEPOSIT');
  await control({ deposit: '' });
  await submit(relay);
  await control({ deposit: 'echo' });
  assert.notEqual((await relayStatus(id)).body.result.data.requestId, id);
  assert.notEqual((await acrossStatus(depositId)).body.result.data.depositId, depositId);
  await control({ deposit: 'foreign-hash' });
  const foreign = (await relayStatus(id)).body.result.data;
  assert.equal(foreign.requestId, id);
  assert.match(foreign.txHash, /^0x[0-9a-f]{64}$/);
  assert.notEqual(foreign.txHash, TX_HASH);
  await control({ deposit: '' });
  assert.equal((await relayStatus(id)).body.result.data.txHash, TX_HASH);
});

test('given submitFails on Relay, submit answers 502 as the backend does for a failed index call', async () => {
  await control({ submitFails: '1' });
  const id = '0x' + randomHex();
  const first = await submit({ provider: 'relay', requestId: id, txHash: TX_HASH, originChainId: 84532 });
  assert.equal(first.res.status, 502);
  assert.equal(first.body.result.error, 'ProviderQuoteInvalid[relay]: upstream failed');
  assert.equal((await relayStatus(id)).body.result.data.state, 'PENDING_DEPOSIT');
});

test('given reset, the control state goes back to its defaults', async () => {
  await control({
    mode: 'two-tx',
    network: 'eip155:8453',
    submitFails: '3',
    state: 'REFUNDED',
    rawState: 'failure',
    deposit: 'echo',
    filter: 'off',
  });
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
    '/proxy/v2/swap/quote',
    '/proxy/v2/move-asset/quote',
    '/proxy/v2/move-asset/deposit/submit',
    '/proxy/v2/move-asset/deposit/status',
    '/_swap',
  ])
    assert.ok(paths.has(p), p);
});
