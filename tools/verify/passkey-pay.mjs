// Needs a person at the passkey. Signs an EIP-3009 authorization FROM the smart
// account with the owner's passkey (keys.jaw.id, through `jaw rpc call`), sends
// it to the staging x402 endpoint and checks the facilitator settled it. Spends
// 0.005 testnet USDC from the owner account in ~/.jaw/session-config.json.
// Usage: JAW_VERIFY_HUMAN=1 node passkey-pay.mjs <run-dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

if (process.env.JAW_VERIFY_HUMAN !== '1') { console.error('set JAW_VERIFY_HUMAN=1: a person must approve with the passkey'); process.exit(2); }
const run = process.argv[2];
const env = Object.fromEntries(readFileSync(`${run}/run.env`, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const E = `${run}/evidence/passkey`; mkdirSync(E, { recursive: true });
const URL_ = 'https://api-staging.justaname.id/ens/v2/resolve?ens=vitalik.eth';
const account = JSON.parse(readFileSync(`${homedir()}/.jaw/session-config.json`, 'utf8')).ownerAddress;
const b64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString());

const probe = await fetch(URL_, { headers: { Accept: 'application/json' } });
const challenge = b64(probe.headers.get('PAYMENT-REQUIRED'));
const req = challenge.accepts.find((a) => a.scheme === 'exact' && a.network === 'eip155:84532');
const authorization = { from: account, to: req.payTo, value: req.amount, validAfter: '0',
  validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: `0x${randomBytes(32).toString('hex')}` };
const typedData = {
  domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: req.asset },
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] },
  primaryType: 'TransferWithAuthorization', message: authorization,
};
writeFileSync(`${E}/request.json`, JSON.stringify({ requirement: req, typedData }, null, 2));

console.error('Approve the signature in the browser tab keys.jaw.id opens (5 minutes).');
const out = execFileSync(env.BIN_head, ['rpc', 'call', 'eth_signTypedData_v4', JSON.stringify([account, JSON.stringify(typedData)]), '--chain', '84532', '-o', 'json'],
  { env: { ...process.env, JAW_BRIDGE_TIMEOUT_MS: '300000' }, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const signature = out.match(/0x[0-9a-fA-F]{130,}/)[0];

const proof = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req, payload: { signature, authorization } })).toString('base64');
const paid = await fetch(URL_, { headers: { Accept: 'application/json', 'PAYMENT-SIGNATURE': proof }, redirect: 'manual' });
const receipt = paid.headers.get('PAYMENT-RESPONSE') && b64(paid.headers.get('PAYMENT-RESPONSE'));
const result = { status: paid.status, signatureBytes: (signature.length - 2) / 2, receipt, body: (await paid.text()).slice(0, 200) };
writeFileSync(`${E}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!receipt?.transaction) process.exit(1);
console.log(execFileSync('cast', ['receipt', receipt.transaction, 'status', '--rpc-url', 'https://sepolia.base.org']).toString().trim());
