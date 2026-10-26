import { useEffect, useState, type ReactNode } from 'react';
import { ethAddress, formatUnits, zeroAddress } from 'viem';
import { ArrowDownLeft, ArrowUpRight, ChevronDown } from 'lucide-react';
import { AssetDelta, formatAssetAmount } from '../../utils/assetPreview';
import { BRIDGE_CHAINS } from '../../utils/bridgeCalls/contracts';
import { PROVIDER_NAME, type BridgeTransfer } from '../../utils/bridgeCalls/transfer';
import type { Received, Token, TokenAmount } from '../../utils/bridgeCalls/view';
import { useChainIcons } from '../../hooks/useChainIcons';
import { ChainIcon } from '../AddFundsDialog/ChainIcon';
import { WarningNotice } from '../primitives';
import { fetchTokenPrice } from '../../utils/tokenPrice';
import { formatAddress } from '../../utils/formatAddress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { TokenIcon } from '../TokenIcon';
import { CopyButton } from '../CopyButton';
import { SubText } from '../SubText';

interface AssetPreviewProps {
  assetsOut: AssetDelta[];
  assetsIn: AssetDelta[];
  error: boolean;
  nativeSymbol: string;
  /** Enables token icon lookups; rows fall back to the generic icon when absent. */
  chainId?: number;
  /**
   * These balances belong to an account other than the signer — a permissioned execution, where
   * the calls run as the granter. The columns must not say "you".
   */
  onBehalf?: boolean;
  /** Source of "You get": the simulation cannot see the other chain. */
  bridge?: BridgeTransfer;
  apiKey?: string;
}

type ChainBadge = { name: string; icon?: string };

/** Rows shown before the "+N" overflow toggle kicks in. */
const COLLAPSED_ROWS = 2;

function symbolFor(delta: AssetDelta, nativeSymbol: string): string {
  return delta.isNative ? nativeSymbol : (delta.symbol ?? '');
}

