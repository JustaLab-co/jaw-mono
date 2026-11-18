'use client';

import { useState } from 'react';
import { ethAddress } from 'viem';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { EthIcon, UsdcIcon, UsdtIcon, GenericTokenIcon } from '../../icons';
import { cn } from '../../lib/utils';
import { subscriptDecimal } from '../../utils/displayFormat';
import { ChevronDown, X } from 'lucide-react';
import { TokenIcon } from '../TokenIcon';
import { SubText } from '../SubText';
import { balanceUsd, erc20FeeCost, formatUsd, type FeeCostDisplay } from '../../utils/feeCost';

export interface FeeTokenOption {
  uid: string;
  symbol: string;
  address: string;
  decimals: number;
  balance: bigint;
  balanceFormatted: string;
  isNative: boolean;
  isSelectable: boolean;
  // Optional: USD values for display
  balanceUsd?: string;
  gasCostUsd?: string;
  /** Realistic expected fee (what the user will likely pay). */
  gasCostFormatted?: string;
  /** Worst-case fee ceiling (the "up to" amount reserved/approved). */
  gasCostMaxFormatted?: string;
  /** `gasCostFormatted` in the token's smallest unit, for pricing and formatting it. */
  gasCost?: bigint;
  /** `gasCostMaxFormatted` in the token's smallest unit. */
  gasCostMax?: bigint;
  /** The paymaster's rate: token units per 1e18 wei, with its markup. */
  exchangeRate?: bigint;
  /**
   * The paymaster's USD rate: USD (6 decimals) per 1e18 wei, with the same markup. With
   * `exchangeRate` it gives the token's market value in dollars (see `feeTokenUsd`).
   */
  exchangeRateNativeToUsd?: bigint;
  /** Why the paymaster estimation for this token failed, when it failed for a reason other than funds. */
  estimationFailure?: string;
  /** The paymaster estimation failed because the calls revert. */
  estimationReverted?: boolean;
  // Optional: Token logo URI from API
  logoURI?: string;
}

interface FeeTokenSelectorProps {
  tokens: FeeTokenOption[];
  selectedToken: FeeTokenOption | null;
  onSelect: (token: FeeTokenOption) => void;
  isLoading: boolean;
  disabled?: boolean;
  nativeTokenPrice?: number;
  estimatedGasEth?: string;
  /** Enables endpoint icon lookup for tokens without a logoURI. */
  chainId?: number;
}

// Symbol-based SVG fallback used when neither logoURI nor the icon endpoint has an image
const symbolIcon = (symbol: string, iconClass: string) => {
  switch (symbol.toUpperCase()) {
    case 'ETH':
      return <EthIcon className={iconClass} />;
    case 'USDC':
      return <UsdcIcon className={iconClass} />;
    case 'USDT':
      return <UsdtIcon className={iconClass} />;
    default:
      return <GenericTokenIcon className={iconClass} />;
  }
};

const getTokenIcon = (token: FeeTokenOption, chainId?: number, className?: string) => {
  const iconClass = cn('size-8 shrink-0', className);
  return (
    <TokenIcon
      chainId={chainId}
      address={token.isNative ? ethAddress : token.address}
      symbol={token.symbol}
      src={token.logoURI}
      className={iconClass}
      fallback={symbolIcon(token.symbol, iconClass)}
    />
  );
};

// Format balance for display (max 6 decimal places, min 4 for small values)
const formatBalance = (balance: string, symbol: string) => {
  const num = parseFloat(balance);
  if (num === 0) return '0';
  if (num < 0.0001) return subscriptDecimal(num);
  // For stablecoins, show 2 decimals; for native tokens (ETH, FLR, etc.), show more. Under a
  // cent a stablecoin keeps more decimals too, or two would round it to "0".
  const stablecoins = ['USDC', 'USDT', 'DAI'];
  const decimals = stablecoins.includes(symbol.toUpperCase()) && num >= 0.01 ? 2 : 6;
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
};

// An ERC-20 balance as its row shows it. From 1 up it keeps two decimals, or a balance such as
// "12,345.678912 WMON" overflows the row and is cut off, symbol and all. Under 1 the decimals
// are what tell the amount apart, so it reads as formatBalance has it.
const formatErc20Balance = (balance: string, symbol: string) => {
  const num = parseFloat(balance);
  return num >= 1
    ? num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : formatBalance(balance, symbol);
};

