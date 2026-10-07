/**
 * Real-chain, real-approval E2E for the session commands.
 *
 * The other script (`permission-onchain.e2e.ts`) settles whether the CLI's model
 * of the contract is right, using a session that already exists. This one runs
 * the commands that create and change a session, which is the half no unit test
 * reaches: two browser approvals chained around a grant and a revoke, with a
 * config write in between, and an on-chain effect after each one.
 *
 * Semi-automated on purpose. Driving the approval would need a passkey the test
 * owns, which means an account it created, which this API key cannot register
 * (it manages no ENS domains) and which would hold no USDC to fund a grant
 * with. So the script drives the CLI and the assertions, prints the URL, and
 * waits for a person to approve with their own passkey.
 *
 * It does not touch your session. Every command runs with HOME pointed at a
 * throwaway directory, so the CLI reads and writes a scratch `~/.jaw`; the
 * session it creates is its own, and it revokes it at the end.
 *
 * It does spend: each grant carries a small USDC prefund to the session, and
 * the grant and revoke cost gas. Base Sepolia only, and the account you approve
 * with pays.
 *
 * Run:  bun e2e/session-flow.e2e.ts
 *       JAW_E2E_STEPS=setup,status bun e2e/session-flow.e2e.ts   (a subset)
 *       JAW_E2E_NO_BROWSER=1 bun e2e/session-flow.e2e.ts          (print the URL)
 *       JAW_E2E_HOME=<dir> JAW_E2E_STEPS=add bun e2e/...           (resume a run)
 * Exit: 0 on pass, 1 on failure or unmet prerequisites.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPermissionState } from '../packages/agent/src/x402/permission-onchain.js';
import { chainClients } from '../packages/agent/src/x402/balance.js';
import type { GrantedPermission } from '../packages/agent/src/session/session-config.js';

const CHAIN = Number(process.env['JAW_E2E_CHAIN'] ?? 84532);
const STEPS = new Set((process.env['JAW_E2E_STEPS'] ?? 'setup,add,status,revoke').split(',').map((s) => s.trim()));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'packages/cli/bin/run.js');

/**
 * A fresh scratch home per run, unless one is named. Reusing it is what lets a
 * run pick up where an earlier one stopped: the steps are separable, each needs
 * a person, and a session created by one of them is the input to the next.
 */
const HOME = process.env['JAW_E2E_HOME'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-e2e-home-'));
const SCRATCH = path.join(HOME, '.jaw');

let failures = 0;
let skipped = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `\n         ${detail}` : ''}`);
};
/**
 * A step that cannot run because an earlier one did not is not a failure, and
 * reporting it as one buries the single thing that went wrong under a column of
 * red. The first run of this printed five failures for one unapproved grant.
 */
const skip = (label: string, why: string) => {
  skipped += 1;
  console.log(`  --   skipped: ${label}\n         ${why}`);
};
const step = (name: string) => console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);

function apiKey(): string {
  const file = path.join(os.homedir(), '.jaw', 'config.json');
  if (!fs.existsSync(file)) return '';
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf-8')) as { apiKey?: string }).apiKey ?? '';
  } catch {
    return '';
  }
}

const key = apiKey();
if (!key) {
  console.error('No apiKey in ~/.jaw/config.json. Run `jaw config set apiKey <key>`.');
  process.exit(1);
}
if (!fs.existsSync(CLI)) {
  console.error(`No built CLI at ${CLI}. Run \`bunx nx build @jaw.id/cli\` first.`);
  process.exit(1);
}

/**
 * Runs a CLI command against the scratch home, streaming its output so the
 * approval URL reaches the person as soon as the bridge asks for it.
 */
