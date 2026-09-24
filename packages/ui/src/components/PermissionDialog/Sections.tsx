'use client';

import { TriangleAlert } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion';
import { AccountAvatar } from '../AccountAvatar';
import { TokenIcon } from '../TokenIcon';
import { Skeleton } from '../ui/skeleton';
import { CopyButton } from '../CopyButton';
import { Eyebrow } from '../primitives';
import { isNativeToken } from '../../utils/tokenBalance';
import { isWildcard } from '../../utils/permissionExecution';
import { getDisplayAddress } from '../../utils';
import { isLongSpendAmount } from '../../utils/displayFormat';
import type { CallPermission, SpendPermission } from './types';

export { isWildcard };

/**
 * The allowance period as a rate suffix, so it reads on one line with the amount:
 * "1 Day" → "/day", "4 Days" → "/4 days". "Forever" has no period to qualify.
 */
export function spendRate(duration?: string): string {
  const value = duration?.trim();
  if (!value || /^forever$/i.test(value)) return '';
  const match = /^(\d+)\s+(.+)$/.exec(value);
  if (!match) return `/${value.toLowerCase()}`;
  const [, count, unit] = match;
  return count === '1' ? `/${unit.toLowerCase()}` : `/${count} ${unit.toLowerCase()}`;
}

/** Amber badge pinned to an avatar, marking an unrestricted scope. */
function WarnBadge() {
  return (
    <span className="ring-popover bg-warning absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full ring-2">
      <TriangleAlert className="text-warning-foreground size-2" strokeWidth={3} />
    </span>
  );
}

/** A section label with its count, sitting above the card it describes. */
function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline gap-1.5 pl-3">
      <Eyebrow>{label}</Eyebrow>
      <span className="text-muted-foreground text-code font-mono font-medium">{count}</span>
    </div>
  );
}

/** One spend limit: token identity on the left, allowance and its rate on one line at the right. */
function SpendRow({
  spend,
  chainId,
  nativeSymbol,
  isLoading,
  expiryDate,
}: {
  spend: SpendPermission;
  chainId?: number;
  nativeSymbol: string;
  isLoading?: boolean;
  /** The horizon `spend.total` is a total up to. */
  expiryDate?: string;
}) {
  const isNative = isNativeToken(spend.tokenAddress);
  const symbol = isNative ? nativeSymbol : spend.token;
  // A token whose symbol never resolved still has to be named on both lines that
  // carry a figure, and a truncated address names it the same way in both.
  const symbolLabel = symbol || getDisplayAddress(undefined, spend.tokenAddress);
  const rate = spendRate(spend.duration);

  // A raw base-units allowance runs to tens of digits (a max-uint cap is 78), which no dialog width
  // holds. Every digit is kept — a spend cap must not be abbreviated — so instead the figure drops
  // to its own line and steps down a size (`text-heading` → `text-body-sm`). Threshold is where the
  // value stops fitting beside the token identity at the larger of those two sizes.
  //
  // The line break is `shrink-0` inside a wrapping row: rather than compress, the amount block
  // moves down, where it has the full card width for `break-all` to work with.
  const isLongAmount = isLongSpendAmount(spend.amount);

  return (
    <div className="border-border/40 flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-2 first:border-t-0">
      <span className="size-token relative inline-flex flex-none items-center justify-center">
        <TokenIcon
          chainId={chainId}
          address={spend.tokenAddress}
          symbol={symbol}
          className="size-token flex-none rounded-full"
        />
        {/* A spend token that won't answer decimals() is either not an ERC-20 or deliberately
            opaque — worth the same warning tone as an unbounded scope. */}
        {!isLoading && spend.decimalsUnknown && <WarnBadge />}
      </span>
      {isLoading ? (
        <Skeleton className="bg-muted rounded-xs h-3.5 w-16 flex-1" />
      ) : (
        <span className="flex min-w-0 flex-1 flex-col items-start">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-foreground text-value truncate font-semibold">{symbolLabel}</span>
            {!isNative && <CopyButton value={spend.tokenAddress} size={11} label="Copy token address" />}
          </span>
          {spend.decimalsUnknown && <span className="text-code text-warning mt-1 font-mono">decimals unknown</span>}
        </span>
      )}
      {isLoading ? (
        <Skeleton className="bg-muted rounded-xs h-4 w-20 flex-none" />
      ) : (
        <span
          className={`ml-auto flex max-w-full shrink-0 items-baseline gap-1 ${isLongAmount ? 'flex-wrap justify-end' : ''}`}
        >
          <span
            className={`text-foreground ${
              isLongAmount ? 'text-body-sm min-w-0 break-all font-semibold' : 'text-heading'
            }`}
          >
            {spend.amount}
          </span>
          {spend.decimalsUnknown && <span className="text-muted-foreground text-code font-mono">base units</span>}
          {rate && <span className="text-muted-foreground text-code font-mono">{rate}</span>}
          {/* A fiat figure derived from an unknown denomination would be wrong by the same factor. */}
          {spend.amountUsd && !spend.decimalsUnknown && (
            <span className="text-muted-foreground text-code ml-1 font-mono">${spend.amountUsd}</span>
          )}
        </span>
      )}
      {/* The rate is what the row led with; this is what approving it costs by the time
          the permission expires. A sibling of the amount block rather than a child of
          it, because `w-full` inside that non-wrapping row is a flex basis and shrinks
          back onto one line. Out here it gets the line it needs, which is the point:
          it is the larger number and the one a decision should rest on.

          A total scaled by unknown decimals would be wrong by the same factor the
          amount is, so it carries the same `base units` qualifier rather than a token
          symbol, and `break-all` for the tens of digits that then come with it. */}
      {!isLoading && spend.total && (
        <span className="text-muted-foreground text-code w-full break-all text-right font-mono">
          up to {spend.total} {spend.decimalsUnknown ? 'base units' : symbolLabel}
          {expiryDate ? ` by ${expiryDate}` : ''}
        </span>
      )}
    </div>
  );
}

