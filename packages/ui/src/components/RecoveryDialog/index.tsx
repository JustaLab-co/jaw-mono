'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isFirstRecoverySetup,
  minimumRecoveryDelay,
  planRecoveryChanges,
  type RecoverySetupResult,
} from '@jaw.id/core';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Spinner } from '../ui/spinner';
import { ShellDialog } from '../ShellDialog';
import { ProcessingScreen } from '../ProcessingScreen';
import { DialogAppHeader } from '../DialogAppHeader';
import { NetworkFeeRow } from '../NetworkFeeRow';
import { AppAvatar } from '../AppAvatar';
import { useChainIconURI, useFeeTokenPrice } from '../../hooks';
import { useRecoveryRelayStatus } from '../../hooks/useRecoveryRelayStatus';
import { resolveBlockReason } from '../../utils/transactionFailure';
import {
  RECOVERY_SETUP_PROBLEM_TEXT,
  RECOVERY_UNAVAILABLE_TEXT,
  recoveryGuardianRows,
  recoveryUnavailable,
} from '../../utils/recoverySetup';
import type { RecoveryDialogProps } from './types';
import { GuardianList, NetworkStatusList, RecoveryNetworks, RecoveryNotice, RecoveryTerms } from './Sections';

/**
 * The recovery screen works like the permission screen: the app passes the end state, the screen
 * shows it and the user approves or declines. Nothing on it is editable (R16).
 *
 * The guardians are one list (the team's option 1): the end state with what is new marked, then
 * what the change removes, struck through, and the approvals before and after. A first setup and
 * an edit are the same one signature, relayed to every network that can take it, and JAW pays;
 * the Networks section shows, before the user confirms, every network the account is on and
 * whether the change reaches it, with the reason when it doesn't. When no network can take it yet, the
 * screen offers the one transaction that fixes that on the connected network, with its fee.
 */