function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME,
        JAW_API_KEY: key,
        // Left unset on purpose: the CLI opening the browser itself is the
        // whole point of the default, and it lands on the exact URL. Printing
        // it instead asked a person to copy 292 characters of query string and
        // fragment out of a terminal, which is how the first attempt at this
        // was spent. `JAW_E2E_NO_BROWSER=1` is for a machine with no browser to
        // open, where the URL has to travel somewhere else.
        ...(process.env['JAW_E2E_NO_BROWSER'] ? { JAW_NO_BROWSER: '1' } : {}),
        JAW_CHAIN_ID: String(CHAIN),
        // The wait is on a person reading a URL out of this output and
        // approving in a browser. The default two minutes is for someone
        // already sitting in front of the browser it opens itself.
        JAW_BRIDGE_TIMEOUT_MS: process.env['JAW_E2E_APPROVAL_MS'] ?? '900000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      process.stdout.write(`       │ ${String(d).trimEnd().split('\n').join('\n       │ ')}\n`);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(`       │ ${String(d).trimEnd().split('\n').join('\n       │ ')}\n`);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function session(): Record<string, unknown> | null {
  const file = path.join(SCRATCH, 'session-config.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

async function onChain(config: Record<string, unknown>) {
  return readPermissionState(
    {
      chainId: config.chainId as number,
      permissionId: config.permissionId as string,
      permission: config.permission as GrantedPermission | undefined,
    },
    { clients: chainClients(key) }
  );
}

console.log(`\nscratch home  ${HOME}\nchain         ${CHAIN}\nsteps         ${[...STEPS].join(', ')}`);
console.log('\nYour own session in ~/.jaw is not touched. Approve in the browser when a URL appears.');

let created: Record<string, unknown> | null = null;

if (STEPS.has('setup')) {
  step('session setup --x402');
  const { code } = await run(['session', 'setup', '--x402', '--limit', '1/day', '--chain', String(CHAIN)]);
  check(code === 0, 'setup exits 0');

  created = session();
  check(created !== null, 'a session config was written');
  if (created) {
    // The field the whole on-chain half depends on. A wallet running an older
    // core answers with the id alone, and everything degrades to "cannot tell".
    check(created.permission !== undefined, 'the grant response carried the permission struct, and it was stored');
    check(created.mode === 'eip7702', 'the session key is the payer, not a second address');

    const state = await onChain(created);
    check(state.status === 'ok', 'the stored struct hashes to the permission that was granted', state.status);
    if (state.status === 'ok') check(state.approved && !state.revoked, 'the permission is live on chain');
  }
}

if (STEPS.has('add')) {
  step('session add --x402 --limit 2/day');
  const before = session();
  if (!before) {
    skip('session add', 'no session to add to, so this proves nothing either way');
  } else {
    const { code } = await run(['session', 'add', '--x402', '--limit', '2/day']);
    check(code === 0, 'add exits 0');

    if (code !== 0) {
      // Everything below describes a merge that did not happen, and against an
      // unchanged session most of it is trivially true: the key "survived", the
      // timestamp was "not reset", nothing was "left orphaned". One run
      // reported six greens that way, including that the old permission had
      // been revoked while it was still live. An assertion is only worth
      // anything when the thing it describes actually took place.
      skip('the checks on the merge', 'add did not complete, so there is no merge to check');
    } else {
      const after = session();
      check(after?.permissionId !== before.permissionId, 'the session names a new permission');
      check(after?.sessionAddress === before.sessionAddress, 'the session key survived, so the agent kept its address');
      // The timestamp the session spend total is counted from. Restamping it
      // would hand the session cap a clean slate for adding a capability.
      check(after?.createdAt === before.createdAt, 'the session spend total was not reset');
      check(
        (after?.orphanedPermissions as unknown[] | undefined) === undefined,
        'the old permission was revoked, so nothing was left orphaned'
      );

      if (after) {
        const state = await onChain(after);
        check(state.status === 'ok', 'the merged permission hashes to what was granted', state.status);
        const old = await onChain(before);
        check(old.status !== 'ok' || old.revoked, 'the permission it replaced is revoked on chain');
      }
    }
  }
}

if (STEPS.has('status') && !session()) {
  step('x402 status');
  skip('x402 status', 'no session, so the report has nothing to read on chain');
} else if (STEPS.has('status')) {
  step('x402 status');
  const { code, stdout } = await run(['x402', 'status', '--output', 'json']);
  check(code === 0, 'status exits 0');
  try {
    const report = JSON.parse(stdout);
    check(
      report.permission?.onChain === 'active',
      'status reads the permission as live on chain',
      report.permission?.onChain
    );
    // The figures that come from `getCurrentPeriod` rather than the ledger.
    // Every limit is reported now, each with where its number came from.
    const limits: Array<{ usedFrom: string }> = report.policy?.perPeriod ?? [];
    check(limits.length > 0, 'status reports the limits the permission carries');
    check(
      limits.every((limit) => limit.usedFrom === 'chain'),
      'every period figure came from the contract',
      limits.map((limit) => limit.usedFrom).join(', ')
    );
  } catch {
    check(false, 'status prints parseable json');
  }
}

if (STEPS.has('revoke')) {
  step('session revoke');
  const before = session();
  if (!before) {
    // The first run of this reported three passes here having revoked nothing:
    // with no session, the command says so and exits 0, and every "the files
    // are gone" check is true because they were never written. A green result
    // for a run where nothing happened is worse than a red one.
    skip('session revoke', 'no session was created, so there is nothing whose revocation could be checked');
  } else {
    const { code } = await run(['session', 'revoke']);
    check(code === 0, 'revoke exits 0');
    check(!fs.existsSync(path.join(SCRATCH, 'session-config.json')), 'the local session was cleaned up');
    check(!fs.existsSync(path.join(SCRATCH, 'keystore.json')), 'the session key was deleted');

    const state = await onChain(before);
    check(state.status === 'ok' && state.revoked, 'the permission is revoked on chain', state.status);
  }
}

// A run where everything was skipped proves nothing, so it does not get to
// exit 0 just because nothing failed.
const ran = failures > 0 || skipped === 0;
console.log(
  failures === 0 && ran
    ? `\nall checks passed\n\nScratch home left at ${HOME} if you want to look; nothing there is needed.\n`
    : failures === 0
      ? `\nnothing was verified: ${skipped} step(s) skipped. Scratch home: ${HOME}\n`
      : `\n${failures} check(s) failed, ${skipped} skipped. Scratch home: ${HOME}\n`
);
process.exit(failures === 0 && ran ? 0 : 1);
