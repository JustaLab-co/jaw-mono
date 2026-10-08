import { formatUnits } from 'viem';
import type { PaymentView } from '../../lib/approval-decision';

/** The server's preview, as served: it is read from the same typed data the owner signs. */
export function PaymentTerms({ preview }: { preview: PaymentView['preview'] }) {
  return (
    <>
      <p className="text-sm">
        Pay <span className="font-semibold">{formatUnits(BigInt(preview.amount), 6)} USDC</span> once from this account
      </p>
      <p className="text-muted-foreground text-sm">
        To: <span className="font-mono">{preview.payTo}</span>
      </p>
      <p className="text-muted-foreground break-all text-sm">
        For: <span className="font-mono">{preview.resource}</span>
      </p>
      <p className="text-muted-foreground text-sm">
        Token <span className="font-mono">{preview.token}</span> on {preview.network}
      </p>
      <p className="text-muted-foreground text-xs">Valid until {new Date(preview.validUntil).toLocaleString()}</p>
    </>
  );
}
