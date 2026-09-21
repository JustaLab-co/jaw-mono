'use client';

import { Button } from '../ui/button';
import { Accordion } from '../ui/accordion';
import { ShellDialog } from '../ShellDialog';
import { ProcessingScreen } from '../ProcessingScreen';
import { useState, useEffect, useRef } from 'react';
import { ethAddress } from 'viem';
import { ArrowDown, LogIn } from 'lucide-react';
import { TransactionDialogProps } from './types';
import { useChainIconURI, useFeeTokenPrice } from '../../hooks';
import { useDecodedCalldata } from '../../hooks/useDecodedCalldata';
import { caip10, getDefaultDescriptorSource } from '../../utils/clearSigning';
import { reverseResolveWithAvatars, getDisplayAddress, getChainLabel, identityKey } from '../../utils';
import { formatNativeValue, subscriptDecimal } from '../../utils/displayFormat';
import { IdentityAvatar } from '../IdentityAvatar';
import { AppAvatar } from '../AppAvatar';
import { TokenIcon } from '../TokenIcon';
import { SubText } from '../SubText';
import { AssetPreview } from './AssetPreview';
import { callTitle } from './DecodedCalldata';
import { resolveBlockReason } from '../../utils/transactionFailure';
import { isBlockingPermissionProblem, PERMISSION_PROBLEM_TEXT } from '../../utils/permissionExecution';
import { BatchStep, SingleCallData } from './CallSections';
import { InlineWarning, PartyRow, Row, ValueAmount } from '../primitives';
import { NetworkFeeRow } from '../NetworkFeeRow';

