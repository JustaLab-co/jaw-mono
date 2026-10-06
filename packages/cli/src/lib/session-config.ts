import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import { writeJsonAtomic } from './config.js';
import type { GrantedPermission, OrphanedPermission, PermissionStore, SessionConfig } from '@jaw.id/agent';

// The shape and the rules live in the agent package; this file is where the
// session is read from and written to disk.
export {
  expiryInstant,
  isLegacySession,
  liveOrphans,
  parseGrantedPermission,
  sessionLives,
  sessionUsable,
  type GrantedPermission,
  type OrphanedPermission,
  type SessionConfig,
  type SessionMode,
} from '@jaw.id/agent';

/**
 * `mode` is required and pinned here, unlike on the read side where it stays
 * optional to describe files earlier versions wrote. Nothing but `SessionSetup`
 * writes a session, and a session written without the mode would be refused by
 * `SessionBridge` as if an old CLI had made it, so the compiler holds the
 * invariant rather than a test having to.
 */
type WritableSession = Omit<SessionConfig, 'createdAt' | 'mode' | 'expiry'> & {
  mode: 'eip7702';
  /**
   * Required here while the field it lands in is nullable, and the asymmetry is
   * the point: a session we write always knows when it ends, and only a file we
   * did not write can fail to state one. Widening the read without holding the
   * write would have let a value nobody can read be persisted by us, which is a
   * different problem from the one this file is about.
   */
  expiry: number;
};

/**
 * Write a session that starts now.
 *
 * `createdAt` is stamped here and nowhere else, because starting is the only
 * time it is true.
 */
export function saveSessionConfig(input: WritableSession): void {
  writeSessionConfig({ ...input, createdAt: new Date().toISOString() });
}

/**
 * Write a session that replaces one already on disk, keeping when it began.
 *
 * Separate from starting one, because the difference is in the caller's intent
 * and not in the value: `session add` carries `createdAt` forward, and a session
 * written before the field existed, or whose field could not be read, carries
 * nothing. An optional argument could not tell those apart from "start now", so
 * the absent case silently stamped the present instead, and `sumSpentSince`
 * counts the session total from that instant: adding a capability handed the cap
 * a clean slate.
 *
 * Absent stays absent here. The sums already take the instant as optional and
 * count the payer's whole history without it, which is the conservative reading.
 */
export function replaceSessionConfig(input: WritableSession & { createdAt: string | undefined }): void {
  writeSessionConfig(input);
}

/**
 * Written atomically, so a reader never sees a half-written config.
 *
 * Recovering the permission struct turns two commands that otherwise only read
 * (`x402 status`, `session status`) into writers, and the MCP server runs
 * alongside a terminal, so two processes writing at once is ordinary rather than
 * exotic. A torn file loses the permission id, which is exactly the stranding
 * the orphan list exists to prevent.
 */
function writeSessionConfig(config: SessionConfig): void {
  writeJsonAtomic(PATHS.sessionConfig, config);
}

/**
 * Store a permission struct recovered for a session that was written without
 * one, leaving the rest of the file alone. Same reason as below for not going
 * through `saveSessionConfig`: it stamps a fresh `createdAt`.
 */
export function saveRecoveredPermission(config: SessionConfig, permission: GrantedPermission): boolean {
  // Merged into the file as it is now, not into the snapshot the caller loaded.
  // Recovery holds its copy across a relay round trip, and in that time a
  // `session revoke` running beside it writes progress between browser
  // approvals: renaming the old copy back over it would restore the expiry and
  // the orphan list that revoke had just cleared, and the next revoke would
  // re-attempt ids that are already gone. Reading immediately before the write
  // does not make this a transaction, it makes the window microseconds instead
  // of the length of a network call.
  //
  // A session that disappeared in the meantime stays gone: the only thing being
  // added here is a cache of something the relay can produce again.
  const current = tryLoadSessionConfig();
  if (!current || current.permissionId !== config.permissionId) return false;
  writeSessionConfig({ ...current, permission });
  return true;
}

/**
 * Record what a revoke has already done, so the rest of it can be retried.
 *
 * Revoking is not idempotent: core reads the permission from the relay before
 * sending and deletes it from there afterwards, so a second attempt at an id
 * already revoked fails before it sends anything. A session left naming an id
 * that is gone therefore costs a browser round trip that can only fail, which
 * is why what succeeded has to come out of the file as it succeeds.
 *
 * `ownPermissionRevoked` is recorded on its own field. Borrowing `expiry` for it
 * would make that field mean two things at once and break the recovered-struct
 * check that compares it against the permission's own `end`. What it is for:
 * stopping the next revoke from attempting an id the relay no longer has.
 *
 * Separate from `saveSessionConfig` because that one stamps a fresh
 * `createdAt`, and `createdAt` is what the session total is counted from
 * (`sumSpentSince(payer, session.createdAt)`). Editing a session through it
 * would hand the session cap a clean slate as a side effect of revoking one
 * permission.
 */