export function SpendLimits({
  spends,
  chainId,
  nativeSymbol,
  isLoading,
  expiryDate,
}: {
  spends: SpendPermission[];
  chainId?: number;
  nativeSymbol: string;
  isLoading?: boolean;
  expiryDate?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading label="Spend limit" count={spends.length} />
      <div className="border-border rounded-box overflow-hidden border">
        {spends.map((spend, i) => (
          <SpendRow
            key={i}
            spend={spend}
            chainId={chainId}
            nativeSymbol={nativeSymbol}
            isLoading={isLoading}
            expiryDate={expiryDate}
          />
        ))}
      </div>
    </div>
  );
}

export interface CallGroup {
  target: string;
  calls: CallPermission[];
}

/** Group the flat call list by contract, preserving first-seen order. */
export function groupCallsByTarget(calls: CallPermission[]): CallGroup[] {
  const groups = new Map<string, CallGroup>();
  for (const call of calls) {
    const key = call.target?.toLowerCase() ?? '';
    const existing = groups.get(key);
    if (existing) existing.calls.push(call);
    else groups.set(key, { target: call.target, calls: [call] });
  }
  return [...groups.values()];
}

/**
 * One contract the spender may call, with its functions behind a nested disclosure. The contract
 * identity — ENS name and avatar where resolved — sits on the collapsed row, because that is what
 * decides whether the grant is safe.
 */