export const RecoveryDialog = ({
  open,
  onOpenChange,
  accountAddress,
  origin,
  appName,
  appLogoUrl,
  config,
  plan,
  isLoadingConfig = false,
  problem,
  networkName,
  chainId,
  chainIcon,
  apiKey,
  onConfirm,
  onActivate,
  onCancel,
  onDone,
  isProcessing,
  isActivating = false,
  status,
  result,
  gasFee,
  gasFeeLoading = false,
  gasEstimationError = '',
  sponsored = false,
  feeTokens,
  feeTokensLoading,
  selectedFeeToken,
  onFeeTokenSelect,
  showFeeTokenSelector,
  isPayingWithErc20,
  mainnetRpcUrl,
  nativeCurrencySymbol,
}: RecoveryDialogProps) => {
  const [zeroDelayConfirmed, setZeroDelayConfirmed] = useState(false);

  const defaultChainIcon = useChainIconURI(chainId || 1, apiKey, 24);
  const displayChainIcon = chainIcon || defaultChainIcon;

  const nativeToken = feeTokens?.find((t) => t.isNative);
  const nativeSymbol = nativeToken?.symbol || nativeCurrencySymbol || 'ETH';
  const nativeTokenPrice = useFeeTokenPrice(nativeSymbol);

  // Inside a Radix modal a nested container's wheel events get eaten — drive scrollTop manually.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollHeight <= el.clientHeight) return;
      el.scrollTop += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isProcessing, isActivating, result, isLoadingConfig]);

  // The change is planned from the base network; with none, nothing holds a config yet.
  const base = plan?.base ?? null;
  const isFirstSetup = !base || isFirstRecoverySetup(base);
  const minimumDelay = minimumRecoveryDelay(config.recoveries, config.threshold);

  const rows = useMemo(
    () => recoveryGuardianRows(isFirstSetup ? null : base, config.recoveries),
    [isFirstSetup, base, config.recoveries]
  );
  const approvals = {
    from: isFirstSetup || !base ? undefined : { threshold: base.threshold, count: base.recoveries.length },
    to: { threshold: config.threshold, count: config.recoveries.length },
  };

  // No network can take the change yet: why, and whether one transaction here fixes it.
  const unavailable = plan && !isLoadingConfig && !problem ? recoveryUnavailable(plan, chainId ?? 0) : null;
  const canActivate = unavailable === 'deploy' || unavailable === 'enable';

  // The account already holds exactly this: nothing to sign (the planner, which is what gets
  // signed, has no change). The answer is Account's own for an edit that changes nothing.
  const alreadyInPlace = useMemo(
    () => !isLoadingConfig && !problem && !isFirstSetup && !!base && planRecoveryChanges(base, config).length === 0,
    [isLoadingConfig, problem, isFirstSetup, base, config]
  );

  // Same fee rules as the permission screen, for the activation transaction only: a change is
  // relayed.
  const hasSelectablePaymentOption =
    !feeTokens || feeTokens.length === 0 ? true : feeTokens.some((t) => t.isSelectable);
  const blockReason = canActivate
    ? resolveBlockReason({
        hasSelectablePaymentOption,
        gasEstimationError,
        sponsored,
        isPayingWithErc20: !!isPayingWithErc20,
      })
    : null;
  const erc20CannotPay =
    canActivate && isPayingWithErc20 && (!selectedFeeToken?.gasCostMaxFormatted || !selectedFeeToken?.isSelectable);

  const busy = isProcessing || isActivating;
  const canActivateNow = canActivate && !busy && !gasFeeLoading && !blockReason && !erc20CannotPay;
  const canConfirm = !isLoadingConfig && !problem && !!base && !busy && (minimumDelay !== 0 || zeroDelayConfirmed);

  const hasError = !!status && status.includes('Error');

  const header = (title: string) => (
    <div className="flex-none px-6 pt-6">
      <DialogAppHeader
        appName={appName}
        appLogoUrl={appLogoUrl}
        origin={origin}
        chainName={networkName}
        chainIcon={displayChainIcon}
      />
      <h2 className="text-foreground text-title-xl mt-4">{title}</h2>
    </div>
  );

  const appAvatar = <AppAvatar appName={appName} appLogoUrl={appLogoUrl} />;

  const renderReview = () => (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(isFirstSetup ? 'Set up recovery' : 'Update recovery')}

      <div ref={scrollRef} className="jaw-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-3 pt-6">
        {problem && (
          <RecoveryNotice tone="destructive" title={RECOVERY_SETUP_PROBLEM_TEXT[problem].text}>
            {RECOVERY_SETUP_PROBLEM_TEXT[problem].detail}
          </RecoveryNotice>
        )}

        {isLoadingConfig ? (
          <div className="flex min-h-[200px] items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <>
            {alreadyInPlace && (
              <div className="bg-success/10 text-success rounded-box text-body-sm p-3 font-medium">
                Already set up. Recovery on this account matches what this app asks for.
              </div>
            )}
            {unavailable && (
              <RecoveryNotice
                tone={canActivate ? 'warning' : 'destructive'}
                title={RECOVERY_UNAVAILABLE_TEXT[unavailable].text}
              >
                {RECOVERY_UNAVAILABLE_TEXT[unavailable].detail(networkName)}
              </RecoveryNotice>
            )}
            <GuardianList rows={rows} approvals={approvals} chainId={chainId} mainnetRpcUrl={mainnetRpcUrl} />
            {!alreadyInPlace && <RecoveryTerms minimumDelay={minimumDelay} />}
            {base && plan && !alreadyInPlace && (
              <RecoveryNetworks networks={plan.networks} connectedChainId={chainId} apiKey={apiKey} />
            )}
          </>
        )}

        {!alreadyInPlace && minimumDelay === 0 && (
          <label className="border-destructive/40 rounded-box flex cursor-pointer items-start gap-2 border p-3">
            <Checkbox
              checked={zeroDelayConfirmed}
              onCheckedChange={(checked) => setZeroDelayConfirmed(checked === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <span className="text-destructive text-body-sm">
              I understand recovery can complete instantly, with no chance to cancel.
            </span>
          </label>
        )}

        {hasError && (
          <div className="bg-destructive/10 rounded-box p-3">
            <p className="text-destructive text-body">{status}</p>
          </div>
        )}
      </div>

      <div className="border-border/40 flex-none space-y-2 border-t px-6 pb-5 pt-3">
        {canActivate && (
          <NetworkFeeRow
            blockReason={blockReason}
            gasFee={gasFee}
            gasFeeLoading={gasFeeLoading}
            sponsored={sponsored}
            nativeSymbol={nativeSymbol}
            nativeTokenPrice={nativeTokenPrice}
            networkName={networkName}
            chainId={chainId}
            chainIcon={displayChainIcon}
            feeTokens={feeTokens}
            feeTokensLoading={feeTokensLoading}
            selectedFeeToken={selectedFeeToken}
            onFeeTokenSelect={onFeeTokenSelect}
            showFeeTokenSelector={showFeeTokenSelector}
            isPayingWithErc20={isPayingWithErc20}
            hasSelectablePaymentOption={hasSelectablePaymentOption}
            disabled={busy}
          />
        )}
        {canActivate && (
          <Button
            onClick={onActivate}
            disabled={!canActivateNow}
            className="rounded-box text-button h-10 w-full font-semibold focus-visible:ring-1"
          >
            {blockReason === 'funds' ? 'Insufficient Funds' : `Activate on ${networkName}`}
          </Button>
        )}

        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
            className="rounded-box text-button h-10 flex-[44] font-semibold focus-visible:ring-1"
          >
            Cancel
          </Button>
          {alreadyInPlace ? (
            <Button
              onClick={() => onDone({ door: 'relay', chains: [] })}
              className="rounded-box text-button h-10 flex-[56] font-semibold focus-visible:ring-1"
            >
              Done
            </Button>
          ) : (
            <Button
              onClick={onConfirm}
              disabled={!canConfirm}
              className="rounded-box text-button h-10 flex-[56] font-semibold focus-visible:ring-1"
            >
              {isFirstSetup ? 'Set up recovery' : 'Confirm changes'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <ShellDialog
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!busy}
      onClose={onCancel}
      contentClassName="min-h-[510px]"
    >
      {isActivating ? (
        <ProcessingScreen
          seedAddress={accountAddress}
          appAvatar={appAvatar}
          title={`Activating on ${networkName}`}
          subtitle="Confirm with your passkey"
        />
      ) : isProcessing ? (
        <ProcessingScreen
          seedAddress={accountAddress}
          appAvatar={appAvatar}
          title={isFirstSetup ? 'Setting up recovery' : 'Updating recovery'}
          subtitle="Confirm with your passkey"
        />
      ) : result ? (
        <RecoveryDone result={result} isFirstSetup={isFirstSetup} header={header} apiKey={apiKey} onDone={onDone} />
      ) : (
        renderReview()
      )}
    </ShellDialog>
  );
};

/**
 * A·05: the outcome per network. Every change is relayed, so its networks are polled until none
 * is in flight. Done is always enabled: the work carries on in the background, and the result the
 * dApp gets carries the latest statuses.
 */
function RecoveryDone({
  result,
  isFirstSetup,
  header,
  apiKey,
  onDone,
}: {
  result: RecoverySetupResult;
  isFirstSetup: boolean;
  header: (title: string) => ReactNode;
  apiKey?: string;
  onDone: (result: RecoverySetupResult) => void;
}) {
  const { chains, timedOut } = useRecoveryRelayStatus(result.batchId, result.chains, apiKey);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(isFirstSetup ? 'Recovery is on' : 'Recovery updated')}

      <div className="jaw-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-3 pt-6">
        <NetworkStatusList chains={chains} apiKey={apiKey} />
        <p className="text-muted-foreground text-body-sm">
          {timedOut
            ? 'Still updating in the background. Reopen recovery later to check.'
            : 'A network that didn’t go through can be updated again from recovery settings.'}
        </p>
      </div>

      <div className="border-border/40 flex-none border-t px-6 pb-5 pt-3">
        <Button
          onClick={() => onDone({ ...result, chains })}
          className="rounded-box text-button h-10 w-full font-semibold focus-visible:ring-1"
        >
          Done
        </Button>
      </div>
    </div>
  );
}

export * from './types';
