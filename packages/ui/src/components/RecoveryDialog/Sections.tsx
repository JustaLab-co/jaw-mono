'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, TriangleAlert } from 'lucide-react';
import { SUPPORTED_CHAINS, type AdminBatchChain, type RecoveryNetwork } from '@jaw.id/core';
import type { Hex } from 'viem';
import { Spinner } from '../ui/spinner';
import { AccountAvatar } from '../AccountAvatar';
import { SuccessCheck } from '../SuccessCheck';
import { Eyebrow } from '../primitives';
import { ChainIcon } from '../AddFundsDialog/ChainIcon';
import { cn } from '../../lib/utils';
import { getDisplayAddress } from '../../utils';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import { useChainIcons } from '../../hooks/useChainIcons';
import {
  RECOVERY_DELAY_WARNING_TEXT,
  RECOVERY_RELAY_STATE_TEXT,
  formatRecoveryDelay,
  recoveryDelayWarning,
  recoveryMethodAddress,
  recoveryNetworkNote,
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
 * smallest wait, core `minimumRecoveryDelay`). The time to cancel only advises (O8): amber under
 * 24h, red at 0.
 */
export function RecoveryTerms({ minimumDelay }: { minimumDelay: number | null }) {
  const warning = recoveryDelayWarning(minimumDelay);
  if (minimumDelay === null) return null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-body-sm">
        {minimumDelay === 0 ? (
          'A recovery takes effect instantly, with no time to cancel it.'
        ) : (
          <>
            A recovery takes effect after at least{' '}
            <span className="text-foreground font-semibold">{formatRecoveryDelay(minimumDelay)}</span>, you can cancel
            it before then.
          </>
        )}
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

/**
 * A group of more networks than this folds into one row: their icons stacked and the count, open
 * on tap. So the card stays two rows and the fee row however many networks an account uses.
 */
const GROUP_ROWS = 2;

/** Icons drawn in a folded row before the rest become "+N", and their overlap, as in Add Funds. */
const STACK_SHOWN = 5;
const STACK_ICON = 20;
const STACK_STEP = 14;

/**
 * One chain's icon on a white plate, as Add Funds draws them: brand marks with transparent grounds
 * read as holes on the dark dialog without it.
 */
function NetworkIcon({
  icon,
  stacked,
  index = 0,
  count = 1,
}: {
  icon?: string;
  stacked?: boolean;
  index?: number;
  count?: number;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex flex-none overflow-hidden rounded-full bg-white',
        stacked && 'ring-popover ring-2'
      )}
      style={stacked ? { marginLeft: index === 0 ? 0 : -(STACK_ICON - STACK_STEP), zIndex: count - index } : undefined}
    >
      <ChainIcon icon={icon} size={STACK_ICON} />
    </span>
  );
}