function ContractGroup({
  group,
  resolvedName,
  avatarUrl,
  truncatedAddress,
  tokenSymbol,
  chainId,
}: {
  group: CallGroup;
  resolvedName?: string;
  avatarUrl?: string;
  truncatedAddress: string;
  /** Set when the target is a known token — it then reads like the spend rows. */
  tokenSymbol?: string;
  chainId?: number;
}) {
  const anyTarget = isWildcard(group.target);
  const anyFunction = group.calls.some((c) => isWildcard(c.selector));
  const fnMeta = anyFunction
    ? 'Any function'
    : `${group.calls.length} ${group.calls.length === 1 ? 'function' : 'functions'}`;

  return (
    <AccordionItem value={group.target} className="border-border/40 border-t first:border-t-0">
      <AccordionTrigger className="items-center px-3 py-2 hover:no-underline">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="size-token relative inline-flex flex-none items-center justify-center">
            {tokenSymbol ? (
              <TokenIcon
                chainId={chainId}
                address={group.target}
                symbol={tokenSymbol}
                className="size-token flex-none rounded-full"
                fallback={
                  <AccountAvatar
                    seed={group.target}
                    avatarUrl={avatarUrl}
                    size={24}
                    className="rounded-chip size-token flex-none"
                  />
                }
              />
            ) : (
              <AccountAvatar
                seed={group.target}
                avatarUrl={avatarUrl}
                size={24}
                className="rounded-chip size-token flex-none"
              />
            )}
            {(anyTarget || anyFunction) && <WarnBadge />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col items-start">
            {anyTarget ? (
              <span className="text-body-sm text-warning truncate font-semibold">Any contract</span>
            ) : tokenSymbol || resolvedName ? (
              <>
                <span className="text-foreground text-body-sm truncate font-medium">{tokenSymbol ?? resolvedName}</span>
                <span className="text-muted-foreground text-code mt-1 font-mono">{truncatedAddress}</span>
              </>
            ) : (
              <span className="text-foreground text-body-xs truncate font-mono font-medium">{truncatedAddress}</span>
            )}
          </span>
          <span className={`text-code flex-none font-mono ${anyFunction ? 'text-warning' : 'text-muted-foreground'}`}>
            {fnMeta}
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-3">
        <div className="flex flex-col gap-1.5">
          {!anyTarget && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-code min-w-0 break-all font-mono">{group.target}</span>
              <CopyButton value={group.target} size={11} label="Copy contract address" />
            </div>
          )}
          <ul className="bg-secondary rounded-chip flex flex-col gap-1 p-2">
            {group.calls.map((call, i) =>
              isWildcard(call.selector) ? (
                <li key={i} className="text-body-sm text-warning flex items-center gap-1.5 font-semibold">
                  <TriangleAlert className="size-3 flex-none" strokeWidth={2.4} />
                  Any function
                </li>
              ) : (
                <li key={i} className="text-foreground text-body-sm flex gap-1.5 font-mono">
                  <span aria-hidden className="text-muted-foreground flex-none">
                    •
                  </span>
                  <span className="min-w-0 break-all">{call.functionSignature || call.selector}</span>
                </li>
              )
            )}
          </ul>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

/**
 * "Allowed calls" as a card that is itself a disclosure, with one nested disclosure per contract —
 * so a grant touching several contracts collapses to a single line until the user asks for more.
 */
export function AllowedCalls({
  calls,
  resolvedAddresses,
  resolvedAvatars,
  truncateAddress,
  tokenMeta,
  chainId,
}: {
  calls: CallPermission[];
  resolvedAddresses: Record<string, string>;
  resolvedAvatars: Record<string, string>;
  truncateAddress: (address: string) => string;
  tokenMeta?: Record<string, { symbol: string }>;
  chainId?: number;
}) {
  const groups = groupCallsByTarget(calls);

  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="calls" className="border-border rounded-box overflow-hidden border">
        <AccordionTrigger className="items-center px-3 py-2 hover:no-underline">
          <span className="flex flex-1 items-baseline gap-1.5">
            <Eyebrow>Allowed calls</Eyebrow>
            <span className="text-muted-foreground text-code font-mono font-medium">{calls.length}</span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="border-border/40 border-t p-0">
          <Accordion type="multiple">
            {groups.map((group) => (
              <ContractGroup
                key={group.target}
                group={group}
                resolvedName={resolvedAddresses[group.target]}
                avatarUrl={resolvedAvatars[group.target]}
                truncatedAddress={truncateAddress(group.target)}
                tokenSymbol={tokenMeta?.[group.target]?.symbol}
                chainId={chainId}
              />
            ))}
          </Accordion>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/** The From / Granted / Until / permissionId block — label left, value right, one row each. */
export function MetaCard({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="border-border rounded-box overflow-hidden border">
      {rows.map((row) => (
        <div
          key={row.label}
          className="border-border/40 flex h-7 items-center justify-between gap-2 border-t px-3 first:border-t-0"
        >
          <Eyebrow>{row.label}</Eyebrow>
          <span className="text-foreground text-body-xs flex min-w-0 items-center gap-1.5 font-mono">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
