'use client';

import { Info, ShieldCheck, TriangleAlert } from 'lucide-react';
import { zeroAddress } from 'viem';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { AccountAvatar } from '../AccountAvatar';
import { TokenIcon } from '../TokenIcon';
import { Skeleton } from '../ui/skeleton';
import { CopyButton } from '../CopyButton';
import { Eyebrow } from '../primitives';
import { isNativeToken } from '../../utils/tokenBalance';
import { isWildcard } from '../../utils/permissionExecution';
import { getDisplayAddress } from '../../utils';
import type { AddressIdentity } from '../../hooks/useAddressIdentities';
import { isLongSpendAmount } from '../../utils/displayFormat';
import type { CallPermission, SpendPermission, SpenderPrefundDisplay } from './types';

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
function SectionHeading({ label, count, info }: { label: string; count: number; info?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 pl-3">
      <Eyebrow>{label}</Eyebrow>
      <span className="text-muted-foreground text-code font-mono font-medium">{count}</span>
      {info && (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="text-muted-foreground size-3 cursor-help self-center" aria-label={info} />
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{info}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

/** One spend limit: token identity on the left, allowance and its rate on one line at the right. */
function SpendRow({
  spend,
  chainId,
  nativeSymbol,
  isLoading,
}: {
  spend: SpendPermission;
  chainId?: number;
  nativeSymbol: string;
  isLoading?: boolean;
}) {
  const isNative = isNativeToken(spend.tokenAddress);
  const symbol = isNative ? nativeSymbol : spend.token;
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
            <span className="text-foreground text-value truncate font-semibold">
              {symbol || getDisplayAddress(undefined, spend.tokenAddress)}
            </span>
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
    </div>
  );
}

/**
 * The transfer a grant sends to the spender on top of the permission. Its own section rather
 * than a spend row: a limit is something the spender may do later, this leaves the account the
 * moment the grant lands, and revoking the permission does not bring it back.
 */
export function SpenderPrefundNotice({
  prefund,
  isLoading,
}: {
  prefund?: SpenderPrefundDisplay | null;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <div className="pl-3">
          <Eyebrow>Sent now</Eyebrow>
        </div>
        <div className="border-warning/40 bg-warning/10 rounded-box border px-3 py-2">
          <Skeleton className="bg-muted rounded-xs h-3.5 w-32" />
        </div>
      </div>
    );
  }
  if (!prefund) return null;

  if (prefund.kind === 'below-one-operation') {
    return (
      <p className="text-muted-foreground text-body-sm">
        The spender won&apos;t be funded: this limit is below one transaction&apos;s fee ({prefund.operationCost}{' '}
        {prefund.symbol}).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="pl-3">
        <Eyebrow>Sent now</Eyebrow>
      </div>
      <div className="border-warning/40 bg-warning/10 rounded-box flex flex-col gap-1 border px-3 py-2">
        <span className="text-warning text-value flex items-center gap-1.5 break-all font-semibold">
          <TriangleAlert className="size-3.5 flex-none" strokeWidth={2} />
          {prefund.amount} {prefund.symbol}
        </span>
        <span className="text-muted-foreground text-body-sm">
          So the spender can pay fees for its first transactions. It leaves your account immediately, and revoking the
          permission doesn&apos;t return it.
        </span>
      </div>
    </div>
  );
}

export function SpendLimits({
  spends,
  chainId,
  nativeSymbol,
  isLoading,
}: {
  spends: SpendPermission[];
  chainId?: number;
  nativeSymbol: string;
  isLoading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading label="Spend limit" count={spends.length} />
      <div className="border-border rounded-box overflow-hidden border">
        {spends.map((spend, i) => (
          <SpendRow key={i} spend={spend} chainId={chainId} nativeSymbol={nativeSymbol} isLoading={isLoading} />
        ))}
      </div>
    </div>
  );
}

export interface CallGroup {
  target: string;
  calls: CallPermission[];
}

/** A call the permission manager also runs past a checker contract before executing it. */
export function hasChecker(call: CallPermission): call is CallPermission & { checker: string } {
  return !!call.checker && call.checker.toLowerCase() !== zeroAddress;
}

interface CheckerGroup {
  checker: string;
  calls: CallPermission[];
}

/** Each distinct checker with the calls it checks, in first-seen order. */
function groupCallsByChecker(calls: CallPermission[]): CheckerGroup[] {
  const groups = new Map<string, CheckerGroup>();
  for (const call of calls.filter(hasChecker)) {
    const key = call.checker.toLowerCase();
    const existing = groups.get(key);
    if (existing) existing.calls.push(call);
    else groups.set(key, { checker: call.checker, calls: [call] });
  }
  return [...groups.values()];
}

const functionLabel = (call: CallPermission) =>
  isWildcard(call.selector) ? 'any function' : call.functionSignature || call.selector || 'Unknown Function';

/**
 * One checker: a name it is known by when there is one, its address, and the functions it checks.
 * The SDK can't say what a given checker enforces, so it never shows a description the checker
 * gives of itself.
 */
function CheckerRow({
  group,
  name,
  truncateAddress,
}: {
  group: CheckerGroup;
  name?: string | null;
  truncateAddress: (address: string) => string;
}) {
  const functions = [...new Set(group.calls.map(functionLabel))];
  return (
    <div className="border-border/40 flex items-start gap-2 border-t p-3 first:border-t-0">
      <ShieldCheck className="text-muted-foreground mt-0.5 size-4 flex-none" strokeWidth={2} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {name && <span className="text-foreground text-body-sm truncate font-medium">{name}</span>}
        <span className="flex items-center gap-1.5">
          <span
            className={
              name ? 'text-muted-foreground text-code font-mono' : 'text-foreground text-body-xs font-mono font-medium'
            }
          >
            {truncateAddress(group.checker)}
          </span>
          <CopyButton value={group.checker} size={11} label="Copy checker address" />
        </span>
        <span className="text-muted-foreground text-body-xs min-w-0 break-all">
          Checks <span className="font-mono">{functions.join(', ')}</span>
        </span>
      </div>
    </div>
  );
}

/**
 * The contracts the permission manager asks to approve calls before they run. Their own section,
 * so the user sees each one without opening the allowed calls card.
 */
export function CallChecks({
  calls,
  identityOf,
  truncateAddress,
}: {
  calls: CallPermission[];
  identityOf: (address: string) => AddressIdentity | undefined;
  truncateAddress: (address: string) => string;
}) {
  const groups = groupCallsByChecker(calls);
  if (groups.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading
        label="Call checks"
        count={groups.length}
        info="Before each call this permission allows, these contracts check it and can block it. They can't allow anything extra."
      />
      <div className="border-border rounded-box overflow-hidden border">
        {groups.map((group) => {
          const identity = identityOf(group.checker);
          return (
            <CheckerRow
              key={group.checker}
              group={group}
              name={identity?.clearSigningName ?? identity?.ensName}
              truncateAddress={truncateAddress}
            />
          );
        })}
      </div>
    </div>
  );
}

/** One allowed function. */
export function CallRow({ call }: { call: CallPermission }) {
  return isWildcard(call.selector) ? (
    <li className="text-body-sm text-warning flex items-center gap-1.5 font-semibold">
      <TriangleAlert className="size-3 flex-none" strokeWidth={2.4} />
      Any function
    </li>
  ) : (
    <li className="text-foreground text-body-sm flex gap-1.5 font-mono">
      <span aria-hidden className="text-muted-foreground flex-none">
        •
      </span>
      <span className="min-w-0 break-all">{call.functionSignature || call.selector}</span>
    </li>
  );
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
  truncateAddress,
  tokenSymbol,
  chainId,
}: {
  group: CallGroup;
  resolvedName?: string;
  avatarUrl?: string;
  truncateAddress: (address: string) => string;
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
                <span className="text-muted-foreground text-code mt-1 font-mono">{truncateAddress(group.target)}</span>
              </>
            ) : (
              <span className="text-foreground text-body-xs truncate font-mono font-medium">
                {truncateAddress(group.target)}
              </span>
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
            {group.calls.map((call, i) => (
              <CallRow key={i} call={call} />
            ))}
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
  identityOf,
  truncateAddress,
  tokenMeta,
  chainId,
}: {
  calls: CallPermission[];
  identityOf: (address: string) => AddressIdentity | undefined;
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
                resolvedName={identityOf(group.target)?.ensName ?? undefined}
                avatarUrl={identityOf(group.target)?.ensAvatar ?? undefined}
                truncateAddress={truncateAddress}
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
