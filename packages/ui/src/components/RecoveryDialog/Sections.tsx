'use client';

import type { ReactNode } from 'react';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { SUPPORTED_CHAINS, type AdminBatchChain } from '@jaw.id/core';
import type { Hex } from 'viem';
import { Spinner } from '../ui/spinner';
import { AccountAvatar } from '../AccountAvatar';
import { SuccessCheck } from '../SuccessCheck';
import { Eyebrow } from '../primitives';
import { cn } from '../../lib/utils';
import { getDisplayAddress } from '../../utils';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import {
  RECOVERY_DELAY_WARNING_TEXT,
  RECOVERY_RELAY_STATE_TEXT,
  formatRecoveryDelay,
  recoveryDelayWarning,
  recoveryMethodAddress,
  recoveryRelayState,
  type RecoveryGuardianRow,
} from '../../utils/recoverySetup';

/** The network's name, for a chain id the configs read or the relayer reports. */
export function chainName(chainId: number): string {
  return SUPPORTED_CHAINS.find((chain) => chain.id === chainId)?.name ?? `Chain ${chainId}`;
}

function explorerTxUrl(chainId: number, txHash: Hex): string | null {
  const explorer = SUPPORTED_CHAINS.find((chain) => chain.id === chainId)?.blockExplorers?.default?.url;
  return explorer ? `${explorer}/tx/${txHash}` : null;
}

/** A section label, sitting above the card it describes. */
function SectionHeading({ label }: { label: string }) {
  return (
    <div className="pl-3">
      <Eyebrow>{label}</Eyebrow>
    </div>
  );
}

/** A warning in the dialog's two tones: amber advises, red is the one to stop at. */
export function RecoveryNotice({
  tone,
  title,
  children,
}: {
  tone: 'warning' | 'destructive';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-box flex items-start gap-2 p-3',
        tone === 'destructive' ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning'
      )}
    >
      <TriangleAlert className="mt-px size-3.5 flex-none" strokeWidth={2} />
      <p className="text-body-sm">
        <span className="block font-semibold">{title}</span>
        {children}
      </p>
    </div>
  );
}

/**
 * Who a guardian is: the address's reverse-resolved name, else the short address, the short
 * address always underneath. A passkey has no address, so its truncated public key identifies it.
 */
function GuardianIdentity({
  commitment,
  chainId,
  mainnetRpcUrl,
  struck,
}: {
  commitment: Hex;
  chainId?: number;
  mainnetRpcUrl: string;
  /** A guardian the change removes: dimmed and struck through. */
  struck?: boolean;
}) {
  const address = recoveryMethodAddress(commitment);
  const identity = useReverseIdentity(address ?? undefined, chainId, mainnetRpcUrl);
  const truncated = getDisplayAddress(undefined, address ?? commitment);

  return (
    <>
      <span className={cn('flex-none', struck && 'opacity-40 grayscale')}>
        <AccountAvatar
          seed={address ?? commitment}
          avatarUrl={identity.avatar}
          size={24}
          className="rounded-chip size-token flex-none"
        />
      </span>
      <span className={cn('flex min-w-0 flex-1 flex-col items-start', struck && 'text-muted-foreground line-through')}>
        {identity.name ? (
          <>
            <span className={cn('text-body-sm max-w-full truncate font-medium', !struck && 'text-foreground')}>
              {identity.name}
            </span>
            <span className="text-muted-foreground text-code mt-1 font-mono">{truncated}</span>
          </>
        ) : (
          <span className={cn('text-body-xs truncate font-mono font-medium', !struck && 'text-foreground')}>
            {truncated}
          </span>
        )}
      </span>
    </>
  );
}

/** A small status pill: green for what is added, red for what goes, amber for what changes. */
function Badge({ tone, children }: { tone: 'success' | 'destructive' | 'warning'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'text-code rounded-pill flex-none px-2 py-0.5 font-mono font-semibold',
        tone === 'success' && 'bg-success/10 text-success',
        tone === 'destructive' && 'bg-destructive/10 text-destructive',
        tone === 'warning' && 'bg-warning/10 text-warning'
      )}
    >
      {children}
    </span>
  );
}

type Approvals = { threshold: number; count: number };

/**
 * The guardians as one read-only list, as the permission screen shows a grant: the end state the
 * app asked for with what is new marked, then what the change removes, struck through. The
 * approvals sit at the bottom as before and after, the new value highlighted.
 */
