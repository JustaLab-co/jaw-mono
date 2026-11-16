'use client';

import { ShellDialog } from '../ShellDialog';
import { DialogAppHeader } from '../DialogAppHeader';
import { AccountHeaderRow } from '../AccountHeaderRow';
import { SuccessScreen } from '../SuccessScreen';
import { ProcessingScreen } from '../ProcessingScreen';
import { Eip712Tree } from './Eip712Tree';
import { Eip712DomainCard } from './Eip712DomainCard';
import { Erc3009PaymentView } from './Erc3009PaymentView';
import { WarningNotice } from '../primitives';
import { readErc3009 } from '../../utils/erc3009';
import { Button } from '../ui/button';
import { Eip712DialogProps } from './types';
import { useClearSigningTypedData } from '../../hooks';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import { ClearSignedView } from '../TransactionDialog/ClearSignedView';
import { Eip712VerificationDigests } from '../VerificationDigest';
import { AppAvatar } from '../AppAvatar';
import { formatAddress } from '../../utils/formatAddress';
import { normalizeChainId } from '../../utils/clearSigning';
import { useEffect, useMemo, useRef } from 'react';

// EIP-712 TypedData structure
interface TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export const Eip712Dialog = ({
  open,
  onOpenChange,
  typedDataJson,
  origin,
  appName,
  appLogoUrl,
  accountAddress,
  chainName,
  chainId,
  chainIcon,
  mainnetRpcUrl,
  onSign,
  onCancel,
  isProcessing,
  isSuccess,
  signatureStatus,
  canSign,
}: Eip712DialogProps) => {
  // Signing account — shown as a pill on the review screen and as the identicon in
  // the signing/success beats.
  const signerAddress = accountAddress ?? '';
  const { name: resolvedName, avatar: signerAvatar } = useReverseIdentity(accountAddress, chainId, mainnetRpcUrl);
  const displayName = resolvedName || formatAddress(signerAddress);
  // Core refuses unsignable payloads before this dialog opens; this guard is for hosts
  // driving @jaw.id/ui directly. Shape-check rather than trusting the cast — a payload
  // that parses as JSON but lacks `types[primaryType]` used to throw inside the tree,
  // and a render throw here leaves the caller's promise unsettled.
  const typedData = useMemo(() => {
    try {
      const parsed = JSON.parse(typedDataJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const { types, primaryType } = parsed as Partial<TypedData>;
      if (!types || typeof types !== 'object') return null;
      if (typeof primaryType !== 'string' || !Array.isArray((types as Record<string, unknown>)[primaryType])) {
        return null;
      }
      return parsed as TypedData;
    } catch (error) {
      console.error('Failed to parse typed data:', error);
      return null;
    }
  }, [typedDataJson]);

  // Extract apiKey from the mainnet RPC URL so the clear-signing hook can authenticate
  // its token-info reads on the target chain.
  const apiKey = useMemo(() => {
    try {
      return new URL(mainnetRpcUrl).searchParams.get('api-key') ?? undefined;
    } catch {
      return undefined;
    }
  }, [mainnetRpcUrl]);

  // clearSignedChainId is the chain the rows were resolved on (the typed data's
  // domain chain, falling back to the connected chain) — the view must render
  // token icons and chain labels against it, not against `chainId`.
  const {
    display: clearSigned,
    isLoading: clearSigningLoading,
    chainId: clearSignedChainId,
  } = useClearSigningTypedData(typedDataJson, chainId ?? 1, apiKey);

  // Inside a Radix modal, native wheel/trackpad scrolling of a nested overflow
  // container can get eaten. Drive scrollTop manually so the content region always
  // scrolls. (Restored from the pre-revamp dialog.)
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
  }, [open, isProcessing, isSuccess, clearSigned]);

  const hasError = signatureStatus.includes('Error');

  // Domain the signature is bound to (which contract accepts it, on which chain).
  const domainName = typedData?.domain?.name as string | undefined;
  const verifyingContract = typedData?.domain?.verifyingContract as string | undefined;
  const domainChainId = normalizeChainId(typedData?.domain?.chainId);

  // An ERC-3009 authorization moves money when submitted, so it is shown as a payment.
  // Only a signature from `from` can move those funds: one from any other account is
  // useless, so Sign is turned off. That rule is scoped to ERC-3009 alone.
  const payment = useMemo(() => readErc3009(typedData), [typedData]);
  const paymentFromOther = !!payment && !!accountAddress && payment.from.toLowerCase() !== accountAddress.toLowerCase();

  const appAvatar = <AppAvatar appName={appName} appLogoUrl={appLogoUrl} />;

  const rawTree = typedData ? <Eip712Tree typedData={typedData} /> : null;
  const rawDetails = (
    <details className="text-xs">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer">Show raw details</summary>
      <div className="mt-2">{rawTree}</div>
    </details>
  );

  return (
    <ShellDialog
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!isProcessing}
      // No X once the signature is delivered — there is nothing left to cancel.
      onClose={isSuccess ? undefined : onCancel}
      contentClassName="min-h-[510px]"
    >
      {isSuccess ? (
        // Brief success beat before the parent closes the dialog.
        <SuccessScreen seedAddress={signerAddress} avatarUrl={signerAvatar} />
      ) : isProcessing ? (
        // Signing in progress — passkey ceremony running.
        <ProcessingScreen
          seedAddress={signerAddress}
          avatarUrl={signerAvatar}
          appAvatar={appAvatar}
          title="Signing..."
          subtitle="Confirm with your passkey"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Pinned header */}
          <div className="flex-none px-6 pt-7">
            <DialogAppHeader
              appName={appName}
              appLogoUrl={appLogoUrl}
              origin={origin}
              chainName={chainName}
              chainIcon={chainIcon}
            />
            <AccountHeaderRow
              label="Signing as"
              seedAddress={signerAddress}
              displayName={displayName}
              avatarUrl={signerAvatar}
            />
          </div>

          {/* Scrollable content. Block layout (not flex-col) is deliberate: a flex
                column shrinks its children to fit instead of letting them overflow, so
                the region would never scroll. space-y gives the gaps. */}
          <div ref={scrollRef} className="jaw-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-3 pt-3">
            {!typedData ? (
              <div className="bg-destructive/10 border-destructive/20 rounded-box border p-4">
                <p className="text-destructive text-sm">Failed to parse typed data</p>
              </div>
            ) : payment ? (
              <>
                <Erc3009PaymentView
                  payment={payment}
                  chainId={clearSignedChainId}
                  apiKey={apiKey}
                  mainnetRpcUrl={mainnetRpcUrl}
                  verified={clearSigningLoading ? undefined : !!clearSigned}
                />
                {paymentFromOther && (
                  <WarningNotice
                    messages={[
                      `This payment is from ${formatAddress(payment.from)}, not the account signing. Your signature can't move those funds, so signing is turned off.`,
                    ]}
                  />
                )}
                {rawDetails}
              </>
            ) : clearSigned && clearSigned.rows.length > 0 ? (
              <>
                <ClearSignedView display={clearSigned} chainId={clearSignedChainId} mainnetRpcUrl={mainnetRpcUrl} />
                {rawDetails}
              </>
            ) : (
              rawTree
            )}

            {/* Where the signature goes — verifying contract + the domain's network. */}
            {typedData && (
              <Eip712DomainCard
                domainName={domainName}
                verifyingContract={verifyingContract}
                chainId={domainChainId}
                apiKey={apiKey}
              />
            )}

            {/* ERC-8213 verification digests — only when typed data parsed. */}
            {typedData && <Eip712VerificationDigests typedDataJson={typedDataJson} />}

            {hasError && (
              <div className="bg-destructive/10 border-destructive/20 rounded-box border px-3 py-2">
                <span className="text-destructive break-words text-xs">{signatureStatus}</span>
              </div>
            )}
          </div>

          {/* Pinned actions */}
          <div className="border-border/40 flex-none border-t px-6 pb-5 pt-3">
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
                onClick={onSign}
                // The screen owns this invariant: never offer to sign what it couldn't
                // render, or an ERC-3009 payment from another account, whatever `canSign`
                // a host passes.
                disabled={!canSign || !typedData || paymentFromOther}
                className="rounded-box text-button h-10 flex-[56] font-semibold focus-visible:ring-1"
              >
                Sign
              </Button>
            </div>
          </div>
        </div>
      )}
    </ShellDialog>
  );
};

export * from './types';
