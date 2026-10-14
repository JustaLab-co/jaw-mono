import { formatUnits } from 'viem';
import { TriangleAlert } from 'lucide-react';
import { AllowanceChange } from '../../utils/allowances';
import { AssetDelta } from '../../utils/assetPreview';
import { formatAddress } from '../../utils/formatAddress';
import { TokenIcon } from '../TokenIcon';
import { CopyButton } from '../CopyButton';

interface AllowancePreviewProps {
  changes: AllowanceChange[];
  /** Balance changes of the same simulation: a token seen there lends its symbol and decimals. */
  knownTokens: AssetDelta[];
  chainId?: number;
}

/** A zero `approve` is a revoke only on a token known to be an ERC-20: on an NFT it clears one id. */
function isRevoke(change: AllowanceChange, known?: AssetDelta): boolean {
  return change.revoke && (!change.ambiguous || !!known);
}

function amountLabel(change: AllowanceChange, known?: AssetDelta): string {
  if (isRevoke(change, known)) return 'Revoke';
  if (change.allTokens) return 'All tokens';
  if (change.unlimited) return 'Unlimited';
  const raw = change.amount ?? 0n;
  const amount = known ? formatUnits(raw, known.decimals) : `${raw} (raw)`;
  return change.added ? `+${amount}` : amount;
}

function AllowanceRow({ change, known, chainId }: { change: AllowanceChange; known?: AssetDelta; chainId?: number }) {
  const symbol = known?.symbol ?? '';
  if (change.undecoded) {
    return (
      <div className="flex flex-row items-start gap-1.5 p-2">
        <TokenIcon chainId={chainId} address={change.token} symbol={symbol} className="size-token mt-0.5 flex-none" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-foreground text-symbol truncate">{symbol || formatAddress(change.token)}</span>
          <span className="text-warning text-body-xs flex flex-row items-center gap-1">
            <TriangleAlert className="size-3.5 flex-none" strokeWidth={2} />
            Allowance call could not be read
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-row items-start gap-1.5 p-2">
      <TokenIcon chainId={chainId} address={change.token} symbol={symbol} className="size-token mt-0.5 flex-none" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground text-symbol truncate">{symbol || formatAddress(change.token)}</span>
        <span className="text-muted-foreground text-body-xs flex min-w-0 flex-row items-center gap-1 font-mono">
          <span className="flex-none">{isRevoke(change, known) ? 'Spender' : 'To'}</span>
          <span className="truncate">{formatAddress(change.spender)}</span>
          <CopyButton value={change.spender} size={10} label="Copy spender address" />
        </span>
        {change.owner && (
          <span className="text-warning text-body-xs font-mono">Permit signed by {formatAddress(change.owner)}</span>
        )}
      </div>
      <span
        className={`text-value flex flex-none items-center gap-1 break-all text-right font-mono font-semibold ${
          change.unlimited ? 'text-warning' : 'text-foreground'
        }`}
      >
        {change.unlimited && <TriangleAlert className="size-3.5 flex-none" strokeWidth={2} />}
        {amountLabel(change, known)}
      </span>
    </div>
  );
}

/**
 * Allowance changes decoded from the calls under review. They move no balance, so the
 * simulation shows nothing for them, yet they let the spender take funds later.
 */
export const AllowancePreview = ({ changes, knownTokens, chainId }: AllowancePreviewProps) => {
  if (changes.length === 0) return null;

  const hasWarning = changes.some((c) => c.unlimited || c.undecoded);

  return (
    <div className={`rounded-box overflow-hidden border ${hasWarning ? 'border-warning/60' : 'border-border'}`}>
      <div className="border-border/40 bg-secondary/40 flex items-center gap-2 border-b p-3">
        {hasWarning && <TriangleAlert className="text-warning size-3 flex-none" strokeWidth={2.7} />}
        <span className="text-foreground text-heading">Permissions granted</span>
      </div>
      <div className="divide-border/40 flex flex-col divide-y">
        {changes.map((change, i) => (
          <AllowanceRow
            key={`${change.token}:${change.spender}:${i}`}
            change={change}
            known={knownTokens.find((d) => !d.isNative && d.address.toLowerCase() === change.token.toLowerCase())}
            chainId={chainId}
          />
        ))}
      </div>
    </div>
  );
};
