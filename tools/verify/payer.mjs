// Creates the verification payer once and reports its Base Sepolia USDC balance.
// The local seller never settles, so the balance only needs funding one time.
// Usage: node payer.mjs <repo-root>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(`${process.argv[2]}/package.json`);
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, http, parseAbi } = require('viem');
const root = process.env.JAW_VERIFY_ROOT ?? path.join(process.argv[2], '.verify-cache');
const file = path.join(root, 'payer.json');
if (!fs.existsSync(file)) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ privateKey: `0x${crypto.randomBytes(32).toString('hex')}` }), { mode: 0o600 });
}
const { address } = privateKeyToAccount(JSON.parse(fs.readFileSync(file, 'utf8')).privateKey);
const balance = await createPublicClient({ transport: http('https://sepolia.base.org') }).readContract({
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
  functionName: 'balanceOf', args: [address],
});
console.log(`${address} ${balance} (needs 1200000 for every local route)`);
