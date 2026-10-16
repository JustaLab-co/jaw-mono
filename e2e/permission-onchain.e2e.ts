/**
 * Real-chain E2E for the permission reads the CLI added.
 *
 * Everything else about this work is tested against mocks, which verify that
 * the code does what its author believed the contract does. That belief was
 * wrong twice while it was being written: once about whether a permission id
 * can be handed to a view (it cannot, they all take the struct), and once about
 * whether two spend limits on one token are independent budgets (they are not,
 * every one of them is charged). Both were caught by review rather than by a
 * test, because a test written from the same belief agrees with it.
 *
 * This script asks the deployed manager instead. It is read-only: `eth_call`
 * against JustaPermissionManager plus one relay GET. It spends nothing, signs
 * nothing, and changes no local state.
 *
 * What it settles, in order of how much rests on it:
 *
 *   1. The struct the CLI rebuilds hashes to the permission that was granted.
 *      Everything added here reads through `getHash` first and degrades to
 *      "cannot tell" when it does not match, so a mismatch means the whole
 *      feature is quietly inert rather than wrong. Nothing offline can tell
 *      those apart.
 *   2. `getCurrentPeriod` answers, and its window agrees with the one
 *      `currentPeriodWindow` computes locally by mirroring
 *      `_getCurrentPeriod`. Two implementations of the same calendar.
 *   3. `isApproved` / `isRevoked` answer for a live permission.
 *
 * Prerequisites: a session in ~/.jaw (any age, see the relay fallback below) on
 * a chain in the USDC registry, and an apiKey in ~/.jaw/config.json.
 *
 * Run:  bun e2e/permission-onchain.e2e.ts
 * Exit: 0 on pass, 1 on failure or unmet prerequisites.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readPermissionState,
  readCurrentPeriods,
  toContractPermission,
} from '../packages/agent/src/x402/permission-onchain.js';
import { chainClients } from '../packages/agent/src/x402/balance.js';
import { parseGrantedPermission, type GrantedPermission } from '../packages/agent/src/session/session-config.js';
import { currentPeriodWindow, normalizePeriod } from '../packages/agent/src/x402/period.js';
import { USDC_BY_NETWORK } from '../packages/agent/src/x402/asset-registry.js';

const JAW_DIR = path.join(os.homedir(), '.jaw');

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `\n         ${detail}` : ''}`);
};

function read<T>(file: string): T | null {
  const full = path.join(JAW_DIR, file);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf-8')) as T;
  } catch {
    return null;
  }
}

const session = read<{
  permissionId: string;
  chainId: number;
  ownerAddress: string;
  expiry: number;
  permission?: GrantedPermission;
  grantedSpend?: { token: string; unit?: string; multiplier?: number };
}>('session-config.json');
const config = read<{ apiKey?: string }>('config.json');

if (!session) {
  console.error('No ~/.jaw/session-config.json. Run `jaw session setup --x402 --chain 84532` first.');
  process.exit(1);
}
if (!config?.apiKey) {
  console.error('No apiKey in ~/.jaw/config.json. Run `jaw config set apiKey <key>`.');
  process.exit(1);
}
if (session.expiry <= Date.now() / 1000) {
  console.error('The session has expired, so the contract will refuse the period read. Create a new one.');
  process.exit(1);
}

const asset = Object.values(USDC_BY_NETWORK).find((a) => a.chainId === session.chainId);
if (!asset) {
  console.error(`Session is on chain ${session.chainId}, which has no USDC in the registry.`);
  process.exit(1);
}

console.log(`\npermission ${session.permissionId}\nchain      ${session.chainId}\n`);

/**
 * Sessions written before the struct was stored keep only the id, and the relay
 * holds what was granted. The CLI recovers it on the first command that needs
 * it; doing the same here keeps this runnable against a session that predates
 * that, and against one whose recovery has not happened yet.
 */
let permission = session.permission;
if (!permission) {
  console.log('  ..   no struct on disk, recovering it from the relay');
  const { getPermissionFromRelay } = await import('@jaw.id/core');
  const relayed = await getPermissionFromRelay(session.permissionId as `0x${string}`, config.apiKey);
  permission = parseGrantedPermission(relayed);
  check(permission !== undefined, 'the relay returns a struct the CLI can parse');
  if (!permission) process.exit(1);
}

check(toContractPermission(permission) !== null, 'the struct converts to the shape the contract hashes');

// 1. The assertion everything else rests on.
const deps = { clients: chainClients(config.apiKey) };
const state = await readPermissionState(
  {
    chainId: session.chainId,
    permissionId: session.permissionId,
    permission,
  },
  deps
);
check(
  state.status === 'ok',
  'the rebuilt struct hashes to the granted permission',
  state.status === 'mismatch'
    ? 'getHash returned a different id: every on-chain read here is inert and reports mismatch'
    : state.status === 'unavailable'
      ? 'could not reach the chain, so this proves nothing'
      : ''
);
if (state.status === 'ok') {
  check(state.approved, 'the permission is approved on chain');
  check(!state.revoked, 'the permission is not revoked');
}

// 2. Two implementations of the same calendar.
const limits = await readCurrentPeriods(
  {
    chainId: session.chainId,
    permissionId: session.permissionId,
    permission,
    token: asset.address,
  },
  deps
);
check(limits.length > 0, 'the permission carries a limit on the registry USDC');

// Every limit, because the contract charges every one of them and each keeps
// its own counter. Reading one answered about one budget.
for (const limit of limits) {
  // Decimal, since the relay carries the allowance as hex.
  const period = limit.multiplier === 1 ? limit.unit : `${limit.multiplier} ${limit.unit}s`;
  const label = `${BigInt(limit.allowance)} per ${period}`;
  check(limit.period.status === 'ok', `getCurrentPeriod answers for ${label}`, limit.period.status);
  if (limit.period.status !== 'ok') continue;

  const normalized = normalizePeriod(limit.unit, limit.multiplier);
  if (normalized) {
    const local = currentPeriodWindow({
      anchor: permission.start,
      unit: normalized.unit,
      multiplier: normalized.multiplier,
      now: Math.floor(Date.now() / 1000),
      permissionEnd: permission.end,
    });
    check(
      local.start === limit.period.start && local.end === limit.period.end,
      `the local window for ${label} matches the one the contract is in`,
      `local ${local.start}..${local.end}   chain ${limit.period.start}..${limit.period.end}`
    );
  }
  console.log(`\n  ${label}: ${limit.period.spend} base units lost this period`);
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
