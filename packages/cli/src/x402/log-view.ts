import { formatUsdc } from './status-report.js';
import { usdcForNetwork } from './asset-registry.js';
import { sanitizeLine } from '../lib/terminal.js';
import { spendFigureOf, type X402LogEntry } from './ledger.js';

/**
 * Rendering for `jaw x402 log`, kept apart from the command so the accounting in
 * the summary can be tested without a ledger file on disk.
 */

/** Scale by the network the entry was denominated in, not a global assumption. */
export function decimalsOf(entry: X402LogEntry): number {
  return (entry.network ? usdcForNetwork(entry.network)?.decimals : undefined) ?? 6;
}

export function hostOf(url: string): string {
  try {
    return sanitizeLine(new URL(url).host, 80);
  } catch {
    // Not a URL, so nothing has been parsed away: bound and disarm it.
    return sanitizeLine(url, 80);
  }
}

export function renderEntry(entry: X402LogEntry): string {
  // Everything here is read back from a file, so nothing is trusted for being
  // ours originally: a tampered ledger must not be able to paint a row either.
  const when = sanitizeLine(String(entry.at).replace('T', ' ').slice(0, 19), 19);
  // What the caps counted for this row, not what the server charged: on a
  // failed attempt those differ, and the figure a user needs to see is the one
  // that will refuse their next payment.
  const counted = spendFigureOf(entry);
  const amount = entry.amount || entry.authorized ? formatUsdc(counted.toString(), decimalsOf(entry)) : '';
  const head = `  ${when}  ${sanitizeLine(entry.status, 7).padEnd(7)}  ${amount.padStart(12)}  ${hostOf(entry.url)}`;

  const detail: string[] = [];
  // A top-up moved user funds through the permission. Always visible, even on an
  // attempt that then failed, since that money left the account regardless.
  if (entry.topUpAmount) {
    detail.push(`topped up ${formatUsdc(entry.topUpAmount, decimalsOf(entry))}`);
  }
  // The Permit2 approval moved no principal, only the gas the payer was charged
  // for it, so it is named rather than totalled.
  if (entry.approvalBatchId) detail.push('granted Permit2 its allowance');
  if (entry.txHash) detail.push(sanitizeLine(entry.txHash, 80));
  // A failed settlement may still have been broadcast: the nonce is what makes
  // it reconcilable on chain, so surface it exactly where it is ambiguous.
  if (entry.status === 'failed' && entry.nonce) detail.push(`nonce ${sanitizeLine(entry.nonce, 80)}`);
  // Stored server text: an endpoint that got refused once would
  // otherwise repaint this line on every later `x402 log`.
  if (entry.reason) detail.push(sanitizeLine(entry.reason, 200));

  return detail.length > 0 ? `${head}\n${' '.repeat(24)}${detail.join('  ')}` : head;
}

export function renderSummary(entries: X402LogEntry[]): string {
  const counts = { paid: 0, failed: 0, refused: 0 };
  // Only settled and attempted payments count as money out; a refusal never
  // signed anything. Same rule the spend caps use.
  //
  // Totalled per decimals scale rather than as one number. Base units from
  // tokens with different decimals are not the same unit, so adding them and
  // formatting the result with whichever entry happened to come last would
  // print a confident, wrong figure. Every USDC in the registry is 6 decimals
  // today, so this is a single group in practice and the guard costs nothing.
  const spentByScale = new Map<number, bigint>();
  let unknown = 0;
  for (const entry of entries) {
    // Own keys only: `in` walks the prototype, so a row saying `constructor`
    // would take the counted branch, land on a key nothing reads, and disappear
    // from both tallies. Anything unrecognised counts as unknown rather than
    // being dropped, so a malformed row cannot shrink the reported total.
    if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
    else unknown += 1;
    const counted = spendFigureOf(entry);
    if (counted > 0n) {
      try {
        const decimals = decimalsOf(entry);
        spentByScale.set(decimals, (spentByScale.get(decimals) ?? 0n) + counted);
      } catch {
        /* a hand-edited asset must not break the summary */
      }
    }
  }

  const parts = [`${counts.paid} paid`];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.refused > 0) parts.push(`${counts.refused} refused`);
  if (unknown > 0) parts.push(`${unknown} unreadable`);

  const totals =
    spentByScale.size === 0
      ? formatUsdc('0', 6)
      : [...spentByScale.entries()].map(([decimals, spent]) => formatUsdc(spent.toString(), decimals)).join(' + ');

  return `  ${parts.join(', ')}, ${totals} out`;
}
