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
import { RECOVERY_SETUP_PROBLEM_TEXT, recoveryGuardianRows } from '../../utils/recoverySetup';
import type { RecoveryDialogProps } from './types';
import { GuardianList, NetworkStatusList, RecoveryNotice, RecoveryTerms, chainName } from './Sections';

/**
 * The recovery screen works like the permission screen: the app passes the end state, the screen
 * shows it and the user approves or declines. Nothing on it is editable (R16).
 *
 * The guardians are one list (the team's option 1): the end state with what is new marked, then
 * what the change removes, struck through, and the approvals before and after. A first setup
 * carries the fee of the one transaction that enables recovery on the connected network; an edit
 * is relayed to every network where recovery is on, and JAW pays.
 */
export const RecoveryDialog = ({
  open,
  onOpenChange,
  accountAddress,
  origin,
  appName,
  appLogoUrl,
  config,
  current,
  chains,
  isLoadingConfig = false,
  problem,
  networkName,
  chainId,
  chainIcon,
  apiKey,
  onConfirm,
  onCancel,
  onDone,
  isProcessing,
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
  }, [isProcessing, result, isLoadingConfig]);

  const isFirstSetup = !current || isFirstRecoverySetup(current);
  const minimumDelay = minimumRecoveryDelay(config.recoveries, config.threshold);

  const rows = useMemo(
    () => recoveryGuardianRows(isFirstSetup ? null : current, config.recoveries),
    [isFirstSetup, current, config.recoveries]
  );
  const approvals = {
    from: isFirstSetup || !current ? undefined : { threshold: current.threshold, count: current.recoveries.length },
    to: { threshold: config.threshold, count: config.recoveries.length },
  };

  const editNetworks = chains
    .filter((chain) => chain.deployed && chain.enrolled)
    .map((chain) => chainName(chain.chainId));

  // The account already holds exactly this: nothing to sign (the planner, which is what gets
  // signed, has no change). The answer is Account's own for an edit that changes nothing.
  const alreadyInPlace = useMemo(
    () =>
      !isLoadingConfig && !problem && !isFirstSetup && !!current && planRecoveryChanges(current, config).length === 0,
    [isLoadingConfig, problem, isFirstSetup, current, config]
  );

  // Same fee rules as the permission screen, on the first setup only: an edit is relayed.
  const hasSelectablePaymentOption =
    !feeTokens || feeTokens.length === 0 ? true : feeTokens.some((t) => t.isSelectable);
  const blockReason = isFirstSetup
    ? resolveBlockReason({
        hasSelectablePaymentOption,
        gasEstimationError,
        sponsored,
        isPayingWithErc20: !!isPayingWithErc20,
      })
    : null;
  const erc20CannotPay =
    isFirstSetup && isPayingWithErc20 && (!selectedFeeToken?.gasCostMaxFormatted || !selectedFeeToken?.isSelectable);

  const canConfirm =
    !isLoadingConfig &&
    !problem &&
    !isProcessing &&
    !(isFirstSetup && gasFeeLoading) &&
    !blockReason &&
    !erc20CannotPay &&
    (minimumDelay !== 0 || zeroDelayConfirmed);

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
            <GuardianList rows={rows} approvals={approvals} chainId={chainId} mainnetRpcUrl={mainnetRpcUrl} />
            {!alreadyInPlace && (
              <RecoveryTerms
                minimumDelay={minimumDelay}
                networks={isFirstSetup ? networkName : editNetworks.join(', ')}
                feesPaidByJaw={!isFirstSetup}
              />
            )}
            {isFirstSetup && (
              <p className="text-muted-foreground text-body-sm">
                Adds the recovery contract to your account so these guardians can restore access.
              </p>
            )}
          </>
        )}

        {!alreadyInPlace && minimumDelay === 0 && (
          <label className="border-destructive/40 rounded-box flex cursor-pointer items-start gap-2 border p-3">
            <Checkbox
              checked={zeroDelayConfirmed}
              onCheckedChange={(checked) => setZeroDelayConfirmed(checked === true)}
              disabled={isProcessing}
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
        {isFirstSetup && !isLoadingConfig && (
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
            disabled={isProcessing}
          />
        )}

        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={isProcessing}
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
              {blockReason === 'funds' ? 'Insufficient Funds' : isFirstSetup ? 'Enable recovery' : 'Confirm changes'}
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
      dismissable={!isProcessing}
      onClose={onCancel}
      contentClassName="min-h-[510px]"
    >
      {isProcessing ? (
        <ProcessingScreen
          seedAddress={accountAddress}
          appAvatar={appAvatar}
          title={isFirstSetup ? 'Enabling recovery' : 'Updating recovery'}
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
 * A·05: the outcome per network. A first setup landed before it got here (the account door
 * returns after the transaction); an edit is relayed, so its networks are polled until none is in
 * flight. Done is always enabled: the work carries on in the background, and the result the dApp
 * gets carries the latest statuses.
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
        <NetworkStatusList chains={chains} />
        <p className="text-muted-foreground text-body-sm">
          {timedOut
            ? 'Still updating in the background. Reopen recovery later to check.'
            : isFirstSetup
              ? 'Recovery is on for this network. Set it up on other networks you use.'
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
