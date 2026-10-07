/**
 * One line of the append-only x402 payment ledger (`~/.jaw/x402-log.jsonl`).
 * Every payment attempt an agent makes is recorded so spend is auditable and an
 * ambiguous settlement can be reconciled by nonce/txHash after the fact.
 */
export interface X402LogEntry {
  /** ISO timestamp of the attempt. */
  at: string;
  url: string;
  /** The paying EOA. */
  payer: string;
  /**
   * The permission this spend is charged against, which is the unit the chain
   * meters. Absent on entries written before the field existed; `countsIn`
   * charges those to their payer instead.
   */
  permissionId?: string;
  /** paid = settled; failed = signed+sent but settlement failed; refused = never signed. */
  status: 'paid' | 'failed' | 'refused';
  /**
   * What actually left the payer. Under `exact` that is the amount signed for.
   * Under `upto` the server chooses it at settlement, anywhere from zero up to
   * `authorized`, and the receipt is the only place it exists.
   */
  amount?: string;
  /**
   * The ceiling the signature authorized, which is what a live authorization is
   * worth to whoever holds it. Equal to `amount` under `exact`. Absent on
   * entries written before the field existed, where `amount` was both.
   */
  authorized?: string;
  /**
   * When the authorization expires. Read by `reconcileSettlements`, which
   * proves a payment moved nothing by finding its deadline past and its nonce
   * unconsumed, and cannot say that about entries that never stored it.
   */
  deadline?: string;
  /** Which scheme signed this, so a reconciliation knows where its nonce lives. */
  scheme?: string;
  asset?: string;
  network?: string;
  payTo?: string;
  nonce?: string;
  txHash?: string;
  /** Base units refilled into the payer through the permission, when a top-up ran. */
  topUpAmount?: string;
  /** wallet_sendCalls id of that top-up, for on-chain reconciliation. */
  topUpBatchId?: string;
  /**
   * wallet_sendCalls id of the Permit2 approval, when this payment granted one.
   * Never summed with `topUpAmount`: it moves no principal, only the gas the
   * payer was charged for it. Recorded so a userOp the user paid for is not
   * missing from the audit trail.
   */
  approvalBatchId?: string;
  /** Reason for a refused/failed attempt. */
  reason?: string;
  /**
   * Set on a row that stands in for older rows a compaction folded away. It
   * carries their totals and is counted like the paid row it is; `folded` says
   * how many it replaced. Rendering reads this, the sums do not.
   */
  kind?: 'checkpoint';
  /** How many rows a checkpoint absorbed. */
  folded?: number;
  /**
   * Whether anything outside the receipt has confirmed what settled.
   *
   * Absent on rows written before the field, which keep counting the amount
   * they reported: those are history, and re-reading them as ceilings would
   * jam every cap that is live today.
   */
  settlement?: SettlementState;
}

/**
 * `unverified` is every signed attempt until the chain says otherwise.
 * `verified` means the chain confirmed the money: a transfer of that amount in
 * the transaction the receipt named, or, on an `exact` attempt the server
 * reported as failed, a nonce the token had consumed, which can only be the
 * transfer the signature fixed. `expired` means the deadline passed with the
 * nonce unconsumed, so the authorization died without moving anything.
 *
 * `abandoned` is the one that says nothing about money: the chain was asked for
 * long enough and never answered, so we stopped asking. The row keeps costing
 * its ceiling, which is what it costs while nobody knows, and it stops holding
 * a slot in every later reconciliation. `expired` would claim the authorization
 * died with nothing moving, and that is a claim about funds this cannot make.
 */
export type SettlementState = 'unverified' | 'verified' | 'expired' | 'abandoned';

/** Where a row stands. `pending`, written before signing, has no `status`/`settlement` spelling. */
export type PaymentRowState = 'pending' | 'signed' | 'settled' | 'failed' | 'unknown';

export type StoredRowState = Exclude<PaymentRowState, 'pending'>;

/**
 * An index a store may keep beside `status` and `settlement`, never in place of
 * them: two rows in one state can cost a cap different amounts, and
 * `spendFigureOf` reads the fields.
 */
export function rowStateOf(row: Pick<X402LogEntry, 'status' | 'settlement'>): StoredRowState {
  if (row.status === 'refused' || row.settlement === 'expired') return 'failed';
  if (row.settlement === 'unverified') return 'signed';
  if (row.settlement === 'verified') return 'settled';
  // Rows from before `settlement` existed.
  if (row.settlement === undefined && row.status === 'paid') return 'settled';
  return 'unknown';
}

