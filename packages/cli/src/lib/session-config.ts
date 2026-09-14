import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import { ensureDir } from './config.js';

/**
 * How the session account address is derived, as it appears on disk.
 *
 * 'eip7702' is the only one written now: the session key EOA itself, upgraded
 * in place via a delegation attached to its first userOp, so the session
 * account and the x402 payer are one address.
 *
 * 'counterfactual' is what earlier versions wrote, and what a config from
 * before the field existed means: a CREATE2 prediction from the account
 * factory, a second address that holds nothing and so cannot be charged for
 * the gas of the ops it sends. Still in the union because those files exist and
 * `SessionBridge` has to recognise them; `SessionSetup` never writes it.
 */
export type SessionMode = 'counterfactual' | 'eip7702';

/**
 * The granted permission as `JustaPermissionManager` stores it.
 *
 * Every view on the manager takes `Permission calldata` and hashes it inside:
 * `isApproved`, `isRevoked` and `getCurrentPeriod` all do, and none of them
 * accept an id. A session holding only `permissionId` therefore holds the one
 * field the chain will not answer about, which is why nothing local could tell
 * that a permission had been revoked from another device.
 *
 * The grant response already carries all of it, so this costs a wider write
 * rather than a network call. Optional on read for two reasons: configs written
 * before this field exist, and a wallet running an older core answers with the
 * id alone. Consumers fall back to the local file, which is what those sessions
 * already meant.
 */
export interface GrantedPermission {
  account: string;
  spender: string;
  /**
   * Unix seconds the permission starts at. Also the anchor the contract steps
   * its period windows from, and what the local policy anchors on.
   */
  start: number;
  /** Unix seconds the permission ends at. */
  end: number;
  /** Hex, as the grant returned it. Widened to a bigint at encode time. */
  salt: string;
  calls: Array<{ target: string; selector: string }>;
  spends: Array<{ token: string; allowance: string; unit: string; multiplier: number }>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
/** Decimal or hex, matching what the SDK hands to `BigInt()`. */
const ALLOWANCE_RE = /^(0x[0-9a-fA-F]+|[0-9]+)$/;
/** The units a grant may carry. `year` has no on-chain enum and is rewritten before encoding. */
const SPEND_UNITS = new Set(['minute', 'hour', 'day', 'week', 'month', 'year', 'forever']);

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * The permission struct out of a `wallet_grantPermissions` response, or
 * undefined when the response does not carry a usable one.
 *
 * Undefined rather than a throw, on every malformed field. By the time this
 * runs the grant is already on chain, and refusing to write the session over a
 * field that arrived in an unexpected shape would strand a live permission with
 * no local record of it. A session that skips this keeps behaving the way every
 * session behaved before the field existed.
 *
 * Strict about what it does accept: a struct that is wrong in any part hashes
 * to something other than the granted permission, so every on-chain read made
 * from it would quietly answer about a permission that does not exist.
 */
export function parseGrantedPermission(raw: unknown): GrantedPermission | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;

  const { account, spender, salt } = r;
  if (typeof account !== 'string' || !ADDRESS_RE.test(account)) return undefined;
  if (typeof spender !== 'string' || !ADDRESS_RE.test(spender)) return undefined;
  if (typeof salt !== 'string' || !HEX_RE.test(salt)) return undefined;
  if (!isPositiveInt(r.start) || !isPositiveInt(r.end)) return undefined;

  if (!Array.isArray(r.calls) || r.calls.length === 0) return undefined;
  const calls: GrantedPermission['calls'] = [];
  for (const entry of r.calls) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { target, selector } = entry as Record<string, unknown>;
    if (typeof target !== 'string' || !ADDRESS_RE.test(target)) return undefined;
    // The response builds the selector from the signature, so an entry without
    // one cannot be reconstructed: the signature it came from is not returned.
    if (typeof selector !== 'string' || !SELECTOR_RE.test(selector)) return undefined;
    calls.push({ target, selector });
  }

  if (!Array.isArray(r.spends)) return undefined;
  const spends: GrantedPermission['spends'] = [];
  for (const entry of r.spends) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { token, allowance, unit, multiplier } = entry as Record<string, unknown>;
    if (typeof token !== 'string' || !ADDRESS_RE.test(token)) return undefined;
    if (typeof allowance !== 'string' || !ALLOWANCE_RE.test(allowance)) return undefined;
    if (typeof unit !== 'string' || !SPEND_UNITS.has(unit)) return undefined;
    // `multiplier` is a uint16 on chain and defaults to 1 in the grant, but the
    // encoded struct has to carry the number the permission was hashed with,
    // so an absent one is a struct we cannot rebuild rather than a 1.
    if (!isPositiveInt(multiplier) || multiplier > 65535) return undefined;
    spends.push({ token, allowance, unit, multiplier });
  }

  return { account, spender, start: r.start, end: r.end, salt, calls, spends };
}

