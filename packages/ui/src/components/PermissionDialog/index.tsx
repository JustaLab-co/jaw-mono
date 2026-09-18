'use client';

import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '../ui/button';
import { ShellDialog } from '../ShellDialog';
import { ProcessingScreen } from '../ProcessingScreen';
import { DialogAppHeader } from '../DialogAppHeader';
import { NetworkFeeRow } from '../NetworkFeeRow';
import { AppAvatar } from '../AppAvatar';
import { AccountAvatar } from '../AccountAvatar';
import { CopyButton } from '../CopyButton';
import { useChainIconURI, useFeeTokenPrice } from '../../hooks';
import { reverseResolveWithAvatars } from '../../utils/reverseResolve';
import { getChainLabel } from '../../utils/resolveChainLabel';
import { getDisplayAddress } from '../../utils';
import { resolveBlockReason } from '../../utils/transactionFailure';
import { isBlockingRevocationProblem, REVOCATION_PROBLEM_TEXT } from '../../utils/permissionExecution';
import { PermissionDialogProps } from './types';
import { InlineWarning, PartyRow } from '../primitives';
import { AllowedCalls, MetaCard, SpendLimits, isWildcard } from './Sections';

export const PermissionDialog = ({
  open,
  onOpenChange,
  mode,
  permissionId,
  revocationProblem,
  spenderAddress,
  accountAddress,
  origin,
  appName,
  appLogoUrl,
  spends = [],
  calls = [],
  tokenMeta,
  expiryDate,
  grantedDate,
  networkName,
  chainId,
  chainIcon,
  apiKey,
  onConfirm,
  onCancel,
  isProcessing,
  status,
  isLoadingTokenInfo = false,
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
}: PermissionDialogProps) => {
  const isGrant = mode === 'grant';

  const [resolvedAddresses, setResolvedAddresses] = useState<Record<string, string>>({});
  const [resolvedAvatars, setResolvedAvatars] = useState<Record<string, string>>({});
  // Starts true so the confirm button can't be hit before an identity is known.
  const [isResolvingAddresses, setIsResolvingAddresses] = useState(true);

  const defaultChainIcon = useChainIconURI(chainId || 1, apiKey, 24);
  const displayChainIcon = chainIcon || defaultChainIcon;

  const nativeToken = feeTokens?.find((t) => t.isNative);
  const nativeSymbol = nativeToken?.symbol || nativeCurrencySymbol || 'ETH';
  const nativeTokenPrice = useFeeTokenPrice(nativeSymbol);

  // Resolve the spender and every non-wildcard target in one batched request.
  useEffect(() => {
    if (!chainId) {
      setIsResolvingAddresses(false);
      return;
    }
    const targets = new Set<string>();
    if (spenderAddress) targets.add(spenderAddress);
    if (accountAddress) targets.add(accountAddress);
    calls.forEach((call) => {
      if (call.target && !isWildcard(call.target)) targets.add(call.target);
    });
    if (targets.size === 0) {
      setIsResolvingAddresses(false);
      return;
    }

    setIsResolvingAddresses(true);
    let cancelled = false;
    reverseResolveWithAvatars(
      [...targets].map((address) => ({ address, chainId })),
      mainnetRpcUrl
    )
      .then(async (resolved) => {
        if (cancelled) return;
        const label = await getChainLabel(chainId, mainnetRpcUrl);
        if (cancelled) return;
        const names: Record<string, string> = {};
        const avatars: Record<string, string> = {};
        for (const address of targets) {
          const identity = resolved[address.toLowerCase()];
          if (!identity) continue;
          names[address] = label ? `${identity.name}@${label}` : identity.name;
          if (identity.avatar) avatars[address] = identity.avatar;
        }
        setResolvedAddresses((prev) => ({ ...prev, ...names }));
        if (Object.keys(avatars).length > 0) setResolvedAvatars((prev) => ({ ...prev, ...avatars }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsResolvingAddresses(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spenderAddress, accountAddress, calls, chainId, mainnetRpcUrl]);

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
  }, [isProcessing]);

  const hasSelectablePaymentOption =
    !feeTokens || feeTokens.length === 0 ? true : feeTokens.some((t) => t.isSelectable);

  // Same rule as the transaction screen, so a blocked fee reads identically on both.
  const blockReason = resolveBlockReason({
    hasSelectablePaymentOption,
    gasEstimationError,
    sponsored,
    isPayingWithErc20: !!isPayingWithErc20,
  });

  // Same shape as the transaction screen: a certain revert (or a permission we couldn't load)
  // disables Confirm; `expired` and `self-delegated` warn and let the user proceed.
  const revocationBlocks = !!revocationProblem && isBlockingRevocationProblem(revocationProblem);

  // The permission manager stores call rules; a spend-only grant has nothing to store and is
  // rejected onchain. Say so up front rather than letting the grant fail after a signature.
  const missingCalls = isGrant && calls.length === 0;

  // With no call rule the grant can't be built at all, so gas estimation fails for a reason that
  // has nothing to do with funds. Suppress the fee-derived cause and let the banner speak.
  // A blocked revocation is also suppressed here, not just the grant-side blocker: with no
  // permission the fee row prices a placeholder call, so letting it speak would put a second,
  // different reason on screen next to the banner that already named the real one.
  const feeBlockReason = missingCalls || revocationBlocks ? null : blockReason;

  // An ERC-20 fee can't be confirmed until its worst-case ceiling has settled, nor when the
  // balance can't cover it (isSelectable false). NetworkFeeRow warns for every settled
  // unpayable state; the in-flight remainder of this gate renders there as "Estimating...".
  const erc20CannotPay =
    isPayingWithErc20 && (!selectedFeeToken?.gasCostMaxFormatted || !selectedFeeToken?.isSelectable);

  const canConfirm =
    !isProcessing &&
    !isLoadingTokenInfo &&
    !isResolvingAddresses &&
    !gasFeeLoading &&
    !blockReason &&
    !missingCalls &&
    !revocationBlocks &&
    !erc20CannotPay;

  const displayAddress = (address: string) => getDisplayAddress(resolvedAddresses[address], address);
  const truncateAddress = (address: string) => getDisplayAddress(undefined, address);
  const hasError = !!status && status.includes('Error');

  // Grant leads with who you're granting to. Revoke leads with the permission's own id, and the
  // spender becomes a detail row alongside From/Until.
  const spenderCard = (
    <div className="border-border rounded-box border p-3">
      <PartyRow
        label="For"
        value={spenderAddress ? displayAddress(spenderAddress) : 'Loading…'}
        address={spenderAddress}
        avatarUrl={resolvedAvatars[spenderAddress]}
      />
    </div>
  );

  const spenderRow = {
    label: 'Spender',
    value: spenderAddress ? (
      <>
        <AccountAvatar
          seed={spenderAddress}
          avatarUrl={resolvedAvatars[spenderAddress]}
          size={15}
          className="rounded-xs size-blob flex-none"
        />
        <span className="truncate">{displayAddress(spenderAddress)}</span>
        <CopyButton value={spenderAddress} size={11} label="Copy spender address" />
      </>
    ) : (
      <span className="text-muted-foreground">{isLoadingTokenInfo ? 'Loading…' : 'Unavailable'}</span>
    ),
  };

  const permissionIdRow = permissionId
    ? {
        label: 'permissionId',
        value: (
          <>
            <span className="truncate">{truncateAddress(permissionId)}</span>
            <CopyButton value={permissionId} size={11} label="Copy permission ID" />
          </>
        ),
      }
    : null;

  const fromRow = accountAddress
    ? {
        label: 'From',
        value: (
          <>
            <AccountAvatar
              seed={accountAddress}
              avatarUrl={resolvedAvatars[accountAddress]}
              size={15}
              className="rounded-xs size-blob flex-none"
            />
            <span className="truncate">{displayAddress(accountAddress)}</span>
            <CopyButton value={accountAddress} size={11} label="Copy account address" />
          </>
        ),
      }
    : null;

  const metaRows = [
    ...(fromRow ? [fromRow] : []),
    ...(isGrant ? [] : [spenderRow]),
    ...(grantedDate ? [{ label: 'Granted', value: grantedDate }] : []),
    ...(expiryDate ? [{ label: 'Until', value: expiryDate }] : []),
  ];

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
          seedAddress={accountAddress || spenderAddress}
          avatarUrl={resolvedAvatars[accountAddress || spenderAddress]}
          appAvatar={<AppAvatar appName={appName} appLogoUrl={appLogoUrl} />}
          title={isGrant ? 'Granting permission' : 'Revoking permission'}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-none px-6 pt-6">
            <DialogAppHeader
              appName={appName}
              appLogoUrl={appLogoUrl}
              origin={origin}
              chainName={networkName}
              chainIcon={displayChainIcon}
            />
            {/* `title-lg`, not `title-xl`: these two-word titles read at 24 by request — the only
                titles that do. */}
            <h2 className="text-foreground text-title-lg mt-4">
              {isGrant ? 'Requesting Permission' : 'Revoke Permission'}
            </h2>
          </div>

          <div ref={scrollRef} className="jaw-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-3 pt-6">
            {missingCalls && (
              <div className="rounded-box bg-warning/10 flex items-start gap-2 p-3">
                <TriangleAlert className="text-warning mt-px size-3.5 flex-none" strokeWidth={2} />
                <p className="text-body-sm text-warning">
                  This permission has no allowed calls. A grant needs at least one call rule, so spend limits alone
                  can't be granted.
                </p>
              </div>
            )}

            {/* A certain revert named before signing — or, for a failed lookup, the honest
                admission that we couldn't read the permission. Only the former disables Confirm. */}
            {revocationProblem && (
              <div>
                <InlineWarning
                  text={REVOCATION_PROBLEM_TEXT[revocationProblem].text}
                  detail={REVOCATION_PROBLEM_TEXT[revocationProblem].detail}
                />
              </div>
            )}

            {isGrant ? spenderCard : permissionIdRow && <MetaCard rows={[permissionIdRow]} />}

            {spends.length > 0 && (
              <SpendLimits
                spends={spends}
                chainId={chainId}
                nativeSymbol={nativeSymbol}
                isLoading={isLoadingTokenInfo}
                expiryDate={mode === 'grant' ? expiryDate : undefined}
              />
            )}

            {metaRows.length > 0 && <MetaCard rows={metaRows} />}

            {calls.length > 0 && (
              <AllowedCalls
                calls={calls}
                resolvedAddresses={resolvedAddresses}
                resolvedAvatars={resolvedAvatars}
                truncateAddress={truncateAddress}
                tokenMeta={tokenMeta}
                chainId={chainId}
              />
            )}

            <p className="text-muted-foreground text-body-sm">
              {isGrant
                ? 'Limits are enforced onchain. Revoke anytime, one tap.'
                : 'Revoking is onchain and immediate. This spender loses all access above.'}
            </p>

            {hasError && (
              <div className="bg-destructive/10 rounded-box p-3">
                <p className="text-destructive text-body">{status}</p>
              </div>
            )}
          </div>

          <div className="border-border/40 flex-none space-y-2 border-t px-6 pb-5 pt-3">
            <NetworkFeeRow
              blockReason={feeBlockReason}
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

            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={onCancel}
                disabled={isProcessing}
                className="rounded-box text-button h-10 flex-[44] font-semibold focus-visible:ring-1"
              >
                {isGrant ? 'Cancel' : 'Keep it'}
              </Button>
              <Button
                onClick={onConfirm}
                disabled={!canConfirm}
                variant={isGrant ? 'default' : 'destructive'}
                className="rounded-box text-button h-10 flex-[56] font-semibold focus-visible:ring-1"
              >
                {feeBlockReason === 'funds' && !revocationBlocks ? 'Insufficient Funds' : isGrant ? 'Grant' : 'Revoke'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ShellDialog>
  );
};

export * from './types';
export { isWildcard } from './Sections';
