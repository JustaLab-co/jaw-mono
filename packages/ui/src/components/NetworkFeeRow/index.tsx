'use client';

import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { FeeTokenSelector, type FeeTokenOption } from '../FeeTokenSelector';
import { Eyebrow, InlineWarning } from '../primitives';
import { SubText } from '../SubText';
import { subscriptDecimal } from '../../utils/displayFormat';
import type { BlockReason } from '../../utils/transactionFailure';

/** Native amount with dust in subscript notation, e.g. "0.0₅2131 ETH". */
function nativeAmount(gasFee: string, symbol: string): string {
  const g = Number(gasFee);
  return g > 0 && g < 0.0001 ? `${subscriptDecimal(g)} ${symbol}` : `${g.toFixed(4)} ${symbol}`;
}

export interface NetworkFeeRowProps {
  /** Resolved by the caller (see `utils/transactionFailure`), so the button can gate on the same value. */
  blockReason: BlockReason;
  /**
   * Replaces the funds-shortfall tooltip when the caller knows the shortfall is the asset being
   * spent rather than the fee itself.
   */
  fundsShortfallDetail?: string;
  /** Wording for the `will-fail` state; the transaction screen can explain the simulation. */
  willFailDetail?: string;
  /** The error behind an `estimation-failed` block, shown in the tooltip. */
  estimationFailureDetail?: string;
  /** Re-runs the estimation. The retry link shows for `estimation-failed` only when this is set. */
  onRetryEstimation?: () => void;

  gasFee?: string;
  gasFeeLoading?: boolean;
  sponsored?: boolean;
  nativeSymbol: string;
  nativeTokenPrice: number;

  networkName?: string;
  chainId?: number;
  chainIcon?: ReactNode;

  feeTokens?: FeeTokenOption[];
  feeTokensLoading?: boolean;
  selectedFeeToken?: FeeTokenOption | null;
  onFeeTokenSelect?: (token: FeeTokenOption) => void;
  showFeeTokenSelector?: boolean;
  isPayingWithErc20?: boolean;
  hasSelectablePaymentOption: boolean;
  disabled?: boolean;
}

/**
 * The pinned "Network fee" card: fee value on the left, chain badge and fee-token picker on the
 * right. Shared by the transaction and permission dialogs so both report a blocked fee the same
 * way — one short red string with the detail in a tooltip, never a second error elsewhere.
 */
