import { maxUint256 } from 'viem';
import { TriangleAlert } from 'lucide-react';
import { AllowanceChange } from '../../utils/allowances';
import { AssetDelta } from '../../utils/assetPreview';
import { formatAddress } from '../../utils/formatAddress';
import { useApprovalTokenKinds } from '../../hooks/useApprovalTokenKind';
import { TokenIcon } from '../TokenIcon';
import { CopyButton } from '../CopyButton';

interface AllowancePreviewProps {
  /** Unlimited allowance changes only, as `unlimitedAllowanceChanges` returns them. */
  changes: AllowanceChange[];
  /** Balance changes of the same simulation: a token seen there lends its symbol. */
  knownTokens: AssetDelta[];
  chainId?: number;
  /** Used to read the approved token when `approve` could be an ERC-20 or an ERC-721. */
  apiKey?: string;
}

interface Row {
  change: AllowanceChange;
  known?: AssetDelta;
}

/**
 * An `approve` from 2^255 up may be an ERC-721 token id (an ENS name's id is its labelhash), so
 * the token is read before the row shows. Exactly max uint256 is taken as an ERC-20 allowance,
 * and so is a token the simulation moved with decimals: an ERC-721 there has 0.
 */
function needsNftCheck({ change, known }: Row): boolean {
  return change.ambiguous && change.amount !== maxUint256 && !(known && known.decimals > 0);
}

function AllowanceRow({ change, known, chainId }: Row & { chainId?: number }) {
  const symbol = known?.symbol ?? '';
  return (
    <div className="flex flex-row items-start gap-1.5 p-2">
      <TokenIcon chainId={chainId} address={change.token} symbol={symbol} className="size-token mt-0.5 flex-none" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground text-symbol truncate">{symbol || formatAddress(change.token)}</span>
        <span className="text-muted-foreground text-body-xs flex min-w-0 flex-row items-center gap-1 font-mono">
          <span className="flex-none">To</span>
          <span className="truncate">{formatAddress(change.spender)}</span>
          <CopyButton value={change.spender} size={10} label="Copy spender address" />
        </span>
        {change.owner && (
          <span className="text-warning text-body-xs font-mono">Permit signed by {formatAddress(change.owner)}</span>
        )}
      </div>
      <span className="text-value text-warning flex flex-none items-center gap-1 break-all text-right font-mono font-semibold">
        <TriangleAlert className="size-3.5 flex-none" strokeWidth={2} />
        {change.allTokens ? 'All tokens' : 'Unlimited'}
      </span>
    </div>
  );
}

/**
 * Unlimited allowances in the calls under review. They move no balance, so the simulation
 * shows nothing for them, yet they let the spender take funds later. An ERC-721 `approve`
 * never shows here: a row waits for its token read, and the card waits for its rows.
 */
export const AllowancePreview = ({ changes, knownTokens, chainId, apiKey }: AllowancePreviewProps) => {
  const rows: Row[] = changes.map((change) => ({
    change,
    known: knownTokens.find((d) => !d.isNative && d.address.toLowerCase() === change.token.toLowerCase()),
  }));
  const kinds = useApprovalTokenKinds(
    rows.filter(needsNftCheck).map((row) => row.change.token),
    chainId,
    apiKey
  );
  const shown = rows.filter((row) => {
    if (!needsNftCheck(row)) return true;
    const kind = kinds[row.change.token.toLowerCase()];
    return kind === 'not-erc721' || kind === 'unknown';
  });

  if (shown.length === 0) return null;

  return (
    <div className="rounded-box border-warning/60 overflow-hidden border">
      <div className="border-border/40 bg-secondary/40 flex items-center gap-2 border-b p-3">
        <TriangleAlert className="text-warning size-3 flex-none" strokeWidth={2.7} />
        <span className="text-foreground text-heading">Token approvals</span>
      </div>
      <div className="divide-border/40 flex flex-col divide-y">
        {shown.map(({ change, known }, i) => (
          <AllowanceRow
            key={`${change.token}:${change.spender}:${i}`}
            change={change}
            known={known}
            chainId={chainId}
          />
        ))}
      </div>
    </div>
  );
};