export function saveRevokeProgress(
  config: SessionConfig,
  progress: { orphans: OrphanedPermission[]; ownPermissionRevoked: boolean }
): void {
  // Merged into the file as it stands, for the same reason
  // `saveRecoveredPermission` does: this runs between browser round trips, and
  // a recovery finishing beside it would otherwise be dropped by the next
  // progress write.
  const next: SessionConfig = { ...(tryLoadSessionConfig() ?? config) };
  if (progress.orphans.length > 0) next.orphanedPermissions = progress.orphans;
  else delete next.orphanedPermissions;
  if (progress.ownPermissionRevoked) next.permissionRevoked = true;
  writeSessionConfig(next);
}

export function sessionConfigExists(): boolean {
  return fs.existsSync(PATHS.sessionConfig);
}

/** Whether an instant can be read back at all. */
function isReadableInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Why the file cannot be used at all, or nothing when it can.
 *
 * Only `permissionId`, and on purpose. Without it there is nothing to spend
 * against and nothing to clean up, so refusing costs the caller nothing it had.
 * Every other field is handled where it is read, because refusing the whole file
 * over one of them takes the recovery paths down with it: `session revoke` and
 * `session setup` reach the permission id through this same load, and a file
 * they cannot open is a grant that stays live on chain with no local record of
 * its id.
 */
function whySessionConfigIsUnusable(config: SessionConfig): string | null {
  if (typeof config !== 'object' || config === null) return 'it is not an object';
  if (typeof config.permissionId !== 'string' || config.permissionId === '') return '`permissionId` is missing';
  return null;
}

/**
 * Narrow what cannot be read to the type that says so, rather than refusing the
 * file for it or leaving a value no reader can trust.
 *
 * `createdAt` is the instant the session total counts from. Absent is already a
 * supported state, and the safe one: `sumSpentSince` takes `since` as optional
 * and sums the payer's whole history without it, which counts more spend rather
 * than less. A value that does not parse would instead move that window
 * silently, and the direction it moves is the one that hands back budget already
 * spent. `Date.parse` is not enough on its own, since it coerces: `Date.parse(2024)`
 * is a valid date in 2024 rather than a rejection.
 */
function normalizeSessionConfig(config: SessionConfig): SessionConfig {
  const expiry = typeof config.expiry === 'number' && Number.isFinite(config.expiry) ? config.expiry : null;
  // Absent rather than a value nothing can read, which is what the type now
  // says and what `sumSpentSince` already handled: no instant means count the
  // payer's whole history, so the cap binds sooner rather than later.
  const createdAt = isReadableInstant(config.createdAt) ? config.createdAt : undefined;
  return { ...config, expiry, createdAt };
}

export function loadSessionConfig(): SessionConfig {
  if (!fs.existsSync(PATHS.sessionConfig)) {
    throw new Error('No session configured. Run `jaw session setup` first.');
  }
  const raw = fs.readFileSync(PATHS.sessionConfig, 'utf-8');
  let parsed: SessionConfig;
  try {
    parsed = JSON.parse(raw) as SessionConfig;
  } catch {
    throw new Error(`Session config at ${PATHS.sessionConfig} is corrupted. Run \`jaw session setup\` to recreate it.`);
  }

  const wrong = whySessionConfigIsUnusable(parsed);
  if (wrong) {
    throw new Error(
      `Session config at ${PATHS.sessionConfig} cannot be used: ${wrong}. ` + 'Run `jaw session setup` to recreate it.'
    );
  }
  return normalizeSessionConfig(parsed);
}

/**
 * Like `loadSessionConfig`, but returns null instead of throwing when the file
 * is missing or unreadable. For callers that can recover from a keystore whose
 * session-config is gone (interrupted setup, manual deletion, partial restore)
 * rather than callers that need an existing session to do their job.
 */
export function tryLoadSessionConfig(): SessionConfig | null {
  try {
    return loadSessionConfig();
  } catch {
    return null;
  }
}

export function deleteSessionConfig(): void {
  if (fs.existsSync(PATHS.sessionConfig)) {
    fs.unlinkSync(PATHS.sessionConfig);
  }
}

export const sessionFileStore: PermissionStore = { saveRecovered: saveRecoveredPermission };
