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
  /**
   * Unix seconds, or null when the session it came from did not say. Carried
   * rather than dropped: `liveOrphans` keeps an orphan whose expiry cannot be
   * read, since dropping it is how the grant it names stops being reachable.
   */
  expiry: number | null;
}

export interface SessionConfig {
  ownerAddress: string;
  sessionAddress: string;
  permissionId: string;
  chainId: number;
  /**
   * When the permission ends, or null when the file does not say.
   *
   * Nullable because this is read off a file a person can edit and a crash can
   * truncate, and the old type said `number` while the value could be anything.
   * That silence is the bug: `expiry <= now` is false for a `NaN`, so an
   * unreadable field turned the expiry check off instead of failing it, and the
   * compiler could not point at the places that would have to decide.
   *
   * Every reader answers it for itself, because the safe answer differs by
   * question: see `sessionLives` for the cleanup side and `SessionBridge` for
   * the spending side.
   */
  expiry: number | null;
  /**
   * When the session began, or undefined on a session written before the field.
   *
   * Optional for the same reason, and the absent case was always supported:
   * `sumSpentSince` takes the instant as optional and counts the payer's whole
   * history without it, which is the conservative direction.
   */
  createdAt?: string;
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
  // `sessionLives` rather than a comparison, for the reason it carries: an
  // orphan whose expiry will not read is the one that most needs to be kept,
  // since dropping it is how the grant it names stops being reachable.
  return (orphans ?? []).filter((orphan) => sessionLives(orphan.expiry, now));
}

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

/** Whether an instant can be read back at all. */
function isReadableInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * The expiry as an instant, or null when the file does not say.
 *
 * Every caller that prints one goes through here. `new Date(NaN).toISOString()`
 * throws, so a field that will not read took down the command that was trying to
 * report it, which is the command someone runs precisely because something is
 * wrong.
 */
export function expiryInstant(expiry: number | null | undefined): Date | null {
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) return null;
  const instant = new Date(expiry * 1000);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Whether a session may still be used to act.
 *
 * The spending side of the same question `sessionLives` answers for cleanup, and
 * it answers the opposite way when the file cannot say: an expiry nobody can
 * read is not a licence to sign, and it is not a reason to skip a revoke either.
 * Both are exported so the two sides are readable next to each other rather than
 * being two comparisons that happen to differ.
 */
export function sessionUsable(expiry: number | null | undefined, now: number = Date.now() / 1000): expiry is number {
  return typeof expiry === 'number' && Number.isFinite(expiry) && expiry > now;
}

/**
 * Whether a session should be treated as still holding something on chain.
 *
 * Separate from asking whether it may spend, and deliberately answers the
 * opposite way when the file cannot say. An `expiry` that will not read is a
 * question nobody can answer locally, and the two callers that ask it want
 * opposite defaults: a payment must not go out under an unknown expiry, and a
 * revoke must not skip a permission that may still be live. Answering "expired"
 * everywhere is the quiet version of stranding the grant, since `session revoke`
 * skips the chain for an expired session and deletes the local record, and
 * `session setup` only carries an orphan forward from a session it considers
 * active.
 *
 * So this one answers for the cleanup side: unknown means assume there is
 * something there. `SessionBridge` answers the other side for itself.
 */
export function sessionLives(expiry: unknown, now: number = Date.now() / 1000): boolean {
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) return true;
  return expiry > now;
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
