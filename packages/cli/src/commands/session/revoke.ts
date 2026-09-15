import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { loadConfig } from '../../lib/config.js';
import { getBridge } from '../../lib/bridge-singleton.js';
import { deleteKeystore, keystoreExists } from '../../lib/keystore.js';
import {
  loadSessionConfig,
  deleteSessionConfig,
  liveOrphans,
  saveRevokeProgress,
  sessionLives,
  type OrphanedPermission,
} from '../../lib/session-config.js';
import { sanitizeLine } from '../../lib/terminal.js';
import type { OutputFormat } from '../../lib/types.js';

export default class SessionRevoke extends BaseCommand {
  static override description = 'Revoke on-chain permission and delete local session key.';

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      description:
        'Delete the local session even if some permissions could not be revoked. They stay live on chain ' +
        'until they expire, and their ids are printed because deleting the session is what loses them.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionRevoke);
    const format = flags.output as OutputFormat;

    if (!keystoreExists()) {
      this.log('No session to revoke.');
      return;
    }

    const sessionConfig = loadSessionConfig();
    const now = Date.now() / 1000;

    // What this key still holds. `session setup` replaces a session rather than
    // adding to it and does not always revoke what it replaces, so there can be
    // permissions live on chain that the config's single id does not name.
    //
    // Expired ones are skipped for the same reason an expired session skips the
    // browser: they authorise nothing, and opening a window to say so is worse
    // than saying nothing.
    const orphans = liveOrphans(sessionConfig.orphanedPermissions, now);
    const own: OrphanedPermission | null =
      // `permissionRevoked` is set by an earlier run that got this far and then
      // failed on something else. Revoking is not idempotent, so attempting it
      // again spends a browser round trip that can only fail.
      // Live unless the file says otherwise, for the same reason as in setup:
      // skipping the chain here also deletes the local record, so an expiry
      // nobody can read must send us to the chain rather than past it.
      !sessionConfig.permissionRevoked && sessionLives(sessionConfig.expiry, now)
        ? { id: sessionConfig.permissionId, chainId: sessionConfig.chainId, expiry: sessionConfig.expiry }
        : null;
    const total = orphans.length + (own ? 1 : 0);

    if (total === 0) {
      deleteKeystore();
      deleteSessionConfig();
      if (format === 'json') {
        this.outputResult({ revoked: true, skippedOnChain: true, revokedIds: [], failed: [] }, format);
      } else {
        this.log('Session already expired. Cleaned up local files.');
      }
      return;
    }

    const config = loadConfig();
    const apiKey = this.resolveApiKey(flags);
    // Not in json mode: a script parsing the result should get the result, and
    // a progress line ahead of it makes the output unparseable.
    if (!flags.quiet && format !== 'json') {
      this.log(
        total === 1 ? 'Opening browser to revoke permission...' : `Opening browser to revoke ${total} permissions...`
      );
    }

    const revokedIds: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    let remaining = orphans;
    let ownRevoked = false;

    // Every permission is attempted on its own. One that cannot be revoked must
    // not take the others down with it: a permission already revoked from
    // another device fails here for good, because the relay no longer has the
    // record it is read from, and letting that abort the batch would mean
    // `session revoke` quietly returning without revoking the live permission
    // the user ran it for.
    const revokeOn = async (chainId: number, targets: OrphanedPermission[]): Promise<void> => {
      let bridge;
      try {
        bridge = await getBridge({ keysUrl: config.keysUrl, apiKey, chainId, ens: config.ens });
      } catch (err) {
        // A bridge that will not open fails every permission on that chain, and
        // says so once rather than once per id.
        for (const target of targets) failed.push({ id: target.id, reason: describe(err) });
        return;
      }
      try {
        for (const target of targets) {
          try {
            await bridge.request('wallet_revokePermissions', [{ id: target.id }]);
            revokedIds.push(target.id);
            if (target === own) ownRevoked = true;
            else remaining = remaining.filter((orphan) => orphan.id !== target.id);
            // Persisted as it goes, so that whatever this command stops in the
            // middle of leaves a session naming only ids that are still live.
            saveRevokeProgress(sessionConfig, { orphans: remaining, ownPermissionRevoked: ownRevoked });
          } catch (err) {
            failed.push({ id: target.id, reason: describe(err) });
          }
        }
      } finally {
        bridge.close();
      }
    };

    // Orphans first, one bridge per chain, because an orphan can sit on a chain
    // the current session does not use: setup takes --chain, so replacing a
    // session can move it while leaving the old permission where it was.
    for (const chainId of [...new Set(orphans.map((orphan) => orphan.chainId))]) {
      await revokeOn(
        chainId,
        orphans.filter((orphan) => orphan.chainId === chainId)
      );
    }
    // The session's own permission last, and in its own pass rather than folded
    // into the grouping above, which orders by chain and could otherwise put it
    // before an orphan sharing its chain.
    if (own) await revokeOn(own.chainId, [own]);

    // The local files are what makes anything still live reachable. Deleting
    // them while something is left strands it exactly the way an unrecorded
    // permission was stranded before it was recorded.
    //
    // `--force` exists because one of these failures is permanent: a permission
    // revoked from another device can never be revoked again, since core reads
    // it from the relay and the relay no longer has it. Without a way out, that
    // one id would keep the local session alive and this command failing
    // forever. It is the user's call, and it is loud, because taking it is what
    // loses the remaining ids.
    const cleanedUp = failed.length === 0 || flags.force;
    if (cleanedUp) {
      deleteKeystore();
      deleteSessionConfig();
    }

    if (format === 'json') {
      this.outputResult(
        { revoked: failed.length === 0, skippedOnChain: false, revokedIds, failed, localSessionDeleted: cleanedUp },
        format
      );
    } else if (failed.length === 0) {
      this.log('Session revoked. On-chain permission removed and local keys deleted.');
      if (revokedIds.length > 1) {
        this.log(`Revoked ${revokedIds.length} permissions this key was holding.`);
      }
    } else {
      if (revokedIds.length > 0) this.log(`Revoked ${revokedIds.length} of ${total} permissions.`);
      for (const failure of failed) {
        this.log(`  could not revoke ${failure.id}: ${failure.reason}`);
      }
      this.log(
        flags.force
          ? '\nLocal session deleted anyway, as asked. Those permissions stay live until they expire, ' +
              'and the ids above are the only record left of them.'
          : '\nLocal session files were kept so the rest can be retried. Run this again, or pass --force ' +
              'to delete the local session anyway if one of these was already revoked elsewhere.'
      );
    }

    // Not an error under --force: the user was told what would be left and
    // asked for it anyway.
    if (failed.length > 0 && !flags.force) {
      this.error(
        `${failed.length} of ${total} permissions could not be revoked. ` +
          'One already revoked elsewhere will keep failing, since the record it is read from is gone.',
        { exit: 1 }
      );
    }
  }
}

/** A remote failure reason, fit to print: it reaches here from the browser. */
function describe(err: unknown): string {
  return sanitizeLine(err instanceof Error ? err.message : String(err), 200);
}