export const FeeTokenSelector = ({
  tokens,
  selectedToken,
  onSelect,
  isLoading,
  disabled,
  nativeTokenPrice = 0,
  estimatedGasEth,
  chainId,
}: FeeTokenSelectorProps) => {
  const [open, setOpen] = useState(false);
  const [boundary, setBoundary] = useState<Element | null>(null);

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner className="size-3" />
        <span>Loading payment options...</span>
      </div>
    );
  }

  const nativeToken = tokens.find((t) => t.isNative);
  const erc20Tokens = tokens.filter((t) => !t.isNative);

  // No ERC-20 alternatives: show a non-interactive native badge instead of the picker
  const hasErc20Options = erc20Tokens.length > 0;
  if (!hasErc20Options) {
    if (!nativeToken) return null;
    return (
      <div className="border-muted-foreground/30 flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium">
        {getTokenIcon(nativeToken, chainId, 'size-3.5')}
        <span>{nativeToken.symbol}</span>
      </div>
    );
  }

  const handleSelect = (token: FeeTokenOption) => {
    if (token.isSelectable) {
      onSelect(token);
      setOpen(false);
    }
  };

  // Only the native balance reads in dollars. An ERC-20 balance reads in the token itself, as the
  // owner holds it, and so does the native one when there is no price (see TokenRow).
  const nativeBalanceUsd = (token: FeeTokenOption): string =>
    token.isNative ? (balanceUsd(token, nativeTokenPrice) ?? '') : '';

  // Get gas cost for a token
  // For ERC-20 tokens, use the paymaster estimate when there is one
  const getGasCost = (token: FeeTokenOption): FeeCostDisplay | null => {
    // Tokens with 0 balance - no gas cost to show
    if (token.balance === 0n) {
      return null;
    }

    // A paymaster estimate, or a sentinel ("Insufficient", "Estimation failed") that shows no cost
    if (token.gasCostFormatted) {
      return erc20FeeCost(token);
    }

    // An ERC-20 with no estimate yet has nothing to show: the native estimate can't be
    // turned into a token amount without the token's own rate.
    if (!token.isNative || !estimatedGasEth) {
      return null;
    }

    const gasEth = parseFloat(estimatedGasEth);
    if (isNaN(gasEth)) {
      return null;
    }

    // Native token: show the ETH amount directly. The USD value is only added
    // when a price conversion is available; if it failed, we still show the
    // native estimate instead of blanking out.
    return {
      formatted: `${formatBalance(estimatedGasEth, token.symbol)} ${token.symbol}`,
      usd: nativeTokenPrice ? formatUsd(gasEth * nativeTokenPrice) : undefined,
    };
  };

  // Token row component
  const TokenRow = ({ token, showGasCost = true }: { token: FeeTokenOption; showGasCost?: boolean }) => {
    const balanceInUsd = nativeBalanceUsd(token);
    const gasCost = showGasCost ? getGasCost(token) : null;
    const isSelected = selectedToken?.address === token.address;

    return (
      <button
        onClick={() => handleSelect(token)}
        disabled={!token.isSelectable || disabled}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-2 transition-colors',
          'hover:bg-muted/60',
          isSelected && 'bg-secondary',
          !token.isSelectable && 'cursor-not-allowed opacity-50',
          token.isSelectable && 'cursor-pointer'
        )}
      >
        {/* Token Icon */}
        {getTokenIcon(token, chainId, 'size-6')}

        {/* Token Info */}
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1">
            <span className={cn('text-xs font-semibold', isSelected && 'text-foreground')}>{token.symbol}</span>
          </div>
          <div className="text-muted-foreground text-body-xs truncate">
            Bal:{' '}
            <SubText>
              {balanceInUsd ||
                `${(token.isNative ? formatBalance : formatErc20Balance)(token.balanceFormatted, token.symbol)} ${token.symbol}`}
            </SubText>
          </div>
        </div>

        {/* Gas Cost / Status: the dollar figure when priced, and the ceiling whenever it is known */}
        <div className="shrink-0 text-right">
          {gasCost ? (
            <>
              <div className="text-xs font-semibold">{gasCost.usd ?? <SubText>{gasCost.formatted}</SubText>}</div>
              {(gasCost.maxFormatted || gasCost.usd) && (
                <div className="text-muted-foreground text-body-xs">
                  Up to <SubText>{gasCost.maxFormatted ?? gasCost.formatted}</SubText>
                </div>
              )}
            </>
          ) : !token.isSelectable ? (
            <span className="text-destructive text-body-xs">{token.balance === 0n ? '0' : 'Insufficient'}</span>
          ) : null}
        </div>
      </button>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="border-muted-foreground/30 h-7 gap-1 rounded-md px-2 text-xs font-medium"
          // The dialog card the picker opens in. Read from the click, which keyboard activation
          // fires too, so it needs no ref through Button.
          onClick={(event) => setBoundary(event.currentTarget.closest('[role="dialog"]'))}
        >
          {selectedToken && getTokenIcon(selectedToken, chainId, 'size-3.5')}
          <span>{selectedToken?.symbol || 'Select'}</span>
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      {/* Stays inside the dialog card: below the button when it fits there, above it otherwise,
          and never taller than the room it has (Radix flips it and sets the available height). */}
      <PopoverContent
        className="flex max-h-[var(--radix-popover-content-available-height)] w-72 flex-col p-0"
        align="end"
        sideOffset={4}
        collisionBoundary={boundary ?? undefined}
        collisionPadding={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b p-3">
          <h3 className="text-sm font-semibold">Pay with</h3>
          <button onClick={() => setOpen(false)} className="hover:bg-muted rounded-full p-1 transition-colors">
            <X className="size-4" />
          </button>
        </div>

        {/* Token List — native first, then ERC-20s (no section headers). About three and a half
            rows show, so the cut-off row tells the owner there is more to scroll. Scrolling it
            does not scroll the dialog behind. */}
        <div className="max-h-44 min-h-0 overflow-y-auto overscroll-contain p-1.5">
          {nativeToken && <TokenRow token={nativeToken} />}
          {erc20Tokens.map((token) => (
            <TokenRow key={token.address} token={token} showGasCost={true} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