export function GuardianList({
  rows,
  approvals,
  chainId,
  mainnetRpcUrl,
}: {
  rows: RecoveryGuardianRow[];
  /** `from` only when the approvals change. */
  approvals: { from?: Approvals; to: Approvals };
  chainId?: number;
  mainnetRpcUrl: string;
}) {
  const ratio = ({ threshold, count }: Approvals) => `${threshold}/${count}`;
  const changed = !!approvals.from && ratio(approvals.from) !== ratio(approvals.to);

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading label="Guardians" />
      <div className="border-border rounded-box overflow-hidden border">
        {rows.map(({ method, change, fromDelay }) => (
          <div
            key={`${method.provider}:${method.commitment}`}
            className="border-border/40 flex items-center gap-2 border-t px-3 py-2 first:border-t-0"
          >
            <GuardianIdentity
              commitment={method.commitment}
              chainId={chainId}
              mainnetRpcUrl={mainnetRpcUrl}
              struck={change === 'removed'}
            />
            {change === 'added' && <Badge tone="success">Added</Badge>}
            {change === 'removed' && <Badge tone="destructive">Removed</Badge>}
            {change === 'delay' && fromDelay !== undefined && (
              <Badge tone="warning">{`${formatRecoveryDelay(fromDelay)} → ${formatRecoveryDelay(method.delay)}`}</Badge>
            )}
          </div>
        ))}
        <div className="border-border/40 flex min-h-11 items-center justify-between gap-3 border-t px-3 py-2">
          <span className="text-muted-foreground text-body-sm">Approvals needed</span>
          <span className="text-body-sm flex items-center gap-1.5 font-mono font-semibold">
            {changed && approvals.from ? (
              <>
                <span className="text-muted-foreground font-normal">{ratio(approvals.from)}</span>
                <span className="text-muted-foreground">→</span>
                <Badge tone="warning">{ratio(approvals.to)}</Badge>
              </>
            ) : (
              <span className="text-foreground">{ratio(approvals.to)}</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One line under the list: how long the owner has to cancel a recovery (the threshold-th
 * smallest wait, core `minimumRecoveryDelay`), where the change lands, and who pays for an edit.
 * The time to cancel only advises (O8): amber under 24h, red at 0.
 */
export function RecoveryTerms({
  minimumDelay,
  networks,
  feesPaidByJaw,
}: {
  minimumDelay: number | null;
  networks: string;
  /** An edit is relayed, and JAW pays its network fees. */
  feesPaidByJaw?: boolean;
}) {
  const warning = recoveryDelayWarning(minimumDelay);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-body-sm">
        {minimumDelay === 0 ? (
          'A recovery takes effect instantly, with no time to cancel it. '
        ) : minimumDelay !== null ? (
          <>
            A recovery takes effect after at least{' '}
            <span className="text-foreground font-semibold">{formatRecoveryDelay(minimumDelay)}</span>, you can cancel
            it before then.{' '}
          </>
        ) : null}
        {feesPaidByJaw ? `${networks}, fees paid by JAW.` : `${networks}.`}
      </p>
      {warning && (
        <RecoveryNotice
          tone={warning === 'short' ? 'warning' : 'destructive'}
          title={RECOVERY_DELAY_WARNING_TEXT[warning].text}
        >
          {RECOVERY_DELAY_WARNING_TEXT[warning].detail}
        </RecoveryNotice>
      )}
    </div>
  );
}

/** The outcome per network: landed, still on its way, or failed. */
export function NetworkStatusList({ chains }: { chains: AdminBatchChain[] }) {
  return (
    <div className="border-border rounded-box overflow-hidden border">
      {chains.map((chain) => {
        const state = recoveryRelayState(chain.status);
        const txUrl = chain.txHash ? explorerTxUrl(chain.chainId, chain.txHash) : null;
        return (
          <div
            key={chain.chainId}
            className="border-border/40 flex min-h-11 items-center justify-between gap-3 border-t px-3 py-2 first:border-t-0"
          >
            <span className="text-foreground text-body-sm font-medium">{chainName(chain.chainId)}</span>
            <span
              className={cn(
                'text-body-sm flex items-center gap-1.5 font-medium',
                state === 'failed'
                  ? 'text-destructive'
                  : state === 'updating'
                    ? 'text-muted-foreground'
                    : 'text-success'
              )}
            >
              {state === 'updating' ? (
                <Spinner className="size-3.5" />
              ) : state !== 'failed' ? (
                <SuccessCheck size={16} />
              ) : null}
              {RECOVERY_RELAY_STATE_TEXT[state]}
              {txUrl && (
                <a
                  href={txUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View transaction"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
