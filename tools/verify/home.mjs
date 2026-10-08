// Writes a throwaway ~/.jaw under <home>: a session on Base Sepolia that is
// still live and holds no permission struct, so the default caps apply. The
// session key is the verification payer in <JAW_VERIFY_ROOT>/payer.json when
// it exists (funded once, so payments skip the top-up), else a fresh empty one.
// Usage: node home.mjs <repo-root> <home>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const [repo, home] = process.argv.slice(2);
const { privateKeyToAccount } = createRequire(`${repo}/package.json`)('viem/accounts');

const dir = path.join(home, '.jaw');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const payerFile = path.join(process.env.JAW_VERIFY_ROOT ?? path.join(repo, '.verify-cache'), 'payer.json');
const privateKey = fs.existsSync(payerFile)
  ? JSON.parse(fs.readFileSync(payerFile, 'utf8')).privateKey
  : `0x${crypto.randomBytes(32).toString('hex')}`;
const { address } = privateKeyToAccount(privateKey);
const now = new Date();
const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });

write('keystore.json', { version: 2, privateKey, address, createdAt: now.toISOString() });
write('session-config.json', {
  ownerAddress: '0x1111111111111111111111111111111111111111',
  sessionAddress: address,
  permissionId: '0x' + 'cd'.repeat(32),
  chainId: 84532,
  expiry: Math.floor(now.getTime() / 1000) + 86400,
  createdAt: now.toISOString(),
  mode: 'eip7702',
});
write('config.json', {});
console.log(address);
