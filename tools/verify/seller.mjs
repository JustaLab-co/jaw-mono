// Local x402 v2 seller for smoke tests. Answers 402 with a challenge, verifies the
// EIP-3009 signature it gets back, and settles with a fake transaction hash.
// Usage: node seller.mjs <repo-root> <port> <log-file>
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const [repo, port, logFile] = process.argv.slice(2);
const req_ = createRequire(`${repo}/package.json`);
const {
  verifyTypedData,
  createPublicClient,
  http: rpc,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
} = req_('viem');
const { baseSepolia } = req_('viem/chains');
// Smart-account signatures (ERC-1271, ERC-6492) need the chain; plain ECDSA does not.
const chain = createPublicClient({ chain: baseSepolia, transport: rpc('https://sepolia.base.org') });
let variablePrice = '5000';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_BY_CHAIN = { 84532: USDC, 8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
const SEPOLIA = 'eip155:84532';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ab'.repeat(32);
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString());
const log = (row) => fs.appendFileSync(logFile, JSON.stringify(row) + '\n');

const ROUTES = {
  '/exact': { scheme: 'exact', amount: '5000', asset: USDC },
  '/tenth': { scheme: 'exact', amount: '100000', asset: USDC },
  '/one': { scheme: 'exact', amount: '1000000', asset: USDC },
  '/overcap': { scheme: 'exact', amount: '2000000', asset: USDC },
  '/wrong-asset': { scheme: 'exact', amount: '5000', asset: '0x3333333333333333333333333333333333333333' },
  '/upto': { scheme: 'upto', amount: '5000', asset: USDC },
  '/variable': {
    scheme: 'exact',
    get amount() {
      return variablePrice;
    },
    asset: USDC,
  },
  '/slow': { scheme: 'exact', amount: '5000', asset: USDC, delayMs: 8000 },
};

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

async function acceptOrRefuse(req, res, path, route) {
  const network = route.network ?? SEPOLIA;
  const chainId = Number(network.split(':')[1]);
  const requirement = {
    scheme: route.scheme,
    network,
    amount: route.amount,
    asset: route.asset,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2' },
  };
  const refuse = () =>
    res
      .writeHead(402, {
        'PAYMENT-REQUIRED': b64({ x402Version: 2, error: 'invalid', resource: { url: path }, accepts: [requirement] }),
      })
      .end('{}');
  const signed = req.headers['payment-signature'];
  if (!signed) {
    log({ path, event: 'challenge', network });
    const challenge = {
      x402Version: 2,
      resource: { url: `http://localhost:${port}${path}` },
      accepts: [requirement],
    };
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64(challenge), 'content-type': 'application/json' }).end('{}');
    return null;
  }
  if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
  const payload = unb64(signed);
  const auth = payload.payload.authorization;
  // A settled proof sent again without its Idempotency-Key gets a 402, as the backend answers.
  if (route.spent?.has(auth.nonce)) {
    log({ path, event: 'spent', nonce: auth.nonce });
    refuse();
    return null;
  }
  let valid = false;
  let verifiedBy = null;
  const typed = {
    address: auth.from,
    domain: { name: 'USDC', version: '2', chainId, verifyingContract: USDC_BY_CHAIN[chainId] ?? USDC },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      ...auth,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
    },
    signature: payload.payload.signature,
  };
  try {
    if (await verifyTypedData(typed)) {
      valid = true;
      verifiedBy = 'ecdsa';
    }
  } catch (err) {
    log({ path, event: 'verify-error', via: 'ecdsa', error: String(err) });
  }
  if (!valid) {
    try {
      if (await chain.verifyTypedData(typed)) {
        valid = true;
        verifiedBy = 'chain';
      }
    } catch (err) {
      log({ path, event: 'verify-error', via: 'chain', error: String(err) });
    }
  }
  const terms = auth.to.toLowerCase() === PAY_TO && auth.value === route.amount;
  log({
    path,
    event: 'payment',
    from: auth.from,
    value: auth.value,
    to: auth.to,
    signatureValid: valid,
    verifiedBy,
    termsMatch: terms,
  });
  if (!valid || !terms) {
    refuse();
    return null;
  }
  route.spent?.add(auth.nonce);
  const receipt = { success: true, transaction: TX, network, payer: auth.from, amount: route.amount };
  return { payer: auth.from, nonce: auth.nonce, receipt: b64(receipt) };
}

