import { useEffect, useState, type ReactNode } from 'react';
import { ethAddress, formatUnits, zeroAddress } from 'viem';
import { ArrowDownLeft, ArrowUpRight, ChevronDown } from 'lucide-react';
import { AssetDelta, formatAssetAmount } from '../../utils/assetPreview';
import { BRIDGE_CHAINS } from '../../utils/bridgeCalls/contracts';
import { PROVIDER_NAME, type BridgeTransfer } from '../../utils/bridgeCalls/transfer';
import type { Received, TokenAmount } from '../../utils/bridgeCalls/view';
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

function AssetRow({
  delta,
  nativeSymbol,
  chainId,
  price,
  chain,
}: {
  delta: AssetDelta;
  nativeSymbol: string;
  chainId?: number;
  price?: number;
  chain?: ChainBadge;
}) {
  const out = delta.direction === 'out';
  const sign = out ? '−' : '+';
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
    <div className="flex min-h-[34px] flex-row items-center gap-1.5">
      <TokenWithChain
        chainId={chainId}
        address={delta.isNative ? ethAddress : delta.address}
        symbol={symbol}
        chain={chain}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground text-symbol truncate">{symbol}</span>
        {!delta.isNative && (
          <span className="text-muted-foreground text-body-xs flex min-w-0 flex-row items-center gap-1 font-mono">
            <span className="truncate">{formatAddress(delta.address)}</span>
            <CopyButton value={delta.address} size={10} label="Copy token address" />
          </span>
        )}
      </div>
      <div className="flex flex-none flex-col items-end">
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
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const out = direction === 'out';
  const Arrow = out ? ArrowUpRight : ArrowDownLeft;
  const overflow = deltas.length - COLLAPSED_ROWS;
  const shown = expanded ? deltas : deltas.slice(0, COLLAPSED_ROWS);

  return (
    <div className="border-border rounded-box min-w-0 flex-1 overflow-hidden border">
      <div className="border-border/40 bg-secondary/40 flex items-center gap-2 border-b p-3">
        <Arrow className={`size-3 flex-none ${out ? 'text-negative' : 'text-positive'}`} strokeWidth={2.7} />
        <span className="text-foreground text-heading">
          {/* Under a permission the funds move from the granter, not the signer reading this —
              the subject is dropped and the "On behalf of" row above says whose they are. */}
          {heading ?? (onBehalf ? (out ? 'Sends' : 'Receives') : out ? 'You send' : 'You get')}
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
          />
        ))}
      </div>
    </div>
  );
}

const SIMULATION_FAILED =
  'Could not simulate this transaction. Balance changes are unknown; review each call before you approve.';

// An unknown token has no decimals to scale by, so it gets no delta and SentRow shows base units.
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

function SentRow({ send: { chainId, amount, token }, chain }: { send: TokenAmount; chain?: ChainBadge }) {
  const short = formatAddress(token.address);
  return (
    <div className="flex flex-row items-start gap-1.5">
      <TokenWithChain chainId={chainId} address={token.address} symbol={short} chain={chain} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground text-symbol truncate">{short}</span>
        <span className="text-value text-negative break-all font-mono">−{amount.toString()} base units</span>
      </div>
    </div>
  );
}

const receivedChainId = (receive: Received) => (receive.kind === 'minimum' ? receive.amount.chainId : receive.chainId);

function ReceivedRow({ receive, via, chain }: { receive: Received; via: string; chain?: ChainBadge }) {
  const chainId = receivedChainId(receive);
  const token = receive.kind === 'minimum' ? receive.amount.token : receive.token;
  const symbol = token.known ? token.symbol : formatAddress(token.address);
  const address = token.address === zeroAddress ? ethAddress : token.address;

  return (
    <div className="flex flex-row items-start gap-1.5">
      <TokenWithChain chainId={chainId} address={address} symbol={symbol} chain={chain} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground text-symbol truncate">{symbol}</span>
        {receive.kind === 'minimum' ? (
          <span className="text-value text-positive break-all font-mono">
            ≥ <SubText>{minimumText(receive.amount)}</SubText>
          </span>
        ) : (
          <span className="text-warning text-body-xs">Amount set by a swap on {BRIDGE_CHAINS[chainId].name}</span>
        )}
        <span className="text-muted-foreground text-body-xs">{via}</span>
      </div>
    </div>
  );
}

function minimumText({ amount, token }: TokenAmount): string {
  return token.known ? floorAmount(formatUnits(amount, token.decimals)) : `${amount} base units`;
}

function BridgeColumns({
  bridge,
  assetsOut,
  assetsIn,
  apiKey,
  ...columnProps
}: {
  bridge: BridgeTransfer;
  assetsOut: AssetDelta[];
  assetsIn: AssetDelta[];
  apiKey?: string;
  nativeSymbol: string;
  chainId?: number;
  prices: Record<string, number>;
  onBehalf?: boolean;
}) {
  const icons = useChainIcons(apiKey);
  const { send, receive, provider, otherRecipient } = bridge;
  const simulated = assetsOut.length > 0;
  const crossChain = !!receive && receivedChainId(receive) !== send.chainId;
  const badge = (chainId: number) =>
    crossChain ? { name: BRIDGE_CHAINS[chainId].name, icon: icons[chainId] } : undefined;
  const origin = badge(send.chainId);

  return (
    <div className="flex items-stretch gap-3">
      <DeltaColumn direction="out" deltas={simulated ? assetsOut : sentDeltas(send)} chain={origin} {...columnProps}>
        {!simulated && !send.token.known && <SentRow send={send} chain={origin} />}
      </DeltaColumn>
      {receive && (
        <DeltaColumn
          direction="in"
          deltas={assetsIn}
          chain={origin}
          heading={otherRecipient && `${formatAddress(otherRecipient)} gets`}
          {...columnProps}
        >
          <ReceivedRow
            receive={receive}
            via={`via ${PROVIDER_NAME[provider]}`}
            chain={badge(receivedChainId(receive))}
          />
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

  useEffect(() => {
    const symbols = [...new Set([...assetsOut, ...assetsIn].map((d) => symbolFor(d, nativeSymbol)).filter(Boolean))];
    if (symbols.length === 0) return;
    let cancelled = false;
    Promise.all(symbols.map(async (s) => [s, await fetchTokenPrice(s)] as const)).then((entries) => {
      if (!cancelled) setPrices(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [assetsOut, assetsIn, nativeSymbol]);

  const columnProps = { nativeSymbol, chainId, prices, onBehalf };
  if (bridge) {
    return (
      <>
        {error && <WarningNotice messages={[SIMULATION_FAILED]} />}
        <BridgeColumns
          bridge={bridge}
          assetsOut={error ? [] : assetsOut}
          assetsIn={error ? [] : assetsIn}
          apiKey={apiKey}
          {...columnProps}
        />
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
