'use client';

import type { ReactNode } from 'react';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { SUPPORTED_CHAINS, type AdminBatchChain, type RecoveryMethodInput } from '@jaw.id/core';
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
  recoveryMethodLabel,
  recoveryRelayState,
  type RecoveryChangeSummary,
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
}: {
  commitment: Hex;
  chainId?: number;
  mainnetRpcUrl: string;
}) {
  const address = recoveryMethodAddress(commitment);
  const identity = useReverseIdentity(address ?? undefined, chainId, mainnetRpcUrl);
  const truncated = getDisplayAddress(undefined, address ?? commitment);

  return (
    <>
      <AccountAvatar
        seed={address ?? commitment}
        avatarUrl={identity.avatar}
        size={24}
        className="rounded-chip size-token flex-none"
      />
      <span className="flex min-w-0 flex-1 flex-col items-start">
        {identity.name ? (
          <>
            <span className="text-foreground text-body-sm max-w-full truncate font-medium">{identity.name}</span>
            <span className="text-muted-foreground text-code mt-1 font-mono">{truncated}</span>
          </>
        ) : (
          <span className="text-foreground text-body-xs truncate font-mono font-medium">{truncated}</span>
        )}
      </span>
    </>
  );
}

/** A guardian's wait, in the chip every row and change line uses. */
function WaitChip({ children }: { children: ReactNode }) {
  return (
    <span className="border-border text-foreground text-code rounded-pill flex-none border px-2 py-0.5 font-mono font-semibold">
      {children}
    </span>
  );
}

/** A label/value line inside a card. */
export function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-border/40 flex min-h-11 items-center justify-between gap-3 border-t px-3 py-2 first:border-t-0">
      <Eyebrow>{label}</Eyebrow>
      <span className="text-foreground text-body-sm min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  );
}

/**
 * The guardians of a config and the approvals it needs, read-only: the app decides them, the user
 * approves or declines, as on the permission screen.
 */
export function GuardianList({
  label,
  methods,
  threshold,
  chainId,
  mainnetRpcUrl,
}: {
  label: string;
  methods: Required<RecoveryMethodInput>[];
  threshold: number;
  chainId?: number;
  mainnetRpcUrl: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading label={label} />
      <div className="border-border rounded-box overflow-hidden border">
        {methods.map((method) => (
          <div
            key={`${method.provider}:${method.commitment}`}
            className="border-border/40 flex items-center gap-2 border-t px-3 py-2 first:border-t-0"
          >
            <GuardianIdentity commitment={method.commitment} chainId={chainId} mainnetRpcUrl={mainnetRpcUrl} />
            <span className="border-border bg-secondary text-muted-foreground text-code rounded-pill flex-none border px-2 py-0.5 font-mono font-semibold">
              {recoveryMethodLabel(method.provider, method.commitment)}
            </span>
            <WaitChip>{formatRecoveryDelay(method.delay)}</WaitChip>
          </div>
        ))}
        <SummaryRow label="Approvals needed">{`${threshold} of ${methods.length}`}</SummaryRow>
      </div>
    </div>
  );
}

/**
 * How long the owner has to veto, and where the change lands, with the advice the time to cancel
 * calls for (O8). Advice only: the app picked the waits.
 */
export function RecoverySummary({
  minimumDelay,
  networkLabel,
  networks,
}: {
  /** The threshold-th smallest wait (core `minimumRecoveryDelay`). */
  minimumDelay: number | null;
  networkLabel: string;
  networks: string;
}) {
  const warning = recoveryDelayWarning(minimumDelay);

  return (
    <div className="flex flex-col gap-3">
      <div className="border-border rounded-box overflow-hidden border">
        <SummaryRow label="Time to cancel">
          {minimumDelay === null ? 'None' : `at least ${formatRecoveryDelay(minimumDelay)}`}
        </SummaryRow>
        <SummaryRow label={networkLabel}>{networks}</SummaryRow>
      </div>
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

/** What an edit changes, as the user thinks of it, one line per change. */
export function ChangeList({
  changes,
  chainId,
  mainnetRpcUrl,
}: {
  changes: RecoveryChangeSummary[];
  chainId?: number;
  mainnetRpcUrl: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading label="Changes" />
      <div className="border-border rounded-box overflow-hidden border">
        {changes.map((change, i) => (
          <div key={i} className="border-border/40 flex items-center gap-2 border-t px-3 py-2 first:border-t-0">
            {change.kind === 'threshold' ? (
              <span className="text-foreground text-body-sm flex-1 font-medium">
                Approvals needed {change.from} → {change.to}
              </span>
            ) : (
              <>
                <span
                  className={cn(
                    'text-body-sm w-4 flex-none text-center font-mono font-bold',
                    change.kind === 'add' && 'text-success',
                    change.kind === 'remove' && 'text-destructive',
                    change.kind === 'delay' && 'text-muted-foreground'
                  )}
                  aria-label={change.kind === 'add' ? 'Added' : change.kind === 'remove' ? 'Removed' : 'Changed'}
                >
                  {change.kind === 'add' ? '+' : change.kind === 'remove' ? '−' : '~'}
                </span>
                <GuardianIdentity
                  commitment={change.method.commitment}
                  chainId={chainId}
                  mainnetRpcUrl={mainnetRpcUrl}
                />
                <WaitChip>
                  {change.kind === 'delay'
                    ? `${formatRecoveryDelay(change.from)} → ${formatRecoveryDelay(change.method.delay)}`
                    : formatRecoveryDelay(change.method.delay)}
                </WaitChip>
              </>
            )}
          </div>
        ))}
      </div>
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
