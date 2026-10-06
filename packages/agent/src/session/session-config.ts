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
 *
 * One kind is never dropped: an orphan whose expiry cannot be read. The file
 * does not say whether that grant is over, and dropping it is how the grant
 * stops being reachable, so it is kept and `session revoke` will try it. The
 * cost is that those do not self-prune the way expired ones do, and each one
 * revoke reaches for is a transaction the user approves. It is the same trade
 * `sessionLives` makes everywhere else: a permission that may still be live is
 * worth more than a shorter file.
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
