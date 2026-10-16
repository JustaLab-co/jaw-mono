import { formatUnits } from 'viem';
import { TriangleAlert } from 'lucide-react';
import { AllowanceChange } from '../../utils/allowances';
import { AssetDelta } from '../../utils/assetPreview';
import { formatAddress } from '../../utils/formatAddress';
import { useApprovalTokenKind } from '../../hooks/useApprovalTokenKind';
import { TokenIcon } from '../TokenIcon';
import { CopyButton } from '../CopyButton';

interface AllowancePreviewProps {
  changes: AllowanceChange[];
  /** Balance changes of the same simulation: a token seen there lends its symbol and decimals. */
  knownTokens: AssetDelta[];
  chainId?: number;
  /** Used to read the approved token when `approve` could be an ERC-20 or an ERC-721. */
  apiKey?: string;
}

/** What is known about the approved token: its decimals, or that it is an NFT, or that we are still asking. */
interface TokenView {
  decimals?: number;
  nft: boolean;
  pending: boolean;
}

/** A zero `approve` is a revoke only on a token known to be an ERC-20: on an NFT it clears one id. */
function isRevoke(change: AllowanceChange, view: TokenView): boolean {
  return change.revoke && !view.nft && (!change.ambiguous || view.decimals !== undefined);
}

function amountLabel(change: AllowanceChange, view: TokenView): string {
  if (view.nft) return `NFT #${change.amount ?? 0n}`;
  if (isRevoke(change, view)) return 'Revoke';
  if (change.allTokens) return 'All tokens';
  if (change.unlimited) return 'Unlimited';
  if (view.pending) return 'Reading token…';
  const raw = change.amount ?? 0n;
  const amount = view.decimals === undefined ? `${raw} (raw)` : formatUnits(raw, view.decimals);
  return change.added ? `+${amount}` : amount;
}

interface AllowanceRowProps {
  change: AllowanceChange;
  known?: AssetDelta;
  chainId?: number;
  apiKey?: string;
}

function AllowanceRow({ change, known, chainId, apiKey }: AllowanceRowProps) {
  const symbol = known?.symbol ?? '';
  const kind = useApprovalTokenKind(change.token, chainId, apiKey, change.ambiguous && !known && !change.undecoded);
  const view: TokenView = {
    decimals: known?.decimals ?? (kind.status === 'erc20' ? kind.decimals : undefined),
    nft: kind.status === 'erc721',
    pending: kind.status === 'loading',
  };
  const warnAmount = change.unlimited && !view.nft;
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
          <span className="flex-none">{isRevoke(change, view) ? 'Spender' : 'To'}</span>
          <span className={view.nft ? 'text-warning truncate' : 'truncate'}>{formatAddress(change.spender)}</span>
          <CopyButton value={change.spender} size={10} label="Copy spender address" />
        </span>
        {change.owner && (
          <span className="text-warning text-body-xs font-mono">Permit signed by {formatAddress(change.owner)}</span>
        )}
      </div>
      <span
        className={`text-value flex flex-none items-center gap-1 break-all text-right font-mono font-semibold ${
          warnAmount ? 'text-warning' : 'text-foreground'
        }`}
      >
        {warnAmount && <TriangleAlert className="size-3.5 flex-none" strokeWidth={2} />}
        {amountLabel(change, view)}
      </span>
    </div>
  );
}

/**
 * Allowance changes decoded from the calls under review. They move no balance, so the
 * simulation shows nothing for them, yet they let the spender take funds later.
 */
export const AllowancePreview = ({ changes, knownTokens, chainId, apiKey }: AllowancePreviewProps) => {
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
            apiKey={apiKey}
          />
        ))}
      </div>
    </div>
  );
};