/**
 * A later answer about a row that was already written.
 *
 * The ledger is append-only, so a reconciliation cannot edit the payment it is
 * about. It appends this instead, keyed by the nonce that identifies the
 * attempt on chain, and `readX402Log` folds it back on before anyone sees the
 * row. Every reader goes through there, so nothing downstream learns that
 * corrections exist.
 */
export interface X402SettlementCorrection {
  at: string;
  /** The `nonce` of the payment row this answers. Payment rows never carry it. */
  corrects: string;
  settlement: SettlementState;
  /** What the chain says moved, when it says. */
  amount?: string;
  txHash?: string;
}

/**
 * What one row contributes to a spend cap.
 *
 * Exported because two readers need the same answer: `jaw x402 log` reports
 * against it, and the caps enforce against it, so the number a user reads and
 * the number that refuses their next payment are the same number.
 *
 * A settled payment costs what settled. A failed one costs the ceiling it
 * authorized, because an authorization that was signed and sent stays spendable
 * up to that ceiling until its nonce is consumed or its deadline passes, and
 * nothing yet proves either. Under `exact` the two figures are equal.
 *
 * A paid row nobody has checked costs its ceiling for that same reason. The
 * receipt is the server's own claim about how much of its own authorization it
 * took, and a claim is not evidence of itself: a fabricated hash with one base
 * unit against a thousand-unit ceiling would otherwise buy a live authorization
 * for the difference while the caps counted one. `reconcileSettlements` brings
 * the figure down to what the chain shows, one payment later.
 *
 * A row reconciled to `expired` costs nothing. Its deadline passed with its
 * nonce unconsumed, so the authorization died where it stood.
 *
 * Every parse failure reads as zero and the failed case takes the larger of the
 * two, so one unparseable field cannot shrink an enforced cap: a torn write or a
 * hand edit can only ever leave the cap where it was or higher. Negatives clamp
 * for the same reason, since `BigInt('-5')` parses fine and would otherwise
 * subtract.
 */