export const TransactionDialog = ({
  open,
  onOpenChange,
  transactions,
  walletAddress,
  gasFee,
  gasFeeLoading,
  gasEstimationError,
  sponsored,
  assetsOut,
  assetsIn,
  assetPreviewError,
  assetPreviewWillRevert,
  assetPreviewRevertCause,
  onBehalfOf,
  onBehalfOfLoading,
  permissionProblem,
  onConfirm,
  onCancel,
  isProcessing,
  networkName,
  apiKey,
  appName,
  appLogoUrl,
  feeTokens,
  feeTokensLoading,
  selectedFeeToken,
  onFeeTokenSelect,
  showFeeTokenSelector,
  isPayingWithErc20,
  mainnetRpcUrl,
  nativeCurrencySymbol,
}: TransactionDialogProps) => {
  const [resolvedAddresses, setResolvedAddresses] = useState<Record<string, string>>({});
  const [resolvedAvatars, setResolvedAvatars] = useState<Record<string, string>>({});

  const totalTransactions = transactions.length;
  const isSingleTransaction = totalTransactions === 1;
  const currentTransaction = transactions[0];

  const chainIcon = useChainIconURI(currentTransaction?.chainId || 1, apiKey, 24);

  const nativeToken = feeTokens?.find((t) => t.isNative);
  const nativeSymbol = nativeToken?.symbol || nativeCurrencySymbol || 'ETH';
  const nativeTokenPrice = useFeeTokenPrice(nativeSymbol);

  // If feeTokens isn't loaded yet (null/undefined/empty), assume there are selectable options.
  const hasSelectablePaymentOption =
    !feeTokens || feeTokens.length === 0 ? true : feeTokens.some((t) => t.isSelectable);

  // Inside a Radix modal, native wheel scrolling of a nested container can get eaten —
  // drive scrollTop manually (mirrors the signing dialogs).
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
  }, [isProcessing, transactions]);

  // Resolve wallet + transaction 'to' addresses to ENS names in one batched request.
  useEffect(() => {
    const inputs: { address: string; chainId: number }[] = [];
    if (walletAddress && currentTransaction?.chainId) {
      inputs.push({ address: walletAddress, chainId: currentTransaction.chainId });
    }
    if (onBehalfOf && currentTransaction?.chainId) {
      inputs.push({ address: onBehalfOf, chainId: currentTransaction.chainId });
    }
    transactions.forEach((transaction) => {
      if (transaction.to && transaction.chainId) {
        inputs.push({ address: transaction.to, chainId: transaction.chainId });
      }
    });
    if (inputs.length === 0) return;

    let cancelled = false;
    reverseResolveWithAvatars(inputs, mainnetRpcUrl)
      .then(async (resolved) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        const avatarsByKey: Record<string, string> = {};
        for (const { address, chainId } of inputs) {
          const identity = resolved[identityKey(address, chainId)];
          if (!identity) continue;
          const label = await getChainLabel(chainId, mainnetRpcUrl);
          const key = identityKey(address, chainId);
          next[key] = label ? `${identity.name}@${label}` : identity.name;
          if (identity.avatar) avatarsByKey[key] = identity.avatar;
        }
        if (cancelled) return;
        if (Object.keys(next).length > 0) {
          setResolvedAddresses((prev) => ({ ...prev, ...next }));
        }
        if (Object.keys(avatarsByKey).length > 0) {
          setResolvedAvatars((prev) => ({ ...prev, ...avatarsByKey }));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [walletAddress, onBehalfOf, transactions, currentTransaction?.chainId]);

  // Resolve ERC-7730 `metadata.contractName` for every unique `to` in the batch.
  const [contractNames, setContractNames] = useState<Record<string, string>>({});
  const txSignature = transactions
    .filter((t) => !!t.to)
    .map((t) => caip10(t.chainId, t.to))
    .sort()
    .join('|');
  useEffect(() => {
    if (!txSignature) return;
    let cancelled = false;
    (async () => {
      const source = getDefaultDescriptorSource();
      let index;
      try {
        index = await source.getCalldataIndex();
      } catch (err) {
        console.debug('[TransactionDialog] calldata index fetch failed:', err);
        return;
      }

      const lookups = new Map<string, string>();
      for (const t of transactions) {
        if (!t.to) continue;
        const key = t.to.toLowerCase();
        if (lookups.has(key)) continue;
        const path = index[caip10(t.chainId, t.to)];
        if (path) lookups.set(key, path);
      }

      const results = await Promise.all(
        Array.from(lookups, async ([addr, path]) => {
          try {
            const desc = await source.getDescriptor(path);
            const name = desc.metadata?.contractName ?? desc.context?.$id;
            return name ? ([addr, name] as const) : null;
          } catch (err) {
            console.debug('[TransactionDialog] descriptor fetch failed:', path, err);
            return null;
          }
        })
      );

      if (cancelled) return;
      const updates: Record<string, string> = {};
      for (const r of results) if (r) updates[r[0]] = r[1];
      if (Object.keys(updates).length > 0) {
        setContractNames((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [txSignature]);

  // Both maps are filed by address and chain, so a name read on one chain cannot be
  // rendered on another chain's row. Every reader passes the chain of the row it draws,
  // and the two helpers absorb the chain being unknown so the call sites stay plain.
  const nameFor = (address: string | undefined, chainId: number | undefined): string | undefined =>
    address && chainId ? resolvedAddresses[identityKey(address, chainId)] : undefined;
  const avatarFor = (address: string | undefined, chainId: number | undefined): string | undefined =>
    address && chainId ? resolvedAvatars[identityKey(address, chainId)] : undefined;

  // Prefer ENS reverse-resolved name, then ERC-7730 contractName, then truncated address.
  const displayContractAddress = (address: string | undefined, chainId: number | undefined): string => {
    if (!address) return '';
    const ens = nameFor(address, chainId);
    if (ens) return ens;
    const cn = contractNames[address.toLowerCase()];
    if (cn) return cn;
    return getDisplayAddress(undefined, address);
  };

  const dialogChainId = currentTransaction?.chainId;
  const displayWalletAddress = getDisplayAddress(nameFor(walletAddress, dialogChainId), walletAddress);
  const displayToAddress = displayContractAddress(currentTransaction?.to, dialogChainId);

  const blockReason = resolveBlockReason({
    hasSelectablePaymentOption,
    gasEstimationError,
    sponsored,
    isPayingWithErc20: !!isPayingWithErc20,
    revertCause: assetPreviewRevertCause,
  });

  // A permissioned execution is still "permissioned" while the granter is in flight, and after a
  // lookup that failed — the extra row and the delegation badge must not flicker in and out.
  const isPermissioned = !!onBehalfOf || !!onBehalfOfLoading || !!permissionProblem;

  // A failed lookup is uncertainty about the lookup, not a certain revert — it warns below but
  // must not dead-end the dialog the way a genuinely broken permission does.
  const permissionBlocks = !!permissionProblem && isBlockingPermissionProblem(permissionProblem);

  // A broken permission fails estimation too, so the fee row would blame the fee for something
  // the banner already explains precisely. Name the cause once, at the top.
  const feeBlockReason = permissionBlocks ? null : blockReason;

  // An ERC-20 fee can't be confirmed until its worst-case ceiling has settled, nor when the
  // balance can't cover it (isSelectable false). NetworkFeeRow warns for every settled
  // unpayable state; the in-flight remainder of this gate renders there as "Estimating...".
  const erc20CannotPay =
    isPayingWithErc20 && (!selectedFeeToken?.gasCostMaxFormatted || !selectedFeeToken?.isSelectable);
  const canConfirm = !isProcessing && !gasFeeLoading && !blockReason && !erc20CannotPay && !permissionBlocks;

  // Reverts, but gas estimated fine, so it stays submittable: warn rather than block.
  const softRevertWarning = !blockReason && !permissionBlocks && !!assetPreviewWillRevert;

  const singleValue = isSingleTransaction ? formatNativeValue(currentTransaction?.value) : null;
  // Dust renders in subscript notation like the fee rows; math keeps using the raw string.
  const singleValueNum = singleValue ? Number(singleValue) : 0;
  const heroAmount = singleValueNum > 0 && singleValueNum < 0.0001 ? subscriptDecimal(singleValueNum) : singleValue;
  // A pure native transfer (value, no calldata) reads as a "Send"; everything else is a generic review.
  const isNativeSend =
    isSingleTransaction && !!singleValue && (!currentTransaction?.data || currentTransaction.data === '0x');

  // One decode names both the headline and the calldata card.
  const isSingleCall = isSingleTransaction && !isNativeSend && !!currentTransaction?.data;
  const singleCallDecode = useDecodedCalldata(
    isSingleCall ? currentTransaction?.to : undefined,
    isSingleCall ? currentTransaction?.data : undefined,
    currentTransaction?.chainId ?? 1,
    apiKey
  );
  const title = isNativeSend ? "You're Sending" : (callTitle(singleCallDecode) ?? 'Review Transaction');

  // A single call's calldata unfolds only when there's no You-send/You-get summary to stand in
  // for it; otherwise that review screen would open with nothing on it. Batch steps always
  // start collapsed — their headers name the action, so the user opens the one they care about.
  const calldataOpen = !!assetPreviewError || ((assetsOut?.length ?? 0) === 0 && (assetsIn?.length ?? 0) === 0);

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
          seedAddress={walletAddress}
          avatarUrl={avatarFor(walletAddress, dialogChainId)}
          appAvatar={<AppAvatar appName={appName} appLogoUrl={appLogoUrl} />}
          title="Submitting transaction"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Pinned header. The close X comes from DialogShell, pinned over the top-right corner,
              so the title keeps clear of it. */}
          <div className="flex-none px-6 pt-6">
            <h2 className="text-foreground text-title-xl truncate pr-9">{title}</h2>
            {totalTransactions > 1 && currentTransaction?.description && (
              <p className="text-muted-foreground text-body mt-1">
                {currentTransaction.action}: {currentTransaction.description}
              </p>
            )}
          </div>

          {/* Scrollable body */}
          <div ref={scrollRef} className="jaw-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-3 pt-6">
            {/* Native send → one prominent hero amount */}
            {isNativeSend && (
              // The spec sheet frames an ERC-20 supply, so it never measured the native-send hero.
              // Sizes here are the spec's own (24 title, 12 body) rather than new ones.
              <div className="flex items-center gap-3">
                <TokenIcon
                  chainId={currentTransaction.chainId}
                  address={ethAddress}
                  symbol={nativeSymbol}
                  className="size-11 flex-none"
                  fallback={<IdentityAvatar />}
                />
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="text-foreground text-amount-lg">
                    <SubText>{`${heroAmount} ${nativeSymbol}`}</SubText>
                  </span>
                  {nativeTokenPrice > 0 && (
                    <span className="text-muted-foreground text-body">
                      ≈ ${(Number(singleValue) * nativeTokenPrice).toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* From / On behalf of / To */}
            {/* 12 above the connector and 12 below it — the spec's two stacked 12s. Its own frame
                has no connector, so there the same rule reads as a single 24 gap. */}
            <div className="border-border rounded-box flex flex-col gap-3 border p-3">
              <PartyRow
                label="From"
                value={displayWalletAddress}
                address={walletAddress}
                avatarUrl={avatarFor(walletAddress, dialogChainId)}
                // Marks the signer as acting through a delegation rather than for itself.
                badge={
                  isPermissioned ? (
                    <span className="bg-popover absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full">
                      <LogIn className="text-success size-2" strokeWidth={2.6} />
                    </span>
                  ) : undefined
                }
              />
              {isPermissioned && (
                <>
                  <div className="bg-border h-px" />
                  <PartyRow
                    label="On behalf of"
                    value={
                      onBehalfOf
                        ? getDisplayAddress(nameFor(onBehalfOf, dialogChainId), onBehalfOf)
                        : onBehalfOfLoading
                          ? 'Loading…'
                          : 'Unknown'
                    }
                    address={onBehalfOf ?? ''}
                    avatarUrl={avatarFor(onBehalfOf, dialogChainId)}
                  />
                </>
              )}
              {isSingleTransaction && currentTransaction?.to && (
                <>
                  {/* The arrow reads as "value flows this way", which only holds for a plain
                      two-party transfer — a delegated execution gets a neutral divider. */}
                  {isPermissioned ? (
                    <div className="bg-border h-px" />
                  ) : (
                    <div className="flex items-center">
                      <div className="bg-border h-px flex-1" />
                      <ArrowDown className="text-muted-foreground mx-1.5 size-3 flex-none" strokeWidth={2} />
                      <div className="bg-border h-px flex-1" />
                    </div>
                  )}
                  <PartyRow
                    label="To"
                    value={displayToAddress}
                    address={currentTransaction.to}
                    avatarUrl={avatarFor(currentTransaction.to, dialogChainId)}
                  />
                </>
              )}
            </div>

            {/* A certain revert named before signing — or, for a failed lookup, the honest
                admission that we couldn't check. Only the former disables Confirm. */}
            {permissionProblem && (
              <div>
                <InlineWarning
                  text={PERMISSION_PROBLEM_TEXT[permissionProblem].text}
                  detail={PERMISSION_PROBLEM_TEXT[permissionProblem].detail}
                />
              </div>
            )}

            {/* Reverts but gas estimated fine, so it stays submittable. */}
            {softRevertWarning && (
              <div>
                <InlineWarning
                  text="Transaction is likely to fail"
                  detail="Simulation shows this transaction reverting on-chain. You can still submit it, but it will probably fail and consume gas."
                />
              </div>
            )}

            {/* Asset changes — a native send shows the same information in its hero. */}
            {!isNativeSend && (
              <AssetPreview
                // Someone else's balances whenever a granter resolved — except the self-delegated
                // edge case, where granter and spender are the same account; the banner above
                // already names that oddity, so the badge stays simple.
                onBehalf={!!onBehalfOf}
                assetsOut={assetsOut ?? []}
                assetsIn={assetsIn ?? []}
                error={assetPreviewError ?? false}
                nativeSymbol={nativeSymbol}
                chainId={currentTransaction?.chainId}
              />
            )}

            {/* Value (single, non-native) */}
            {isSingleTransaction && !isNativeSend && singleValue && (
              <Row label="Value">
                <ValueAmount
                  amount={singleValue}
                  symbol={nativeSymbol}
                  price={nativeTokenPrice}
                  className="text-foreground text-value font-mono font-semibold"
                />
              </Row>
            )}

            {/* Calldata (single tx) */}
            {isSingleTransaction && currentTransaction?.data && currentTransaction.data !== '0x' && (
              <Accordion type="single" collapsible defaultValue={calldataOpen ? 'calldata' : undefined}>
                <SingleCallData
                  to={currentTransaction.to}
                  data={currentTransaction.data}
                  decode={singleCallDecode}
                  chainId={currentTransaction.chainId}
                  apiKey={apiKey}
                  resolvedAddresses={resolvedAddresses}
                  resolvedAvatars={resolvedAvatars}
                  mainnetRpcUrl={mainnetRpcUrl}
                />
              </Accordion>
            )}

            {/* Batch steps */}
            {!isSingleTransaction && (
              <Accordion type="multiple" className="space-y-3">
                {transactions.map((transaction, index) => (
                  <BatchStep
                    key={index}
                    transaction={transaction}
                    index={index}
                    nativeSymbol={nativeSymbol}
                    nativeTokenPrice={nativeTokenPrice}
                    displayContractAddress={displayContractAddress}
                    apiKey={apiKey}
                    resolvedAddresses={resolvedAddresses}
                    resolvedAvatars={resolvedAvatars}
                    mainnetRpcUrl={mainnetRpcUrl}
                  />
                ))}
              </Accordion>
            )}
          </div>

          {/* Pinned fee row + actions */}
          <div className="border-border/40 flex-none space-y-2 border-t px-6 pb-5 pt-3">
            <NetworkFeeRow
              blockReason={feeBlockReason}
              fundsShortfallDetail={
                assetPreviewRevertCause === 'balance'
                  ? "This account doesn't hold enough of the asset this transaction spends."
                  : undefined
              }
              gasFee={gasFee}
              gasFeeLoading={gasFeeLoading}
              sponsored={sponsored}
              nativeSymbol={nativeSymbol}
              nativeTokenPrice={nativeTokenPrice}
              networkName={networkName}
              chainId={currentTransaction?.chainId}
              chainIcon={chainIcon}
              feeTokens={feeTokens}
              feeTokensLoading={feeTokensLoading}
              selectedFeeToken={selectedFeeToken}
              onFeeTokenSelect={onFeeTokenSelect}
              showFeeTokenSelector={showFeeTokenSelector}
              isPayingWithErc20={isPayingWithErc20}
              hasSelectablePaymentOption={hasSelectablePaymentOption}
              disabled={isProcessing}
            />

            {/* Actions. The spec gives Confirm the wider half — 128 / 165 of the content width.
                `font-semibold` is repeated even though `text-button` carries weight 600: Button's
                base sets `font-medium`, which lives in a different tailwind-merge group and so
                survives the merge to win on source order. */}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={onCancel}
                disabled={isProcessing}
                className="rounded-box text-button h-10 flex-[44] font-semibold focus-visible:ring-1"
              >
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                disabled={!canConfirm}
                className="rounded-box text-button h-10 flex-[56] font-semibold focus-visible:ring-1"
              >
                {blockReason === 'funds' && !permissionBlocks
                  ? 'Insufficient Funds'
                  : isProcessing
                    ? 'Processing...'
                    : isPermissioned
                      ? 'Execute'
                      : 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ShellDialog>
  );
};

export * from './types';