export function NetworkFeeRow({
  blockReason,
  fundsShortfallDetail,
  estimationFailureDetail,
  onRetryEstimation,
  willFailDetail = 'Simulating this transaction reverted, so the fee can’t be estimated and it can’t be submitted.',
  gasFee,
  gasFeeLoading = false,
  sponsored = false,
  nativeSymbol,
  nativeTokenPrice,
  networkName,
  chainId,
  chainIcon,
  feeTokens,
  feeTokensLoading,
  selectedFeeToken,
  onFeeTokenSelect,
  showFeeTokenSelector,
  isPayingWithErc20,
  hasSelectablePaymentOption,
  disabled,
}: NetworkFeeRowProps) {
  // While blocked the picker stays as long as some token is selectable — switching to it clears
  // the block. Suppressed only when nothing can pay, where the choice would change nothing.
  const showSelector = showFeeTokenSelector && !sponsored && !(blockReason && !hasSelectablePaymentOption);

  const feeValue = (() => {
    if (gasFeeLoading && !isPayingWithErc20) {
      return <p className="text-muted-foreground text-body-sm font-mono">Estimating...</p>;
    }

    // Blocked: one short red string in the slot the fee would occupy, detail in the tooltip.
    if (blockReason === 'funds') {
      return (
        <InlineWarning
          text="Insufficient funds"
          detail={
            fundsShortfallDetail ??
            `This account can't cover the network fee in ${nativeSymbol} or any supported token.`
          }
        />
      );
    }
    if (blockReason === 'will-fail') {
      return <InlineWarning text="Transaction will fail" detail={willFailDetail} />;
    }

    if (blockReason === 'estimation-failed') {
      return (
        <div className="flex flex-col items-start gap-1">
          <InlineWarning
            text="Fee estimation failed"
            detail={`The network fee couldn't be estimated, so this transaction can't be submitted yet. ${estimationFailureDetail ?? ''}`.trim()}
          />
          {onRetryEstimation && (
            <button
              type="button"
              onClick={onRetryEstimation}
              disabled={disabled}
              className="text-muted-foreground text-body-xs font-mono underline"
            >
              Retry
            </button>
          )}
        </div>
      );
    }

    if (sponsored) {
      const covered = gasFee && gasFee !== 'sponsored';
      return (
        <div className="flex flex-col items-start gap-1">
          <div className="flex items-center gap-2">
            {covered && nativeTokenPrice > 0 && (
              <span className="text-muted-foreground text-body-xs font-mono line-through">
                ${(nativeTokenPrice * Number(gasFee)).toFixed(4)}
              </span>
            )}
            <span className="text-success bg-success/10 rounded-xs text-body-xs px-2 py-0.5 font-semibold">
              Sponsored
            </span>
          </div>
          <p className="text-muted-foreground text-body-xs font-mono">
            <SubText>{covered ? nativeAmount(gasFee, nativeSymbol) : 'Gas fees covered'}</SubText>
          </p>
        </div>
      );
    }

    if (isPayingWithErc20 && selectedFeeToken) {
      const ceiling = selectedFeeToken.gasCostMaxFormatted ?? selectedFeeToken.gasCostFormatted;
      // `gasCostFormatted` is a quantity of the fee token, not a fiat figure — and the hook has no
      // price source for one. It used to render as `$0.0004` beside `≈ 0.0004 WETH`: the same number
      // wearing two units, one of them wrong by orders of magnitude. One honest line instead.
      //
      // It can also mark the token unpayable (useGasEstimation): a sentinel string or required
      // amount with no ceiling, a priced estimate the balance can't cover, or a settled zero
      // balance (both fields undefined) — all with isSelectable false. A re-estimate can put those
      // on the already-selected token, where blockReason stays null — so this slot must say why.
      // Only a selectable token may show "Estimating...": the selector admits only selectable
      // tokens, so an unselectable selection is always a settled verdict, never in flight.
      const hasTokenCost = selectedFeeToken.gasCostFormatted !== undefined;
      if (!selectedFeeToken.isSelectable || (hasTokenCost && !selectedFeeToken.gasCostMaxFormatted)) {
        if (selectedFeeToken.gasCostFormatted === 'Estimation failed') {
          return (
            <InlineWarning
              text="Estimation failed"
              detail={`The fee in ${selectedFeeToken.symbol} couldn't be estimated. Pick another token to pay with.`}
            />
          );
        }
        // The balance must cover the worst-case ceiling; the ceiling-less legs carry the
        // required amount (or a sentinel) as the cost.
        const needed = selectedFeeToken.gasCostMaxFormatted ?? selectedFeeToken.gasCostFormatted;
        return (
          <InlineWarning
            text="Insufficient funds"
            detail={
              Number.isFinite(Number(needed))
                ? `This account needs about ${needed} ${selectedFeeToken.symbol} to cover the network fee but doesn't hold enough. Pick another token to pay with.`
                : `This account doesn't hold enough ${selectedFeeToken.symbol} to cover the network fee. Pick another token to pay with.`
            }
          />
        );
      }
      return (
        <div className="flex flex-col items-start gap-1">
          <p className="font-mono leading-tight">
            {hasTokenCost ? (
              <span className="text-foreground text-amount">
                {selectedFeeToken.gasCostFormatted} {selectedFeeToken.symbol}
              </span>
            ) : (
              <span className="text-muted-foreground text-body-sm">Estimating...</span>
            )}
          </p>
          {ceiling && Number.isFinite(Number(ceiling)) && (
            <p className="text-muted-foreground text-body-xs font-mono">
              Up to {ceiling} {selectedFeeToken.symbol}
            </p>
          )}
        </div>
      );
    }

    if (gasFee && gasFee !== 'sponsored') {
      const amount = nativeAmount(gasFee, nativeSymbol);
      return (
        <p className="font-mono leading-tight">
          {nativeTokenPrice > 0 ? (
            <>
              <span className="text-foreground text-amount">${(nativeTokenPrice * Number(gasFee)).toFixed(4)}</span>
              <span className="text-muted-foreground text-body-xs ml-1">
                ≈ <SubText>{amount}</SubText>
              </span>
            </>
          ) : (
            <SubText className="text-foreground text-amount">{amount}</SubText>
          )}
        </p>
      );
    }

    return <p className="text-muted-foreground text-body-sm font-mono">Unable to estimate</p>;
  })();

  return (
    <div className="border-border rounded-box border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Eyebrow>Network fee</Eyebrow>
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="text-muted-foreground size-3 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>
                    Gas fees paid to network validators to process your transaction. You can pay with {nativeSymbol} or
                    supported tokens.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="mt-1">{feeValue}</div>
        </div>

        <div className="flex flex-none flex-col items-end gap-1.5">
          <div className="text-muted-foreground text-body-xs flex items-center gap-1 font-mono">
            {/* Round chain badge — clipped to a circle so the logo never stretches. */}
            <span className="border-border bg-secondary size-badge flex flex-none items-center justify-center overflow-hidden rounded-full border [&>*]:!h-full [&>*]:!w-full [&>*]:!min-w-0">
              {chainIcon}
            </span>
            <span className="truncate">{networkName || 'Ethereum'}</span>
          </div>
          {showSelector && feeTokens && onFeeTokenSelect && (
            <FeeTokenSelector
              tokens={feeTokens}
              chainId={chainId}
              selectedToken={selectedFeeToken ?? null}
              onSelect={onFeeTokenSelect}
              isLoading={feeTokensLoading ?? false}
              disabled={disabled}
              nativeTokenPrice={nativeTokenPrice}
              estimatedGasEth={gasFee || '0'}
            />
          )}
        </div>
      </div>
    </div>
  );
}
