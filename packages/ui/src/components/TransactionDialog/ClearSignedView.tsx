import { useEffect, useRef, useState } from 'react';
import { ethAddress } from 'viem';
import type { ClearSigningDisplay, DisplayRow } from '../../utils/clearSigning';
import { reverseResolveWithAvatars, formatAddress, getChainLabel, identityKey } from '../../utils';
import { dateTone, formatUnixDate, groupNumber, isUnlimitedAmount } from '../../utils/displayFormat';
import { TriangleAlert } from 'lucide-react';
import { IdentityAvatar } from '../IdentityAvatar';
import { TokenIcon } from '../TokenIcon';
import { CopyButton } from '../CopyButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface ClearSignedViewProps {
  display: ClearSigningDisplay;
  chainId: number;
  mainnetRpcUrl?: string;
}

function TokenAmountValue({ row, chainId }: { row: DisplayRow; chainId: number }) {
  // Max-uint approvals read as "Unlimited" (matching the raw tree) rather than a
  // 78-digit number, and carry a warning tone (warning + triangle) — an unbounded
  // allowance is exactly what a user must notice. Full amounts wrap, never truncate.
  const unlimited = isUnlimitedAmount(row.rawValue);
  return (
    <div className="flex min-w-0 flex-row items-center justify-end gap-1.5">
      {unlimited ? (
        <TriangleAlert className="text-warning size-3.5 flex-none" strokeWidth={2} />
      ) : (
        <TokenIcon
          chainId={chainId}
          address={row.tokenAddress ?? ethAddress}
          symbol={row.symbol}
          className="size-4 flex-none"
        />
      )}
      <p className={`text-body-sm break-all font-mono ${unlimited ? 'text-warning' : 'text-foreground'}`}>
        <span className="font-semibold">{unlimited ? 'Unlimited' : groupNumber(row.value)}</span>
        {row.symbol && <span className={unlimited ? '' : 'text-muted-foreground'}> {row.symbol}</span>}
      </p>
    </div>
  );
}

/** Deadline/expiry value: "1 Jan 2030", tinted + a hover ⚠ when expired (past) or far-future. */
function DateValue({ raw }: { raw: string }) {
  const tone = dateTone(raw);
  const toneClass = tone === 'expired' ? 'text-destructive' : tone === 'far' ? 'text-warning' : 'text-foreground';
  const note =
    tone === 'expired' ? 'This date is in the past.' : tone === 'far' ? 'More than a year in the future.' : undefined;
  return (
    <span className={`text-body-sm flex min-w-0 items-center justify-end gap-1.5 break-all font-mono ${toneClass}`}>
      {note && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span aria-label={note} className="flex-none cursor-help">
              <TriangleAlert className={`size-3.5 ${toneClass}`} strokeWidth={2} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{note}</TooltipContent>
        </Tooltip>
      )}
      {formatUnixDate(raw)}
    </span>
  );
}

function AddressValue({
  row,
  resolvedName,
  avatarSrc,
}: {
  row: DisplayRow;
  resolvedName?: string;
  avatarSrc?: string;
}) {
  const addr = row.rawValue ?? row.value;
  return (
    <div className="flex min-w-0 flex-row items-center justify-end gap-1.5">
      <IdentityAvatar src={avatarSrc} fallback={null} />
      {/* Truncate — the raw column is right-aligned and must never wrap the row. */}
      <span className="text-foreground text-body-sm truncate font-mono">
        {resolvedName ? resolvedName : formatAddress(addr)}
      </span>
      <CopyButton value={addr} size={12} resetAfterMs={1500} label="Copy address" className="text-muted-foreground" />
    </div>
  );
}

export const ClearSignedView = ({ display, chainId, mainnetRpcUrl }: ClearSignedViewProps) => {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const attemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!mainnetRpcUrl) return;
    const addresses = display.rows
      .filter((r) => r.kind === 'address' && r.rawValue)
      .map((r) => (r.rawValue as string).toLowerCase());
    // Keyed by chain: the @chainlabel suffix baked into a resolved name is chain-specific,
    // so a chainId change must re-resolve rather than reuse the stale label.
    const unique = [...new Set(addresses)].filter((a) => !attemptedRef.current.has(identityKey(a, chainId)));
    if (unique.length === 0) return;

    // An attempt only "counts" once it lands — the cleanup un-marks anything still in flight.
    unique.forEach((a) => attemptedRef.current.add(identityKey(a, chainId)));
    const unmark = () => unique.forEach((a) => attemptedRef.current.delete(identityKey(a, chainId)));

    let cancelled = false;
    // Set once this run's result has landed. After that the attempt "counts" — including
    // for addresses that resolved to no name — so the cleanup must leave the marks alone
    // or every unresolvable address gets re-queried on the next run.
    let wrote = false;
    reverseResolveWithAvatars(
      unique.map((address) => ({ address, chainId })),
      mainnetRpcUrl
    )
      .then(async (resolved) => {
        if (cancelled) return;
        const label = await getChainLabel(chainId, mainnetRpcUrl);
        if (cancelled) return;
        wrote = true;
        const nextResolved: Record<string, string> = {};
        const nextAvatars: Record<string, string> = {};
        for (const address of unique) {
          const identity = resolved[identityKey(address, chainId)];
          if (!identity) continue;
          nextResolved[address] = label ? `${identity.name}@${label}` : identity.name;
          if (identity.avatar) nextAvatars[address] = identity.avatar;
        }
        setResolved((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const [address, value] of Object.entries(nextResolved)) {
            if (next[address] !== value) {
              next[address] = value;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        if (Object.keys(nextAvatars).length > 0) {
          setAvatars((prev) => ({ ...prev, ...nextAvatars }));
        }
      })
      .catch(unmark);
    return () => {
      cancelled = true;
      // If this run never wrote its result, its "attempted" marks must not outlive it —
      // otherwise the next run filters every address out as already-tried and resolution
      // is blocked for good.
      if (!wrote) unmark();
    };
  }, [display, mainnetRpcUrl, chainId]);

  const hasHeader = !!display.intent;
  const hasRows = display.rows.length > 0;
  if (!hasHeader && !hasRows) return null;

  return (
    <div className="border-border rounded-box border p-3">
      {hasHeader && <div className={`text-foreground text-heading ${hasRows ? 'mb-3' : ''}`}>{display.intent}</div>}
      {hasRows && (
        <div className="divide-border/40 flex flex-col divide-y">
          {display.rows.map((row, i) => {
            const lookup = row.rawValue?.toLowerCase();
            const resolvedName = lookup ? resolved[lookup] : undefined;
            const avatarSrc = lookup ? avatars[lookup] : undefined;
            return (
              // Row-wise: label left, value right — one line each, value truncates.
              <div key={i} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="text-muted-foreground text-body-sm flex-none font-medium">{row.label}</span>
                <div className="min-w-0 text-right">
                  {row.kind === 'tokenAmount' || row.kind === 'amount' ? (
                    <TokenAmountValue row={row} chainId={chainId} />
                  ) : row.kind === 'address' ? (
                    <AddressValue row={row} resolvedName={resolvedName} avatarSrc={avatarSrc} />
                  ) : row.kind === 'date' && row.rawValue ? (
                    <DateValue raw={row.rawValue} />
                  ) : (
                    <span className="text-foreground text-body-sm break-all font-mono">{row.value}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