/** A folded group's icons, overlapping, the rest counted. Decorative: the row names the count. */
function NetworkStack({ chainIds, icons }: { chainIds: number[]; icons: Readonly<Record<number, string>> }) {
  const shown = chainIds.slice(0, STACK_SHOWN);
  const overflow = chainIds.length - shown.length;
  return (
    <span aria-hidden className="flex flex-none items-center">
      {shown.map((chainId, index) => (
        <NetworkIcon key={chainId} icon={icons[chainId]} stacked index={index} count={shown.length} />
      ))}
      {overflow > 0 && (
        <span
          className="ring-popover bg-secondary text-muted-foreground text-label relative inline-flex h-5 items-center justify-center rounded-full px-1.5 font-mono ring-2"
          style={{ marginLeft: -(STACK_ICON - STACK_STEP) }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

const ROW = 'border-border/40 flex min-h-11 items-center gap-2 border-t px-3 py-2 first:border-t-0';

/**
 * The networks that share one outcome. Up to two are a row each; more fold into one row, a
 * button that opens the list underneath, each network with its reason.
 */
function NetworkGroup({
  rows,
  status,
  icons,
}: {
  rows: Array<{ network: RecoveryNetwork; note?: string }>;
  status: ReactNode;
  icons: Readonly<Record<number, string>>;
}) {
  const [open, setOpen] = useState(false);

  const name = (network: RecoveryNetwork, note?: string) => (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-foreground text-body-sm font-medium">{chainName(network.chainId)}</span>
      {note && <span className="text-muted-foreground text-body-xs">{note}</span>}
    </span>
  );

  if (rows.length <= GROUP_ROWS) {
    return (
      <>
        {rows.map(({ network, note }) => (
          <div key={network.chainId} className={ROW}>
            <NetworkIcon icon={icons[network.chainId]} />
            {name(network, note)}
            {status}
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          ROW,
          'hover:bg-secondary/40 focus-visible:ring-ring w-full cursor-pointer text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset motion-reduce:transition-none'
        )}
      >
        <NetworkStack chainIds={rows.map(({ network }) => network.chainId)} icons={icons} />
        <span className="text-foreground text-body-sm min-w-0 flex-1 font-medium">{rows.length} networks</span>
        {status}
        <ChevronDown
          aria-hidden
          strokeWidth={2.2}
          className={cn(
            'text-muted-foreground size-3.5 flex-none transition-transform motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>
      {open &&
        rows.map(({ network, note }) => (
          <div key={network.chainId} className={cn(ROW, 'bg-secondary/30 pl-6')}>
            <NetworkIcon icon={icons[network.chainId]} />
            {name(network, note)}
          </div>
        ))}
    </>
  );
}

/**
 * Every network the account is on and what the change does there, shown before the user
 * confirms: the ones it reaches (the connected one first), then the ones it leaves out, each with
 * the reason. Networks the account was never used on are not rows; a line under the card says
 * they aren't covered yet. Each outcome takes one row however many networks share it, so the card
 * keeps its size at two networks or forty, and a network left out is never folded out of view.
 */
export function RecoveryNetworks({
  networks,
  connectedChainId,
  apiKey,
}: {
  networks: RecoveryNetwork[];
  /** Listed first among the reached networks. */
  connectedChainId?: number;
  apiKey?: string;
}) {
  const icons = useChainIcons(apiKey);

  const included = networks
    .filter((network) => network.status === 'ready')
    .sort((a, b) => Number(b.chainId === connectedChainId) - Number(a.chainId === connectedChainId))
    .map((network) => ({ network }));
  const excluded = networks.flatMap((network) => {
    const note = recoveryNetworkNote(network);
    return note ? [{ network, note }] : [];
  });
  const unused = networks.some((network) => network.status === 'not-deployed');
  if (included.length + excluded.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading label="Networks" />
      <div className="border-border rounded-box overflow-hidden border">
        {included.length > 0 && (
          <NetworkGroup
            rows={included}
            icons={icons}
            status={<span className="text-foreground text-body-sm flex-none">Included</span>}
          />
        )}
        {excluded.length > 0 && (
          <NetworkGroup rows={excluded} icons={icons} status={<Badge tone="warning">Not included</Badge>} />
        )}
        <div className="border-border/40 flex min-h-11 items-center justify-between gap-3 border-t px-3 py-2">
          <span className="text-muted-foreground text-body-sm">Network fees</span>
          <span className="text-success bg-success/10 rounded-xs text-body-xs px-2 py-0.5 font-semibold">
            Paid by JAW
          </span>
        </div>
      </div>
      {unused && (
        <p className="text-muted-foreground text-body-sm">
          Networks you haven’t used this account on aren’t covered yet.
        </p>
      )}
    </div>
  );
}

/** The outcome per network: landed, still on its way, or failed. */
export function NetworkStatusList({ chains, apiKey }: { chains: AdminBatchChain[]; apiKey?: string }) {
  const icons = useChainIcons(apiKey);

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
            <span className="flex min-w-0 items-center gap-2">
              <NetworkIcon icon={icons[chain.chainId]} />
              <span className="text-foreground text-body-sm font-medium">{chainName(chain.chainId)}</span>
            </span>
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