export function spendFigureOf(entry: X402LogEntry): bigint {
  if (entry.status !== 'paid' && entry.status !== 'failed') return 0n;
  const parse = (value?: string): bigint => {
    if (!value) return 0n;
    try {
      const parsed = BigInt(value);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  };
  if (entry.settlement === 'expired') return 0n;
  // Named, not "anything but unverified". A value this does not recognise, from
  // a torn write or a hand edit, has to land on the ceiling below with every
  // other unreadable field, or a one-character typo turns the cap loose.
  // `abandoned` belongs on that ceiling deliberately and not by omission: it
  // means nobody ever learned what moved.
  const checked = entry.settlement === undefined || entry.settlement === 'verified';
  if (entry.status === 'paid' && checked) return parse(entry.amount);
  const ceiling = parse(entry.authorized);
  const charge = parse(entry.amount);
  return ceiling > charge ? ceiling : charge;
}

/**
 * What a spend total is counted over.
 *
 * The permission, because that is what the chain meters: one permission carries
 * one per-period allowance and every spender under it draws on the same counter.
 * Counting per payer measured each spender against its own copy of the cap, so
 * two sessions granted 10 a day spent 20 a day and no number in the product said
 * so.
 *
 * The payer is not decoration. It is the fallback for entries that predate
 * `permissionId`, and the filter reporting still needs.
 */
export interface SpendScope {
  /**
   * Omitted on purpose by the session total, which is measured against
   * `maxTotalPerSession`, the user's own ceiling rather than the chain's, and
   * spans every permission the payer has held. Set by the per-period figures,
   * which mirror an on-chain counter that a new permission resets.
   */
  permissionId?: string;
  /** The paying EOA, which is what an entry with no permission is charged to. */
  payer: string;
}

/**
 * Whether one row belongs to this scope.
 *
 * Matched on the permission when both sides name one. When either does not, the
 * payers decide: on the day this shipped every existing row had no permission,
 * and dropping them would have reset a live cap to zero and handed an agent its
 * whole allowance back mid-period. An entry with no permission is charged to the
 * payer that wrote it, which is the permission it was spending under at the time.
 *
 * Conservative in the same direction as `spendFigureOf`: it can overcount across
 * a re-grant to the same key, never undercount. The payer branch stops being
 * reached once every row carries a permission.
 */
function countsIn(entry: X402LogEntry, scope: SpendScope): boolean {
  if (scope.permissionId && entry.permissionId) {
    return entry.permissionId.toLowerCase() === scope.permissionId.toLowerCase();
  }
  return entry.payer?.toLowerCase() === scope.payer.toLowerCase();
}

/**
 * Sum settled and attempted payments in `scope` since an ISO instant (its whole
 * history when `since` is omitted).
 *
 * Takes the entries instead of reading them, so a payment that counts several
 * caps reads the file once. The caller takes its snapshot inside the payment
 * lock, where nothing else can append, and every cap for that payment counts
 * against the same rows.
 *
 * Counting from the ledger rather than an in-memory total is what makes a cap
 * survive a process restart, which an agent could otherwise relaunch its way
 * past. What each row costs is `spendFigureOf`.
 */
export function sumSpentSince(entries: X402LogEntry[], scope: SpendScope, since?: string): bigint {
  return entries.reduce((total, entry) => {
    if (!countsIn(entry, scope)) return total;
    if (since && entry.at < since) return total;
    if (entry.kind === 'checkpoint') assertCheckpointReadable(entry);
    return total + spendFigureOf(entry);
  }, 0n);
}

/**
 * Stop a payment rather than let it spend against a total known to be short.
 *
 * Everywhere else in this file an unreadable field costs one payment and reads
 * as zero, which can only leave a cap where it was or higher. A checkpoint
 * breaks that: it is worth every row it absorbed, so one that will not parse
 * takes the cap down by the whole fold, and down is the direction that hands an
 * agent budget it already spent.
 *
 * Only the spend figure. A checkpoint with no `topUpAmount` is ordinary, so
 * there is no unreadable case to tell apart there, and that meter is a floor by
 * construction with the chain as its authority.
 */
function assertCheckpointReadable(entry: X402LogEntry): void {
  if (checkpointFigureReadable(entry)) return;
  throw new Error(
    `x402 ledger has an unreadable checkpoint covering ${entry.folded ?? 'an unknown number of'} rows. ` +
      `Refusing to spend against a short total. The rows it replaced are in the ledger archive.`
  );
}

/**
 * Sum what was pulled through the permission in `scope` since an ISO instant
 * (its whole history when `since` is omitted).
 *
 * Distinct from `sumSpentSince` because the two meter different things: the
 * on-chain allowance is drawn down by the top-up, not by the payment it later
 * funds. With a `topUpFloat` the two run apart by whatever is still sitting in
 * the payer, so measuring the granted per-period cap by payments reads a
 * permission as having more left than it does.
 *
 * Every status counts, refusals included: the pull settled on-chain before the
 * payment it was for was ever attempted, so the allowance is gone either way.
 *
 * Takes the entries for the same reason `sumSpentSince` does.
 */
export function sumToppedUpSince(entries: X402LogEntry[], scope: SpendScope, since?: string): bigint {
  return entries.reduce((total, entry) => {
    if (!countsIn(entry, scope)) return total;
    if (since && entry.at < since) return total;
    return total + toppedUpFigureOf(entry);
  }, 0n);
}

/**
 * What one row contributes to a top-up total.
 *
 * The other meter's `spendFigureOf`, and split out for the same reason: a
 * checkpoint has to fold rows by exactly the rule that later reads them back,
 * and two copies of that rule is how they come apart. A hand-edited amount
 * reads as zero rather than taking the cap down.
 */
export function toppedUpFigureOf(entry: X402LogEntry): bigint {
  if (!entry.topUpAmount) return 0n;
  try {
    return BigInt(entry.topUpAmount);
  } catch {
    return 0n;
  }
}

/**
 * Whether a checkpoint's spend figure can be read back at all.
 *
 * Exported because `sumSpentSince` refuses to total a ledger holding one that
 * cannot, which is right in front of a payment and wrong in front of a report:
 * `x402 status` is what a user runs to find out what is wrong, and it has to be
 * able to say so rather than fail with it.
 */
export function checkpointFigureReadable(entry: X402LogEntry): boolean {
  if (!entry.amount) return false;
  try {
    // `topUpAmount` as well, and for the same reason: a checkpoint carries the
    // whole fold's pulls, so one that will not parse reads as zero and hands a
    // period allowance back. The chain is the authority on that meter only
    // while it can be reached, and `currentLimitUsageOnChain` falls back to
    // this figure when it cannot.
    if (entry.topUpAmount !== undefined && BigInt(entry.topUpAmount) < 0n) return false;
    return BigInt(entry.amount) >= 0n;
  } catch {
    return false;
  }
}