// Swap backend stub: the routes of jan-back-mono apps/proxy/src/api/v2/swap and
// move-asset, answering in its { statusCode, result: { data, error } } envelope.
const QUOTE = '/proxy/v2/swap/quote';
const SUBMIT = '/proxy/v2/move-asset/deposit/submit';
const STATUS = '/proxy/v2/move-asset/deposit/status';
const OTHER = '0x3333333333333333333333333333333333333333';
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POSITIVE = /^[1-9][0-9]*$/;
const KNOWN_STATES = new Set([
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
]);
const AFTER_SUBMIT = ['PROCESSING', 'SUCCESS'];
const NO_PROVIDER = {
  422: 'NoProviderAvailable: aurora=amount is too low for bridge',
  502: 'NoProviderAvailable: aurora=HTTP 503',
};

const transfer = (to, amount) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });

const QUOTE_TAMPERS = {
  'two-tx': (q) => q.transactions.push({ ...q.transactions[0] }),
  'no-tx': (q) => (q.transactions = []),
  'wrong-chain': (q) => (q.transactions[0].chainId += 1),
  'quote-id': (q) => (q.quoteId = q.quoteId.replace('aurora:', 'relay:')),
  provider: (q) => (q.provider = 'relay'),
  'deposit-field': (q) =>
    (q.deposit = {
      chainId: q.transactions[0].chainId,
      address: q.quoteId.slice(7),
      token: OTHER,
      amount: q.inputAmount,
    }),
  'tx-to': (q) => (q.transactions[0].to = OTHER),
  'tx-value': (q) => (q.transactions[0].value = String(BigInt(q.transactions[0].value) + 1n)),
  'tx-data': (q) =>
    (q.transactions[0].data = q.transactions[0].data === '0x' ? '0x00' : transfer(OTHER, BigInt(q.inputAmount))),
  'trailing-bytes': (q) => (q.transactions[0].data += '00'),
  'output-amount': (q) => (q.minOutputAmount = String(BigInt(q.expectedOutputAmount) + 1n)),
  'zero-min': (q) => (q.minOutputAmount = '0'),
};
const MODES = new Set([
  '',
  '422',
  '502',
  'invalid',
  'paid-502',
  'input-amount',
  'deposit-self',
  'reused',
  ...Object.keys(QUOTE_TAMPERS),
]);

const freshSwap = () => ({ mode: '', network: SEPOLIA, submitFails: 0, pinned: '', lastDeposit: null });
const swap = freshSwap();
const quoteRoute = { scheme: 'exact', amount: '5000', spent: new Set() };
// The backend's X402_ALLOWED_API_KEYS: a request with this x-api-key gets the quote with no payment.
// compose.yaml gives the hosted server the same key as JAW_MCP_SWAP_API_KEY.
const SWAP_API_KEY = 'verify-swap-key';
const replays = new Map();
const deposits = new Map();

const answer = (res, status, data, error, headers = {}, statusCode = status) =>
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify({ statusCode, result: { data, error } }));

function track(address) {
  const key = address.toLowerCase();
  if (!deposits.has(key)) deposits.set(key, { reads: 0, pinned: '', txHash: null, expired: false });
  return deposits.get(key);
}

function quoteErrors(q) {
  const errors = [];
  for (const k of ['originChainId', 'destinationChainId'])
    if (!POSITIVE.test(q[k] ?? '')) errors.push(`${k} must be a positive number`);
  for (const k of ['originToken', 'destinationToken', 'depositor', 'recipient'])
    if (!HEX_ADDRESS.test(q[k] ?? '')) errors.push(`${k} must be an EVM address`);
  if (!POSITIVE.test(q.amount ?? ''))
    errors.push('amount must be a positive integer string (no leading zeros, no zero)');
  if (q.tradeType !== undefined && q.tradeType !== 'EXACT_INPUT' && q.tradeType !== 'EXACT_OUTPUT')
    errors.push('tradeType must be one of the following values: EXACT_INPUT, EXACT_OUTPUT');
  return errors;
}

function depositErrors(d, withHash) {
  const errors = [];
  if (typeof d.provider !== 'string' || !/^[a-z0-9-]{1,32}$/i.test(d.provider))
    errors.push('provider must be a short alphanumeric identifier');
  if (!HEX_ADDRESS.test(d.depositAddress ?? ''))
    errors.push('depositAddress must be an EVM or a base58 Solana address');
  if (withHash && !/^0x[0-9a-fA-F]{64}$/.test(d.txHash ?? '')) errors.push('txHash must be a 32-byte hex string');
  return errors;
}

