import { ethAddress } from 'viem';
import type { ClearSigningDisplay, DisplayRow } from '../../utils/clearSigning';
import { useAddressIdentities } from '../../hooks/useAddressIdentities';
import { formatAddress, identityKey } from '../../utils';
import { ENS_ONLY } from '../../utils/addressIdentity';
import { dateTone, formatUnixDate, groupNumber, isUnlimitedAmount } from '../../utils/displayFormat';
import { TriangleAlert } from 'lucide-react';
import { IdentityAvatar } from '../IdentityAvatar';
import { TokenIcon } from '../TokenIcon';
import { CopyButton } from '../CopyButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface ClearSignedViewProps {
  display: ClearSigningDisplay;
  chainId: number;
  mainnetRpcUrl: string;
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
  const rowAddresses = display.rows
    .filter((r) => r.kind === 'address' && r.rawValue)
    .map((r) => ({ address: r.rawValue as string, chainId }));
  const identities = useAddressIdentities(rowAddresses, { mainnetRpcUrl, include: ENS_ONLY });

  const hasHeader = !!display.intent;
  const hasRows = display.rows.length > 0;
  if (!hasHeader && !hasRows) return null;

  return (
    <div className="border-border rounded-box border p-3">
      {hasHeader && <div className={`text-foreground text-heading ${hasRows ? 'mb-3' : ''}`}>{display.intent}</div>}
      {hasRows && (
        <div className="divide-border/40 flex flex-col divide-y">
          {display.rows.map((row, i) => {
            const identity = row.rawValue ? identities[identityKey(row.rawValue, chainId)] : undefined;
            const resolvedName = identity?.ensName ?? undefined;
            const avatarSrc = identity?.ensAvatar ?? undefined;
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
