import type { ReactNode } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { AccountAvatar } from './AccountAvatar';
import { CopyButton } from './CopyButton';
import { SubText } from './SubText';
import { subscriptDecimal } from '../utils/displayFormat';

/** The dialog's small uppercase field label. */
export function Eyebrow({ children }: { children: ReactNode }) {
  // `text-label` carries the weight and the 0.13em tracking, so neither is repeated here.
  return <span className="text-muted-foreground text-label block font-mono uppercase">{children}</span>;
}

/** A bordered label/value micro-card, matching the signing dialogs. */
export function Row({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={`border-border rounded-box border p-3 ${className ?? ''}`}>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** A native-currency amount with its USD equivalent, when a price is available. */
export function ValueAmount({
  amount,
  symbol,
  price,
  className,
}: {
  amount: string;
  symbol: string;
  price: number;
  className: string;
}) {
  const num = Number(amount);
  const shown = num > 0 && num < 0.0001 ? subscriptDecimal(num) : amount;
  return (
    <p className={className}>
      <SubText>{`${shown} ${symbol}`}</SubText>
      {price > 0 && <span className="text-muted-foreground text-body-xs ml-1.5">≈ ${(num * price).toFixed(2)}</span>}
    </p>
  );
}

/**
 * One party in the transaction — From, To, or the contract being called. Avatar on the left,
 * label above the value beside it, with a copy button carrying the full address.
 */
export function PartyRow({
  label,
  value,
  address,
  avatarUrl,
  badge,
}: {
  label: string;
  value: string;
  address: string;
  avatarUrl?: string;
  /** Pinned to the avatar's corner — marks this party as acting under a delegation. */
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="relative inline-flex flex-none">
        <AccountAvatar seed={address} avatarUrl={avatarUrl} size={28} className="rounded-chip size-blob-lg flex-none" />
        {badge}
      </span>
      <div className="min-w-0 flex-1">
        <Eyebrow>{label}</Eyebrow>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          {/* The spec sets this value in Inter; it stays mono because the same slot renders raw
              hex addresses, where a fixed advance width is what makes them checkable. */}
          <p className="text-foreground text-value truncate font-mono">{value}</p>
          {/* Nothing to copy while the address is still resolving, or never resolved. */}
          {address && <CopyButton value={address} size={13} label="Copy address" />}
        </div>
      </div>
    </div>
  );
}

/** A one-line red message with the detail, if any, behind an info tooltip. */
export function InlineWarning({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="flex items-center gap-1">
      {/* Sits where the fee figure would be, so it takes the body size rather than a label size. */}
      <p className="text-destructive text-body-sm font-mono font-medium">{text}</p>
      {detail && (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="text-destructive size-3 flex-none cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[240px] text-xs">
              <p>{detail}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

/** A yellow box, one paragraph per message. */
export function WarningNotice({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="border-warning/40 bg-warning/10 rounded-box flex items-start gap-2 border p-3">
      <TriangleAlert className="text-warning mt-px size-3.5 flex-none" strokeWidth={2} />
      <div className="text-foreground text-body-sm flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
        {messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </div>
    </div>
  );
}