// What aurora-move-asset.mapper.ts builds for an EVM origin.
function auroraQuote(query, deposit, amountIn) {
  const chainId = Number(query.originChainId);
  const out = amountIn - amountIn / 200n;
  const tx =
    BigInt(query.originToken) === 0n
      ? { chainId, to: deposit, data: '0x', value: String(amountIn), description: 'deposit' }
      : {
          chainId,
          to: getAddress(query.originToken),
          data: transfer(deposit, amountIn),
          value: '0',
          description: 'deposit',
        };
  return {
    quoteId: `aurora:${deposit}`,
    provider: 'aurora',
    inputAmount: String(amountIn),
    expectedOutputAmount: String(out),
    minOutputAmount: String(out - out / 200n),
    expectedFillTimeSec: 20,
    fees: { totalUsd: '0.008045' },
    transactions: [tx],
  };
}

const depositFromNonce = (nonce) => getAddress('0x' + keccak256(nonce).slice(-40));

function paidQuote(query, nonce) {
  const { mode } = swap;
  if (mode === 'invalid') return { status: 200, data: null, error: null };
  if (mode === 'paid-502') return { status: 502, data: null, error: NO_PROVIDER[502] };
  let deposit = depositFromNonce(nonce);
  if (mode === 'deposit-self') deposit = getAddress(query.depositor);
  if (mode === 'reused' && swap.lastDeposit) deposit = swap.lastDeposit;
  swap.lastDeposit = deposit;
  const amountIn = BigInt(query.amount) + (mode === 'input-amount' ? 1n : 0n);
  const data = auroraQuote(query, deposit, amountIn);
  QUOTE_TAMPERS[mode]?.(data);
  return { status: 200, data, error: null };
}

async function quote(req, res, url) {
  const query = Object.fromEntries(url.searchParams);
  const errors = quoteErrors(query);
  const keyed = req.headers['x-api-key'] === SWAP_API_KEY;
  if (errors.length && (keyed || req.headers['payment-signature'])) {
    log({ path: QUOTE, event: 'refused', status: 400 });
    return answer(res, 400, null, errors);
  }
  if (swap.mode === '422' || swap.mode === '502') {
    log({ path: QUOTE, event: 'refused', status: Number(swap.mode) });
    return answer(res, Number(swap.mode), null, NO_PROVIDER[swap.mode]);
  }
  const key = req.headers['idempotency-key'];
  if (key && replays.has(key)) {
    log({ path: QUOTE, event: 'replay', key });
    const { status, data, error, headers } = replays.get(key);
    return answer(res, status, data, error, headers);
  }
  if (keyed) {
    const out = paidQuote(query, `0x${randomBytes(32).toString('hex')}`);
    log({ path: QUOTE, event: 'quote', by: 'api-key', mode: swap.mode, quoteId: out.data?.quoteId ?? null });
    return answer(res, out.status, out.data, out.error);
  }
  const chainId = Number(swap.network.split(':')[1]);
  const route = { ...quoteRoute, network: swap.network, asset: USDC_BY_CHAIN[chainId] ?? USDC };
  const paid = await acceptOrRefuse(req, res, QUOTE, route);
  if (!paid) return;
  const out = { ...paidQuote(query, paid.nonce), headers: { 'PAYMENT-RESPONSE': paid.receipt } };
  if (key) replays.set(key, out);
  log({ path: QUOTE, event: 'quote', mode: swap.mode, quoteId: out.data?.quoteId ?? null });
  answer(res, out.status, out.data, out.error, out.headers);
}

function depositStatus(address, t, raw) {
  const upper = raw.toUpperCase();
  let state = 'PROCESSING';
  if (KNOWN_STATES.has(upper)) state = upper;
  else if (raw.trim() === '') state = 'PENDING_DEPOSIT';
  const data = { provider: 'aurora', depositAddress: getAddress(address), state };
  if (t.txHash) data.txHash = t.txHash;
  if (state === 'PROCESSING' && !KNOWN_STATES.has(upper)) data.rawState = raw;
  return data;
}

function readState(t) {
  if (t.pinned || swap.pinned) return t.pinned || swap.pinned;
  if (!t.txHash) return '';
  return AFTER_SUBMIT[Math.min(t.reads++, AFTER_SUBMIT.length - 1)];
}

