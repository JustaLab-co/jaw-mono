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
  /** Why the paymaster estimation for this token failed, when it failed for a reason other than funds. */
  estimationFailure?: string;
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
  // For stablecoins, show 2 decimals; for native tokens (ETH, FLR, etc.), show more
  const stablecoins = ['USDC', 'USDT', 'DAI'];
  const decimals = stablecoins.includes(symbol.toUpperCase()) ? 2 : 6;
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
};

// Format USD value (show at least 4 decimals for small gas amounts)
const formatUsd = (value: number) => {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}`;
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

  // Calculate USD values for tokens
  const getBalanceUsd = (token: FeeTokenOption): string => {
    if (token.isNative && nativeTokenPrice > 0) {
      const usd = parseFloat(token.balanceFormatted) * nativeTokenPrice;
      return formatUsd(usd);
    }
    // For non-native ERC-20 tokens, show balance with token decimals
    if (!token.isNative) {
      const balance = parseFloat(token.balanceFormatted);
      // Show appropriate decimal places based on token decimals
      const displayDecimals = token.decimals >= 6 ? 2 : token.decimals;
      return `${balance.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: displayDecimals,
      })} ${token.symbol}`;
    }
    return '';
  };

  // Get gas cost for a token
  // For ERC-20 tokens, use pre-computed gasCostFormatted if available (from paymaster quote)
  const getGasCost = (token: FeeTokenOption): { formatted: string; maxFormatted?: string; usd: string } | null => {
    // Tokens with 0 balance - no gas cost to show
    if (token.balance === 0n) {
      return null;
    }

    // If token has pre-computed gas cost (from paymaster quote), use that
    if (token.gasCostFormatted) {
      // Check if it's a valid numeric value (not "Insufficient" or "Estimation failed")
      const numericPart = token.gasCostFormatted.replace(/[^0-9.]/g, '');
      const tokenCost = parseFloat(numericPart);

      // If not a valid number, don't show gas cost
      if (isNaN(tokenCost) || numericPart === '') {
        return null;
      }

      return {
        formatted: token.gasCostFormatted,
        maxFormatted: token.gasCostMaxFormatted,
        usd:
          ['USDC', 'USDT', 'DAI'].includes(token.symbol.toUpperCase()) && !isNaN(tokenCost) ? formatUsd(tokenCost) : '',
      };
    }

    // Fallback: derive from the native ETH gas estimate
    if (!estimatedGasEth) {
      return null;
    }

    const gasEth = parseFloat(estimatedGasEth);
    if (isNaN(gasEth)) {
      return null;
    }

    // Native token: show the ETH amount directly. The USD value is only added
    // when a price conversion is available; if it failed, we still show the
    // native estimate instead of blanking out.
    if (token.isNative) {
      return {
        formatted: `${formatBalance(estimatedGasEth, token.symbol)} ${token.symbol}`,
        usd: nativeTokenPrice ? formatUsd(gasEth * nativeTokenPrice) : '',
      };
    }

    // For non-native ERC-20 tokens, converting the ETH estimate needs a price
    if (!nativeTokenPrice) {
      return null;
    }
    const gasUsd = gasEth * nativeTokenPrice;
    // Show appropriate decimal places based on token decimals
    const displayDecimals = token.decimals >= 6 ? 3 : token.decimals;
    return {
      formatted: `${gasUsd.toFixed(displayDecimals)} ${token.symbol}`,
      usd: formatUsd(gasUsd),
    };
  };

  // Token row component
  const TokenRow = ({ token, showGasCost = true }: { token: FeeTokenOption; showGasCost?: boolean }) => {
    const balanceUsd = getBalanceUsd(token);
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
            <SubText>{balanceUsd || `${formatBalance(token.balanceFormatted, token.symbol)} ${token.symbol}`}</SubText>
          </div>
        </div>

        {/* Gas Cost / Status */}
        <div className="shrink-0 text-right">
          {gasCost ? (
            gasCost.usd ? (
              <>
                <div className="text-xs font-semibold">{gasCost.usd}</div>
                <div className="text-muted-foreground text-body-xs">
                  Up to <SubText>{gasCost.maxFormatted ?? gasCost.formatted}</SubText>
                </div>
              </>
            ) : (
              <div className="text-xs font-semibold">
                <SubText>{gasCost.formatted}</SubText>
              </div>
            )
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
        >
          {selectedToken && getTokenIcon(selectedToken, chainId, 'size-3.5')}
          <span>{selectedToken?.symbol || 'Select'}</span>
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end" sideOffset={4}>
        {/* Header */}
        <div className="flex items-center justify-between border-b p-3">
          <h3 className="text-sm font-semibold">Pay with</h3>
          <button onClick={() => setOpen(false)} className="hover:bg-muted rounded-full p-1 transition-colors">
            <X className="size-4" />
          </button>
        </div>

        {/* Token List — native first, then ERC-20s (no section headers). */}
        <div className="max-h-64 overflow-y-auto p-1.5">
          {nativeToken && <TokenRow token={nativeToken} />}
          {erc20Tokens.map((token) => (
            <TokenRow key={token.address} token={token} showGasCost={true} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