function formatUsd(value: number): string {
  if (value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function TokenWithChain({
  chainId,
  address,
  symbol,
  chain,
}: {
  chainId?: number;
  address: string;
  symbol: string;
  chain?: ChainBadge;
}) {
  return (
    <span className="size-token relative flex-none">
      <TokenIcon chainId={chainId} address={address} symbol={symbol} className="size-token" />
      {chain && (
        <span className="bg-popover absolute -bottom-0.5 -right-0.5 rounded-full p-px" title={`On ${chain.name}`}>
          <ChainIcon icon={chain.icon} size={10} />
          <span className="sr-only">on {chain.name}</span>
        </span>
      )}
    </span>
  );
}

function TokenAddress({ address }: { address: string }) {
  return (
    <span className="text-muted-foreground text-body-xs flex min-w-0 flex-row items-center gap-1 font-mono">
      <span className="truncate">{formatAddress(address)}</span>
      <CopyButton value={address} size={10} label="Copy token address" />
    </span>
  );
}

function AssetRow({
  delta,
  nativeSymbol,
  chainId,
  price,
  chain,
  prefix,
}: {
  delta: AssetDelta;
  nativeSymbol: string;
  chainId?: number;
  price?: number;
  chain?: ChainBadge;
  /** Replaces the sign, for a figure that is a bound rather than an exact amount. */
  prefix?: string;
}) {
  const out = delta.direction === 'out';
  const sign = prefix ?? (out ? '−' : '+');
  const colorClass = out ? 'text-negative' : 'text-positive';
  const symbol = symbolFor(delta, nativeSymbol);
  const rounded = formatAssetAmount(delta.amountFormatted);
  const hasMore = rounded !== delta.amountFormatted;
  const usd = price && price > 0 ? Number(delta.amountFormatted) * price : 0;

  const amount = (
    <span className={`text-value break-all text-right font-mono ${colorClass}`}>
      {sign}
      <SubText>{rounded}</SubText>
    </span>
  );

  return (
    // A fixed row height keeps the two columns' rows on the same baseline: an ERC-20 row carries
    // an address sub-line and a native row doesn't, so without it they drift apart when expanded.
    <div className="flex min-h-[34px] flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
      <div className="flex min-w-0 flex-1 basis-[5rem] items-center gap-1.5">
        <TokenWithChain
          chainId={chainId}
          address={delta.isNative ? ethAddress : delta.address}
          symbol={symbol}
          chain={chain}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground text-symbol truncate">{symbol}</span>
          {!delta.isNative && <TokenAddress address={delta.address} />}
        </div>
      </div>
      <div className="ml-auto flex flex-none flex-col items-end">
        {hasMore ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>{amount}</TooltipTrigger>
              <TooltipContent side="top" className="max-w-[240px] break-all text-xs">
                {sign}
                {delta.amountFormatted} {symbol}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          amount
        )}
        {usd > 0 && <span className="text-muted-foreground text-body-xs">{formatUsd(usd)}</span>}
      </div>
    </div>
  );
}

/**
 * One direction of the simulated balance change — "You send" or "You get" — as its own
 * bordered card with a header strip. Beyond `COLLAPSED_ROWS` entries the tail collapses
 * behind a "+N" toggle so a many-legged swap stays the same height as a simple one.
 */
function DeltaColumn({
  direction,
  deltas,
  nativeSymbol,
  chainId,
  prices,
  onBehalf,
  chain,
  heading,
  via,
  prefix,
  children,
}: {
  direction: 'out' | 'in';
  deltas: AssetDelta[];
  nativeSymbol: string;
  chainId?: number;
  prices: Record<string, number>;
  /** The balances belong to another account (a permissioned execution), so not "you". */
  onBehalf?: boolean;
  chain?: ChainBadge;
  /** Replaces the default heading, for funds that go to someone else. */
  heading?: string;
  /** The bridge that carries the funds, named in the heading. */
  via?: string;
  prefix?: string;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const out = direction === 'out';
  const Arrow = out ? ArrowUpRight : ArrowDownLeft;
  const title = heading ?? (onBehalf ? (out ? 'Sends' : 'Receives') : out ? 'You send' : 'You get');
  const overflow = deltas.length - COLLAPSED_ROWS;
  const shown = expanded ? deltas : deltas.slice(0, COLLAPSED_ROWS);

  return (
    <div className="border-border rounded-box min-w-0 flex-1 overflow-hidden border">
      <div className="border-border/40 bg-secondary/40 flex items-center gap-2 border-b p-3">
        <Arrow className={`size-3 flex-none ${out ? 'text-negative' : 'text-positive'}`} strokeWidth={2.7} />
        {/* Under a permission the funds move from the granter, not the signer reading this —
            the subject is dropped and the "On behalf of" row above says whose they are. */}
        <span className="text-foreground text-heading flex min-w-0 items-baseline gap-1 whitespace-nowrap">
          <span className="min-w-0 truncate">{title}</span>
          {via && (
            <>
              {' '}
              <span className="text-muted-foreground text-body-xs min-w-0 shrink-[100] truncate">via {via}</span>
            </>
          )}
        </span>
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground text-body-xs ml-auto flex flex-none items-center gap-1 font-mono font-medium"
          >
            {expanded ? 'Show less' : `+${overflow}`}
            <ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} strokeWidth={2.2} />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3 p-2">
        {children}
        {shown.map((d) => (
          <AssetRow
            key={`${direction}-${d.address}`}
            delta={d}
            nativeSymbol={nativeSymbol}
            chainId={chainId}
            price={prices[symbolFor(d, nativeSymbol)]}
            chain={chain}
            prefix={prefix}
          />
        ))}
      </div>
    </div>
  );
}

const SIMULATION_FAILED =
  'Could not simulate this transaction. Balance changes are unknown; review each call before you approve.';

// An unknown token has no decimals to scale by, so it gets no delta and PlainRow shows base units.
const sentDeltas = ({ amount, token }: TokenAmount): AssetDelta[] =>
  token.known
    ? [
        {
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          diff: amount,
          direction: 'out',
          amountFormatted: formatUnits(amount, token.decimals),
          isNative: token.address === zeroAddress,
        },
      ]
    : [];

// Cut, not rounded: a minimum must never read higher than it is. Four decimals, or four
// significant digits when the amount is smaller than that.
function floorAmount(exact: string): string {
  const [whole, fraction = ''] = exact.split('.');
  const leading = fraction.search(/[1-9]/);
  const digits = whole === '0' && leading >= 4 ? leading + 4 : 4;
  const cut = fraction.slice(0, digits).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

const receivedDeltas = (receive: Received): AssetDelta[] =>
  receive.kind === 'minimum' && receive.amount.token.known
    ? sentDeltas(receive.amount).map((delta) => ({
        ...delta,
        direction: 'in',
        amountFormatted: floorAmount(delta.amountFormatted),
      }))
    : [];

const receivedChainId = (receive: Received) => (receive.kind === 'minimum' ? receive.amount.chainId : receive.chainId);

/** A token the amount column cannot scale, or whose amount a swap on the destination sets. */
function PlainRow({
  chainId,
  token,
  chain,
  children,
}: {
  chainId: number;
  token: Token;
  chain?: ChainBadge;
  children: ReactNode;
}) {
  const short = formatAddress(token.address);
  const symbol = token.known ? token.symbol : short;
  const native = token.address === zeroAddress;
  return (
    <div className="flex flex-row items-start gap-1.5">
      <TokenWithChain chainId={chainId} address={native ? ethAddress : token.address} symbol={symbol} chain={chain} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground text-symbol truncate">{symbol}</span>
        {token.known && !native && <TokenAddress address={token.address} />}
        {children}
      </div>
    </div>
  );
}

function BridgeColumns({
  bridge,
  out,
  received,
  apiKey,
  ...columnProps
}: {
  bridge: BridgeTransfer;
  out: AssetDelta[];
  received: AssetDelta[];
  apiKey?: string;
  nativeSymbol: string;
  chainId?: number;
  prices: Record<string, number>;
  onBehalf?: boolean;
}) {
  const icons = useChainIcons(apiKey);
  const { send, receive, provider, otherRecipient } = bridge;
  const crossChain = !!receive && receivedChainId(receive) !== send.chainId;
  const badge = (chainId: number) =>
    crossChain ? { name: BRIDGE_CHAINS[chainId].name, icon: icons[chainId] } : undefined;
  const origin = badge(send.chainId);
  const destination = receive && receivedChainId(receive);

  return (
    <div className="flex items-stretch gap-3">
      <DeltaColumn direction="out" deltas={out} chain={origin} {...columnProps}>
        {out.length === 0 && (
          <PlainRow chainId={send.chainId} token={send.token} chain={origin}>
            <span className="text-value text-negative break-all font-mono">−{send.amount.toString()} base units</span>
          </PlainRow>
        )}
      </DeltaColumn>
      {receive && destination !== undefined && (
        <DeltaColumn
          direction="in"
          deltas={received}
          chain={badge(destination)}
          heading={otherRecipient && 'Recipient gets'}
          via={PROVIDER_NAME[provider]}
          prefix="≥ "
          {...columnProps}
          chainId={destination}
          nativeSymbol={BRIDGE_CHAINS[destination].nativeSymbol}
        >
          {receive.kind === 'swap' && (
            <PlainRow chainId={destination} token={receive.token} chain={badge(destination)}>
              <span className="text-warning text-body-xs">
                Amount set by a swap on {BRIDGE_CHAINS[destination].name}
              </span>
            </PlainRow>
          )}
          {receive.kind === 'minimum' && !receive.amount.token.known && (
            <PlainRow chainId={destination} token={receive.amount.token} chain={badge(destination)}>
              <span className="text-value text-positive break-all font-mono">
                ≥ <SubText>{`${receive.amount.amount} base units`}</SubText>
              </span>
            </PlainRow>
          )}
        </DeltaColumn>
      )}
    </div>
  );
}

export const AssetPreview = ({
  assetsOut,
  assetsIn,
  error,
  nativeSymbol,
  chainId,
  onBehalf,
  bridge,
  apiKey,
}: AssetPreviewProps) => {
  const [prices, setPrices] = useState<Record<string, number>>({});

  // The simulation cannot see the other chain, so a bridge view takes its receive side from the
  // decoded deposit alone. Simulated incoming tokens are a different thing and stay out of it.
  const bridgeOut = bridge && (!error && assetsOut.length > 0 ? assetsOut : sentDeltas(bridge.send));
  const bridgeIn = bridge?.receive ? receivedDeltas(bridge.receive) : [];
  const shown = bridgeOut ? bridgeOut : [...assetsOut, ...assetsIn];
  const symbols = [...shown.map((d) => symbolFor(d, nativeSymbol)), ...bridgeIn.map((d) => d.symbol ?? '')]
    .filter(Boolean)
    .sort()
    .join(',');

  useEffect(() => {
    if (!symbols) return;
    let cancelled = false;
    Promise.all([...new Set(symbols.split(','))].map(async (s) => [s, await fetchTokenPrice(s)] as const)).then(
      (entries) => {
        if (!cancelled) setPrices(Object.fromEntries(entries));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [symbols]);

  const columnProps = { nativeSymbol, chainId, prices, onBehalf };
  if (bridge && bridgeOut) {
    return (
      <>
        {error && <WarningNotice messages={[SIMULATION_FAILED]} />}
        <BridgeColumns bridge={bridge} out={bridgeOut} received={bridgeIn} apiKey={apiKey} {...columnProps} />
      </>
    );
  }
  if (error) return <WarningNotice messages={[SIMULATION_FAILED]} />;
  if (assetsOut.length === 0 && assetsIn.length === 0) return null;

  // Both directions sit side by side (the swap/supply shape); a one-sided change takes
  // the full width rather than leaving a gap.
  return (
    <div className="flex items-stretch gap-3">
      {assetsOut.length > 0 && <DeltaColumn direction="out" deltas={assetsOut} {...columnProps} />}
      {assetsIn.length > 0 && <DeltaColumn direction="in" deltas={assetsIn} {...columnProps} />}
    </div>
  );
};