async function deposit(req, res, url, path) {
  let input = Object.fromEntries(url.searchParams);
  if (path === SUBMIT) {
    let text = '';
    for await (const chunk of req) text += chunk;
    try {
      input = JSON.parse(text) ?? {};
    } catch {
      input = {};
    }
  }
  const errors = depositErrors(input, path === SUBMIT);
  if (errors.length) {
    log({ path, event: 'refused', status: 400 });
    return answer(res, 400, null, errors);
  }
  if (input.provider.trim().toLowerCase() !== 'aurora') {
    log({ path, event: 'refused', status: 501 });
    return answer(
      res,
      501,
      null,
      `ProviderNotTrackable: ${input.provider}: provider does not support deposit tracking`
    );
  }
  const t = track(input.depositAddress);
  if (path === STATUS) {
    const data = depositStatus(input.depositAddress, t, readState(t));
    log({ path, event: 'status', depositAddress: data.depositAddress, state: data.state });
    return answer(res, 200, data, null);
  }
  // Aurora refusing a submit reaches the caller as Nest's default 500: the
  // backend has no filter for that error.
  if (t.expired || swap.submitFails > 0) {
    if (!t.expired) swap.submitFails--;
    log({ path, event: 'submit', depositAddress: input.depositAddress, status: 500, expired: t.expired });
    return res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ statusCode: 500, message: 'Internal server error' }));
  }
  t.txHash = input.txHash;
  t.reads = 0;
  const data = depositStatus(input.depositAddress, t, t.pinned || swap.pinned || 'KNOWN_DEPOSIT_TX');
  log({ path, event: 'submit', depositAddress: data.depositAddress, txHash: t.txHash, status: 200 });
  answer(res, 201, data, null, {}, 200);
}

function control(url) {
  const p = url.searchParams;
  const address = p.get('depositAddress') ?? p.get('expire');
  if (p.has('mode') && !MODES.has(p.get('mode'))) return false;
  if (p.get('network') && !/^eip155:[1-9][0-9]*$/.test(p.get('network'))) return false;
  if (p.has('submitFails') && !/^\d+$/.test(p.get('submitFails'))) return false;
  if (address !== null && !HEX_ADDRESS.test(address)) return false;
  if (p.has('mode')) swap.mode = p.get('mode');
  if (p.has('network')) swap.network = p.get('network') || SEPOLIA;
  if (p.has('submitFails')) swap.submitFails = Number(p.get('submitFails'));
  if (p.has('state') && p.has('depositAddress')) track(address).pinned = p.get('state');
  else if (p.has('state')) swap.pinned = p.get('state');
  if (p.has('expire')) track(address).expired = true;
  return true;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path === '/_price' && req.method === 'POST') {
      const amount = url.searchParams.get('amount');
      if (!/^\d+$/.test(amount ?? '')) return res.writeHead(400).end();
      variablePrice = amount;
      log({ path, event: 'price', amount });
      return res.writeHead(204).end();
    }
    if (path === '/_swap' && req.method === 'POST') {
      let text = '';
      for await (const chunk of req) text += chunk;
      let body = {};
      try {
        body = JSON.parse(text) ?? {};
      } catch {}
      if (body.reset === true) {
        Object.assign(swap, freshSwap());
        for (const t of deposits.values()) Object.assign(t, { pinned: '', expired: false });
        log({ path, event: 'control', reset: true });
        return res.writeHead(204).end();
      }
      if (!control(url)) return res.writeHead(400).end();
      log({ path, event: 'control', ...Object.fromEntries(url.searchParams) });
      return res.writeHead(204).end();
    }
    if (path === QUOTE && req.method === 'GET') return quote(req, res, url);
    if ((path === SUBMIT && req.method === 'POST') || (path === STATUS && req.method === 'GET'))
      return deposit(req, res, url, path);
    const route = ROUTES[path];
    if (!route) return res.writeHead(404).end();
    const paid = await acceptOrRefuse(req, res, path, route);
    if (!paid) return;
    res
      .writeHead(200, { 'PAYMENT-RESPONSE': paid.receipt, 'content-type': 'application/json' })
      .end(JSON.stringify({ resolved: 'vitalik.eth', paidBy: paid.payer }));
  })
  .listen(Number(port), () => log({ event: 'listening', port }));
