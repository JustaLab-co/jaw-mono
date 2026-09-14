import { Flags } from '@oclif/core';
import * as fs from 'node:fs';
import { BaseCommand } from '../../base-command.js';
import { loadConfig } from '../../lib/config.js';
import { getBridge } from '../../lib/bridge-singleton.js';
import { keystoreExists } from '../../lib/keystore.js';
import {
  isLegacySession,
  liveOrphans,
  loadSessionConfig,
  parseGrantedPermission,
  saveRevokeProgress,
  saveSessionConfig,
} from '../../lib/session-config.js';
import type { OutputFormat, PermissionsConfig } from '../../lib/types.js';
import { parsePermissionsConfig } from '../../lib/validation.js';
import { buildX402Permissions, DEFAULT_X402_LIMIT } from '../../x402/grant-preset.js';
import { whyGrantExceedsCeiling } from '../../x402/grant-ceiling.js';
import { whyOwnerCannotFundSession, whySpenderCannotPay } from '../../x402/funded-owner.js';
import { readLiveness } from '../../x402/permission-onchain.js';
import { recoverPermission } from '../../x402/permission-recovery.js';
import { mergePermissions, describeMerge } from '../../x402/merge-permissions.js';

/**
 * Add a capability to a session without taking away the ones it has.
 *
 * `session setup` replaces a session. An agent working under a scoped session
 * that then discovers it needs to pay could only re-run setup, which revokes
 * the grant it is working under, so it loses its other capabilities in the
 * middle of the task. The alternative was hand-writing the union as one
 * `--permissions` document, which means knowing the scope you already have.
 *
 * The session still holds one permission afterwards. The union is granted as a
 * new one and the old is revoked, rather than the session tracking several,
 * because two live grants are two independent budgets on chain: two of 5 a day
 * are 10 a day, and nothing in the system represents the total. One permission
 * keeps the number on screen the number that binds.
 *
 * The key is kept, which is the point: the agent's address, its balance and its
 * delegation all survive.
 */
export default class SessionAdd extends BaseCommand {
  static override description =
    'Add permissions to the current session, keeping the ones it already has (one browser approval to grant, one to revoke the old).';

