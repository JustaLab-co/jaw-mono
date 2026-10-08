// Local x402 v2 seller for smoke tests. Answers 402 with a challenge, verifies the
// EIP-3009 signature it gets back, and settles with a fake transaction hash.
// Usage: node seller.mjs <repo-root> <port> <log-file>
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const [repo, port, logFile] = process.argv.slice(2);
const req_ = createRequire(`${repo}/package.json`);
const { verifyTypedData, createPublicClient, http: rpc } = req_('viem');
const { baseSepolia } = req_('viem/chains');
// Smart-account signatures (ERC-1271, ERC-6492) need the chain; plain ECDSA does not.
const chain = createPublicClient({ chain: baseSepolia, transport: rpc('https://sepolia.base.org') });
let variablePrice = '5000';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
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
  '/variable': { scheme: 'exact', get amount() { return variablePrice; }, asset: USDC },
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

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/_price' && req.method === 'POST') {
      const amount = new URL(req.url, 'http://localhost').searchParams.get('amount');
      if (!/^\d+$/.test(amount ?? '')) return res.writeHead(400).end();
      variablePrice = amount;
      log({ path, event: 'price', amount });
      return res.writeHead(204).end();
    }
    const route = ROUTES[path];
    if (!route) return res.writeHead(404).end();
    const requirement = {
      scheme: route.scheme,
      network: 'eip155:84532',
      amount: route.amount,
      asset: route.asset,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    };
    const signed = req.headers['payment-signature'];
    if (!signed) {
      log({ path, event: 'challenge' });
      const challenge = { x402Version: 2, resource: { url: `http://localhost:${port}${path}` }, accepts: [requirement] };
      return res.writeHead(402, { 'PAYMENT-REQUIRED': b64(challenge), 'content-type': 'application/json' }).end('{}');
    }
    if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
    const payload = unb64(signed);
    const auth = payload.payload.authorization;
    let valid = false;
    let verifiedBy = null;
    const typed = {
      address: auth.from,
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC },
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
      signature: payload.payload.signature,
    };
    try {
      if (await verifyTypedData(typed)) { valid = true; verifiedBy = 'ecdsa'; }
    } catch (err) {
      log({ path, event: 'verify-error', via: 'ecdsa', error: String(err) });
    }
    if (!valid) {
      try {
        if (await chain.verifyTypedData(typed)) { valid = true; verifiedBy = 'chain'; }
      } catch (err) {
        log({ path, event: 'verify-error', via: 'chain', error: String(err) });
      }
    }
    const terms = auth.to.toLowerCase() === PAY_TO && auth.value === route.amount;
    log({ path, event: 'payment', from: auth.from, value: auth.value, to: auth.to, signatureValid: valid, verifiedBy, termsMatch: terms });
    if (!valid || !terms) {
      return res.writeHead(402, { 'PAYMENT-REQUIRED': b64({ x402Version: 2, error: 'invalid', resource: { url: path }, accepts: [requirement] }) }).end('{}');
    }
    const receipt = { success: true, transaction: TX, network: 'eip155:84532', payer: auth.from, amount: route.amount };
    res.writeHead(200, { 'PAYMENT-RESPONSE': b64(receipt), 'content-type': 'application/json' }).end(JSON.stringify({ resolved: 'vitalik.eth', paidBy: auth.from }));
  })
  .listen(Number(port), () => log({ event: 'listening', port }));