/**
 * Whether this session predates the CLI settling on one account derivation, so
 * its permission belongs to an address separate from the session key and no op
 * it sends can be charged for its own gas.
 *
 * Named rather than compared inline: three callers ask this, and each one
 * spelled as `mode !== 'eip7702'` reads like a check for a variant among
 * several, when the only question is whether the session is still usable.
 */
export function isLegacySession(config: Pick<SessionConfig, 'mode'>): boolean {
  return config.mode !== 'eip7702';
}

/**
 * A permission this CLI granted and then stopped tracking.
 *
 * `session setup` replaces a session rather than adding to it, and it does not
 * always revoke what it replaces: the interactive path takes no for an answer,
 * and `--yes` never revokes at all. The session key is reused by default, so
 * the address the session signs with then holds two live grants while the
 * config names one. Its real authority is the sum of both, `x402 status`
 * reports only the new one, and without the id kept here `session revoke`
 * cannot reach the old one at all, since it lives only in the file setup
 * overwrites.
 *
 * Keeping the id is what makes it reachable again. Nothing here revokes on its
 * own: setup already asked.
 */
export interface OrphanedPermission {
  id: string;
  chainId: number;
  /** Unix seconds. */
  expiry: number;
}

export interface SessionConfig {
  ownerAddress: string;
  sessionAddress: string;
  permissionId: string;
  chainId: number;
  expiry: number;
  createdAt: string;
  mode?: SessionMode;
  /** The struct the on-chain reads need. Absent on older sessions; see the type. */
  permission?: GrantedPermission;
  /** Permissions this key still holds that the session no longer names. */
  orphanedPermissions?: OrphanedPermission[];
  /**
   * Whether the permission this session names has already been revoked, while
   * something else it holds has not.
   *
   * Its own field rather than a rewritten `expiry`. `expiry` means when the
   * permission ends, and the recovered-struct check compares it against the
   * permission's own `end` to know the relay answered about this session:
   * overwriting it makes that comparison fail forever, so a partly revoked
   * session can never recover its struct and stays on "cannot tell", which is
   * the state recovery exists to end. A field that says one thing cannot be
   * borrowed to say another.
   */
  permissionRevoked?: boolean;
}

/**
 * The orphans still worth carrying, newest first.
 *
 * An expired permission authorises nothing, so it is dropped rather than
 * accumulating in the file for the life of the machine. Dropping it is the same
 * decision `session revoke` makes when it skips the browser for an expired
 * session.
 */
export function liveOrphans(
  orphans: OrphanedPermission[] | undefined,
  now: number = Date.now() / 1000
): OrphanedPermission[] {
  return (orphans ?? []).filter((orphan) => orphan.expiry > now);
}

/**
 * `mode` is required and pinned here, unlike on the read side where it stays
 * optional to describe files earlier versions wrote. Nothing but `SessionSetup`
 * writes a session, and a session written without the mode would be refused by
 * `SessionBridge` as if an old CLI had made it, so the compiler holds the
 * invariant rather than a test having to.
 */
export function saveSessionConfig(
  input: Omit<SessionConfig, 'createdAt' | 'mode'> & {
    mode: 'eip7702';
    /**
     * Carried over when a session is being replaced in place rather than
     * started, which `session add` does. `createdAt` is what the session total
     * is counted from (`sumSpentSince(payer, session.createdAt)`), so stamping a
     * fresh one there would hand the session cap a clean slate as a side effect
     * of adding a capability.
     */
    createdAt?: string;
  }
): void {
  writeSessionConfig({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
}

/**
 * Written to a temporary file and renamed over the real one, which is atomic on
 * the same filesystem, so a reader never sees a half-written config.
 *
 * Recovering the permission struct turns two commands that otherwise only read
 * (`x402 status`, `session status`) into writers, and the MCP server runs
 * alongside a terminal, so two processes writing at once is ordinary rather than
 * exotic. A torn file loses the permission id, which is exactly the stranding
 * the orphan list exists to prevent.
 */
function writeSessionConfig(config: SessionConfig): void {
  ensureDir(PATHS.root);
  const temp = `${PATHS.sessionConfig}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, PATHS.sessionConfig);
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

export function loadSessionConfig(): SessionConfig {
  if (!fs.existsSync(PATHS.sessionConfig)) {
    throw new Error('No session configured. Run `jaw session setup` first.');
  }
  const raw = fs.readFileSync(PATHS.sessionConfig, 'utf-8');
  try {
    return JSON.parse(raw) as SessionConfig;
  } catch {
    throw new Error(`Session config at ${PATHS.sessionConfig} is corrupted. Run \`jaw session setup\` to recreate it.`);
  }
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
