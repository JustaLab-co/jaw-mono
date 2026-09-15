import { BaseCommand } from '../../base-command.js';
import { keystoreExists } from '../../lib/keystore.js';
import {
  expiryInstant,
  isLegacySession,
  liveOrphans,
  loadSessionConfig,
  sessionUsable,
} from '../../lib/session-config.js';
import { loadConfig } from '../../lib/config.js';
import { apiKeyFor } from '../../lib/api-key.js';
import { readLiveness, type PermissionLiveness } from '../../x402/permission-onchain.js';
import { recoverPermission } from '../../x402/permission-recovery.js';
import type { OutputFormat } from '../../lib/types.js';

export default class SessionStatus extends BaseCommand {
  static override description = 'Show current session status (address, permissions, expiry).';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionStatus);
    const format = flags.output as OutputFormat;

    if (!keystoreExists()) {
      this.log('No session configured. Run `jaw session setup`.');
      return;
    }

    const config = loadSessionConfig();
    const now = Date.now() / 1000;
    const endsAt = expiryInstant(config.expiry);
    const isExpired = !sessionUsable(config.expiry, now);
    // The one fact no local file can hold. Expiry is already on disk, so it
    // needs no read; a revoke made from keys.jaw.id or from another machine
    // leaves this file saying the session is fine. Fails soft to 'unknown',
    // which is what a session written before the struct was stored reports.
    // Best-effort, and quiet without an API key: this command has never needed
    // one, and a session written before the struct existed should not start
    // demanding a key to report what it always reported.
    const permission = await recoverPermission(config, apiKeyFor(loadConfig()));
    // Carried into everything below, including the json, so the run that
    // recovers the struct reports it rather than the next one.
    const current = permission ? { ...config, permission } : config;
    const liveness = await readLiveness(current);
    // Permissions from earlier sessions that are still live on chain. Said in
    // terms of the permission rather than of this key: setup generates a fresh
    // key whenever it is not reusing one, and `--yes` always does, so the key
    // that could exercise these is usually gone. The grant on the account is
    // what outlives the session, and before setup recorded the id it could not
    // be revoked at all.
    const stillLive = liveOrphans(config.orphanedPermissions, now);

    if (format === 'json') {
      this.outputResult(
        {
          ...current,
          expired: isExpired,
          permissionOnChain: liveness,
          ...(stillLive.length > 0 ? { stillLiveOnChain: stillLive } : {}),
        },
        format
      );
      return;
    }

    if (isExpired) {
      // `endsAt` is null when the file does not say, which lands here because a
      // report answers the way the paying path does.
      const ago = endsAt ? Math.floor((now - endsAt.getTime() / 1000) / 86400) : null;
      this.log('Session expired.\n');
      this.log(`  Session address:  ${config.sessionAddress}`);
      this.log(`  Owner address:    ${config.ownerAddress}`);
      this.log(`  Permission ID:    ${config.permissionId}${onChainNote(liveness)}`);
      this.log(`  Chain:            ${config.chainId}`);
      this.log(
        endsAt
          ? `  Expired:          ${endsAt.toISOString()} (${ago} days ago)`
          : '  Expired:          unknown, the session file does not say when it ends'
      );
      if (stillLive.length > 0) this.log(stillLiveLine(stillLive.length));
      this.log('\nRun `jaw session setup` to create a new session.');
    } else {
      // `endsAt` is set on this branch: `isExpired` is true without it.
      const remaining = Math.floor((endsAt!.getTime() / 1000 - now) / 86400);
      this.log('Session active.\n');
      this.log(`  Session address:  ${config.sessionAddress}`);
      if (isLegacySession(config)) {
        // Auto mode refuses these, so say it here rather than letting the next
        // command be the one that explains it.
        this.log('                    (separate from the session key: created by an older CLI)');
      } else {
        this.log('                    (the session key EOA, and the x402 payer)');
      }
      this.log(`  Owner address:    ${config.ownerAddress}`);
      this.log(`  Permission ID:    ${config.permissionId}${onChainNote(liveness)}`);
      this.log(`  Chain:            ${config.chainId}`);
      this.log(`  Expires:          ${endsAt ? endsAt.toISOString() : 'unknown'}`);
      // Revoked outranks the local expiry: the session has time left on paper
      // and can no longer pull anything through the permission.
      this.log(
        liveness === 'revoked'
          ? '  Status:           Revoked on chain. Run `jaw session setup` to create a new session.'
          : `  Status:           Valid (${remaining} days remaining)`
      );
      if (stillLive.length > 0) this.log(stillLiveLine(stillLive.length));
    }
  }
}

/**
 * What to add after the permission id, or nothing when the chain did not
 * answer. Silence rather than "unknown" on every run of an older session: it
 * is a question the user did not ask and the CLI cannot answer.
 */
function onChainNote(liveness: PermissionLiveness): string {
  if (liveness === 'revoked') return '   (REVOKED on chain)';
  if (liveness === 'unapproved') return '   (not approved on chain)';
  if (liveness === 'mismatch') return '   (does not match the stored permission)';
  return '';
}

/**
 * Said whenever earlier sessions left grants behind, because that is authority
 * on the account which this session does not describe and nothing else reports.
 */
function stillLiveLine(count: number): string {
  return (
    `  Still live:       ${count} permission${count === 1 ? '' : 's'} from earlier sessions ` +
    '(`jaw session revoke` removes them too)'
  );
}