  static override examples = [
    '<%= config.bin %> session add --x402',
    '<%= config.bin %> session add --x402 --limit 10/day',
    '<%= config.bin %> session add --permissions \'{"calls":[...]}\'',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    permissions: Flags.string({
      description: 'Permissions to add (inline JSON or file path).',
      exclusive: ['x402'],
    }),
    x402: Flags.boolean({
      description: 'Add exactly what x402 payments need on the session chain. Tune the cap with --limit.',
      default: false,
      exclusive: ['permissions'],
    }),
    limit: Flags.string({
      description: `Spend cap for --x402, as <amount>/<period> (default ${DEFAULT_X402_LIMIT}).`,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionAdd);
    const config = loadConfig();
    const format = flags.output as OutputFormat;
    const apiKey = this.resolveApiKey(flags);

    if (flags.limit && !flags.x402) {
      this.error('--limit only applies to --x402. Re-run with --x402, or set the cap inside --permissions.');
    }
    if (!flags.x402 && !flags.permissions) {
      this.error('Nothing to add. Pass --x402 for the payment preset, or --permissions with a scope.');
    }
    if (!keystoreExists()) {
      this.error('No session to add to. Run `jaw session setup` first.');
    }

    const session = loadSessionConfig();
    if (session.expiry <= Date.now() / 1000) {
      this.error('The session expired, so there is nothing to add to. Run `jaw session setup` to create a new one.');
    }
    if (isLegacySession(session)) {
      this.error(
        'This session was created by an older CLI and cannot be added to: its permission belongs to an address ' +
          'separate from the session key. Run `jaw session setup` to recreate it.'
      );
    }
    // The union needs the scope that is already granted, and only the stored
    // struct has it. A session written before that field keeps working; it just
    // cannot be merged against, because the old scope is not knowable from a
    // permission id.
    // Recovered from the relay when the session predates the CLI storing it,
    // so an older session can be added to rather than told to start over.
    const existing = await recoverPermission(session, apiKey);
    if (!existing) {
      // Two causes, and only one of them is the session's fault. Recovery reads
      // the relay, which needs a key, so with none the honest answer is to get
      // one rather than to recreate a live permission.
      if (!session.permission && !apiKey) {
        this.error(
          'Reading what this session already allows needs an API key, and there is none configured. ' +
            'Set one with `jaw config set apiKey <key>`, then run this again.'
        );
      }
      this.error(
        'This session does not carry the permission it was granted, so what it already allows cannot be read. ' +
          'Run `jaw session setup` to recreate it, and adding will work from then on.'
      );
    }

    // The union is computed from the stored struct, so it has to still describe
    // the permission on chain. A `mismatch` means it does not, and `revoked`
    // means there is nothing to add to; going ahead in either case would merge
    // against a scope that is not live and then revoke the one that is, which is
    // the capability loss this command exists to prevent. Not knowing is not a
    // reason to refuse: it is what every session reports without a reachable
    // node.
    const liveness = await readLiveness({ ...session, permission: existing });
    if (liveness === 'revoked') {
      this.error(
        'The permission this session names was revoked on chain. Run `jaw session setup` to create a new one.'
      );
    }
    if (liveness === 'mismatch') {
      this.error(
        'The permission stored for this session does not match the one that was granted, so what it ' +
          'already allows cannot be read. Run `jaw session setup` to recreate it.'
      );
    }

    const addition = this.resolveAddition(flags, session.chainId);
    const merged = mergePermissions(existing, addition);
    const changes = describeMerge(existing, merged);
    if (changes.length === 0) {
      this.log('The session already allows all of this. Nothing to do.');
      return;
    }

    // Against what is being added, not the whole merged document. A limit the
    // session already holds cannot be superseded by an addition that does not
    // name its window, so judging the merge refused the add over a number the
    // user never asked for, on a session no command could bring back under the
    // ceiling short of starting over. The ceiling exists to bound what an agent
    // can ask for, and that is exactly the addition.
    const overCeiling = whyGrantExceedsCeiling(addition, session.chainId, config.grantCeiling);
    if (overCeiling) this.error(overCeiling);

    // The merge is checked too, and only warned about. What is granted is the
    // union, so a limit the session already holds rides into a new permission
    // on a machine whose ceiling is lower, and checking only the addition
    // cannot see that. It is not a refusal because the addition did not ask for
    // it and no command can lower it, so refusing would block `session add` on
    // that session for good. Saying it is what is left.
    const mergeOverCeiling = whyGrantExceedsCeiling(merged, session.chainId, config.grantCeiling);
    if (mergeOverCeiling) {
      this.logToStderr(
        // Not "holds more than the ceiling allows": three of the five reasons
        // this returns are "cannot be measured against it" rather than "is over
        // it", and a chain with no registry USDC produced a sentence that
        // contradicted itself.
        `Warning: what this session already holds does not clear the grant ceiling on this machine, ` +
          `and re-granting carries it over. ${mergeOverCeiling}`
      );
    }

    if (!flags.quiet && format !== 'json') {
      this.log('Adding to the current session:\n');
      for (const change of changes) this.log(change);
      this.log(
        '\nThe union is granted as a new permission and the old one is revoked, so the browser asks twice.\n' +
          'The session key is kept, so the address and its balance do not change.\n'
      );
      this.log('Opening browser to approve...');
    }

    const permissions = parsePermissionsConfig(merged);
    const bridge = await getBridge({ keysUrl: config.keysUrl, apiKey, chainId: session.chainId, ens: config.ens });
    let granted: unknown;
    try {
      // The account connected in the browser decides who the union belongs to.
      // A different one would grant a permission owned by someone else, leave
      // the revoke of the old one failing because that account does not own it,
      // and quietly move where payments pull from. Checked before the grant,
      // since afterwards it is on chain.
      const accounts = (await bridge.request('eth_requestAccounts')) as string[] | undefined;
      const connected = accounts?.[0];
      if (connected && connected.toLowerCase() !== session.ownerAddress.toLowerCase()) {
        this.error(
          `This session's permission belongs to ${session.ownerAddress}, but ${connected} is connected in the ` +
            'browser. Connect that account, or run `jaw session setup` to start a session on this one.'
        );
      }

      // The same guard setup runs: the grant carries a transfer to the session,
      // and an owner that cannot cover it leaves a permission that cannot be
      // used until it is funded and the whole thing is done again.
      if (flags.x402) {
        const blocked = await whyOwnerCannotFundSession({
          chainId: session.chainId,
          request: (m, p) => bridge.request(m, p),
        });
        if (blocked) this.error(blocked);
      }

      granted = await bridge.request('wallet_grantPermissions', [
        {
          spender: session.sessionAddress,
          expiry: session.expiry,
          permissions,
          chainId: session.chainId,
          capabilities: { prefundSpender: true },
        },
      ]);
    } finally {
      bridge.close();
    }

    const response = granted as { permissionId: string; account: string };
    const permission = parseGrantedPermission(granted);
    const orphans = liveOrphans(session.orphanedPermissions);

    // Written before the revoke is attempted, not after. The union is on chain
    // by now, and anything that throws between here and the write would leave a
    // live permission recorded nowhere: `session revoke` could not reach it,
    // status would not meter it, and the config would still name the old id.
    // Opening the second bridge is one of the things that can throw, which is
    // why it is not enough for the revoke request itself to be guarded.
    //
    // The old permission goes in as an orphan for the same reason, and comes
    // back out below once it is actually revoked.
    const updated = {
      ownerAddress: response.account,
      sessionAddress: session.sessionAddress,
      permissionId: response.permissionId,
      chainId: session.chainId,
      expiry: session.expiry,
      mode: 'eip7702' as const,
      // Kept, not restamped: it is what the session spend total is counted
      // from, and adding a capability must not hand the session cap a clean
      // slate.
      createdAt: session.createdAt,
      ...(permission ? { permission } : {}),
      orphanedPermissions: [{ id: session.permissionId, chainId: session.chainId, expiry: session.expiry }, ...orphans],
    };
    saveSessionConfig(updated);

    let revoked = false;
    try {
      const revokeBridge = await getBridge({
        keysUrl: config.keysUrl,
        apiKey,
        chainId: session.chainId,
        ens: config.ens,
      });
      try {
        await revokeBridge.request('wallet_revokePermissions', [{ id: session.permissionId }]);
        revoked = true;
      } finally {
        revokeBridge.close();
      }
    } catch (err) {
      // Not fatal, and not silent. The new permission is live and recorded; the
      // old one stays live until it expires, and it is on the orphan list so
      // `jaw session revoke` can still reach it.
      this.logToStderr(
        `Warning: the new permission was granted, but revoking the old one failed: ` +
          `${err instanceof Error ? err.message : String(err)}. It stays live until it expires, and ` +
          `\`jaw session revoke\` will revoke it.`
      );
    }

    if (revoked) {
      // The object just written, not a re-read of the file. Reading it back
      // would throw here if another terminal had removed the session in
      // between, after both the grant and the revoke had already succeeded, and
      // would clobber whatever that process wrote.
      saveRevokeProgress({ ...updated, createdAt: session.createdAt }, { orphans, ownPermissionRevoked: false });
    }

    if (flags.x402) {
      const unfunded = await whySpenderCannotPay({
        chainId: session.chainId,
        spender: session.sessionAddress as `0x${string}`,
      });
      if (unfunded) this.logToStderr(`\nWarning: ${unfunded}`);
    }

    const summary = {
      sessionAddress: session.sessionAddress,
      permissionId: response.permissionId,
      previousPermissionId: session.permissionId,
      previousRevoked: revoked,
      expiry: session.expiry,
    };
    if (format === 'json' || flags.quiet) {
      this.outputResult(summary, format);
      return;
    }
    this.log('\nSession updated.\n');
    this.log(`  Session address:  ${session.sessionAddress}`);
    this.log(`  Permission ID:    ${response.permissionId}`);
    this.log(`  Chain:            ${session.chainId}`);
    this.log(`  Expires:          ${new Date(session.expiry * 1000).toISOString()}`);
  }

  private resolveAddition(
    flags: { x402: boolean; limit?: string; permissions?: string },
    chainId: number
  ): PermissionsConfig {
    if (flags.x402) {
      try {
        return parsePermissionsConfig(buildX402Permissions(chainId, flags.limit));
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }
    }
    const value = flags.permissions as string;
    let raw: unknown;
    if (value.trimStart().startsWith('{')) {
      try {
        raw = JSON.parse(value);
      } catch {
        this.error(`--permissions is not valid JSON: ${value}`);
      }
    } else {
      const content = fs.readFileSync(value, 'utf-8');
      try {
        raw = JSON.parse(content);
      } catch {
        this.error(`Permissions file at ${value} is not valid JSON.`);
      }
    }
    return parsePermissionsConfig(raw);
  }
}
