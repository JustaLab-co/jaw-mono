'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ShellDialog } from '../ShellDialog';
import { DialogAppHeader } from '../DialogAppHeader';
import { AccountHeaderRow } from '../AccountHeaderRow';
import { ProcessingScreen } from '../ProcessingScreen';
import { SuccessScreen } from '../SuccessScreen';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { SiweDialogProps } from './types';
import { isRequestCode } from './requestCode';
import { SUPPORTED_CHAINS } from '@jaw.id/core';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import { dateTone } from '../../utils/displayFormat';
import { bestEffortSiweAddress, parseSiweMessage } from '../../utils/siwe';
import { formatAddress } from '../../utils/formatAddress';
import { AppAvatar } from '../AppAvatar';
import { CopyButton } from '../CopyButton';
import { TriangleAlert } from 'lucide-react';

/**
 * One label/value row. Pass `copyValue` for a copy button; pass `warning` to flag the row
 * with a hover-only danger icon (and tint the value) — `warningTone` picks destructive vs warning.
 */
function Field({
  label,
  value,
  copyValue,
  warning,
  warningTone = 'danger',
}: {
  label: string;
  value: string;
  copyValue?: string;
  warning?: string;
  warningTone?: 'danger' | 'warning';
}) {
  const warnText = warningTone === 'warning' ? 'text-warning' : 'text-destructive';
  const warnIcon = warningTone === 'warning' ? 'text-warning' : 'text-destructive';
  return (
    <div className="border-border/40 flex items-center justify-between gap-3 border-t px-3 py-2 first:border-t-0">
      <span className="text-muted-foreground text-label flex-none font-mono uppercase">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5">
        {warning && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Hover-only (no tabIndex): a focusable trigger would auto-open when the
                  dialog moves focus in on mount. aria-label keeps the text for SRs. */}
              <span aria-label={warning} className="flex-none cursor-help">
                <TriangleAlert className={`size-3 ${warnIcon}`} strokeWidth={2} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{warning}</TooltipContent>
          </Tooltip>
        )}
        <span
          className={`text-body-xs min-w-0 break-all text-right font-mono font-medium ${warning ? warnText : 'text-foreground'}`}
        >
          {value}
        </span>
        {copyValue && (
          <CopyButton value={copyValue} size={12} resetAfterMs={1500} label={`Copy ${label.toLowerCase()}`} />
        )}
      </span>
    </div>
  );
}

export const SiweDialog = ({
  open,
  onOpenChange,
  message,
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
  siweStatus,
  canSign,
  warningMessage,
  requestCodeHint,
}: SiweDialogProps) => {
  const parsed = useMemo(() => parseSiweMessage(message), [message]);
  // Falls back to a shape-checked read when the parse fails. Without it the mismatch advisory below
  // silently evaluates to false on a message that detects as SIWE but doesn't parse — and the dapp
  // writes the message, so it would choose whether the advisory appears.
  const declaredAddress = useMemo(() => parsed?.address ?? bestEffortSiweAddress(message), [parsed, message]);

  // "Sign In as" = the CONNECTED account (whose key signs) — safe to reverse-resolve to an
  // ENS name + avatar. The MESSAGE's declared address is resolved separately for the
  // Account row (forward-verified); the mismatch warning fires when the two differ.
  const signerAddress = accountAddress ?? '';
  const { name: resolvedName, avatar: avatarUrl } = useReverseIdentity(
    signerAddress || undefined,
    chainId,
    mainnetRpcUrl
  );
  const displayName = resolvedName || formatAddress(signerAddress);
  const { name: messageAccountName } = useReverseIdentity(declaredAddress || undefined, parsed?.chainId, mainnetRpcUrl);
  const hasError = siweStatus.includes('Error');

  // The message names an account; the signature is produced by the connected
  // account. If they differ, the signature won't verify for the named account —
  // surface it (advisory, not a hard gate).
  const addressMismatch =
    !!accountAddress && !!declaredAddress && accountAddress.toLowerCase() !== declaredAddress.toLowerCase();

  // EIP-4361 requires the nonce to be at least 8 alphanumeric chars; a shorter one
  // means the site's replay protection is weak. Advisory (warning), not a hard gate.
  const weakNonce = !!parsed?.nonce && parsed.nonce.length < 8;

  // Only an already-expired sign-in is worth flagging (its signature can't be used). A
  // missing or long-lived expiry isn't a risk on its own — SIWE replay protection is the
  // nonce — so we don't warn on those; it'd fire on the common case and dull the warnings
  // that matter.
  const expiresSec = parsed?.expirationTime ? Math.floor(Date.parse(parsed.expirationTime) / 1000) : null;
  const expiryTone = expiresSec !== null && !Number.isNaN(expiresSec) ? dateTone(String(expiresSec)) : null;

  // Looked like SIWE but didn't parse → no advisories ran, and the origin check is
  // parse-gated upstream so it didn't either. Surface the gap rather than a blind Sign In.
  const parseFailed = !parsed;

  // Shown as written, never trimmed: a whitespace-only id is treated as absent, and one with
  // stray spaces fails the code pattern and lands in a plain row with its spaces.
  const requestId = parsed?.requestId?.trim() ? parsed.requestId : undefined;
  const requestCode = requestId && isRequestCode(requestId) ? requestId : undefined;

  // Require a fresh acknowledgement of the phishing warning for every request.
  const ackId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [message, warningMessage]);

  // Radix modal eats native wheel scroll of a nested container — drive it manually.
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
    // Re-attach on isSuccess too (success view changes scroll height), like Eip712.
  }, [open, isProcessing, isSuccess, parsed]);

  const appAvatar = <AppAvatar appName={appName} appLogoUrl={appLogoUrl} />;

  // Parsed SIWE fields → the row-wise box (only rows with a value).
  const fields: Array<{
    label: string;
    value: string;
    copyValue?: string;
    warning?: string;
    warningTone?: 'danger' | 'warning';
  }> = [];
  // The Account row is built from `declaredAddress`, so it survives a failed parse — otherwise the
  // mismatch advisory would compute correctly and then have nowhere to render, which is how it went
  // missing before. Everything below it still requires a parse: those values are only trustworthy
  // when the whole message read cleanly.
  if (declaredAddress)
    fields.push({
      label: 'Account',
      value: messageAccountName || formatAddress(declaredAddress),
      copyValue: declaredAddress,
      warning: addressMismatch
        ? "This request names a different account than the one you're connected with, so the signature won't be valid for it."
        : undefined,
    });
  if (parsed) {
    if (parsed.uri) fields.push({ label: 'URL', value: parsed.uri });
    if (parsed.version) fields.push({ label: 'Version', value: parsed.version });
    if (parsed.chainId) {
      // Resolve the name from the MESSAGE's chainId (what's being signed), not the
      // connected chain — otherwise "Chain ID: 1" wrongly reads as the wallet's chain.
      const name = SUPPORTED_CHAINS.find((c) => c.id === parsed.chainId)?.name;
      fields.push({ label: 'Chain ID', value: name ? `${parsed.chainId} · ${name}` : String(parsed.chainId) });
    }
    if (parsed.nonce)
      fields.push({
        label: 'Nonce',
        value: parsed.nonce,
        warning: weakNonce
          ? `Short nonce (${parsed.nonce.length} chars). EIP-4361 recommends at least 8 — weak replay protection.`
          : undefined,
        warningTone: 'warning',
      });
    if (parsed.issuedAt) fields.push({ label: 'Issued at', value: parsed.issuedAt });
    // Surface the expiration as data when present. Only an already-expired one is flagged
    // (red icon + hover note on the row) — a long/absent expiry isn't a risk on its own.
    if (parsed.expirationTime)
      fields.push({
        label: 'Expires',
        value: parsed.expirationTime,
        warning:
          expiryTone === 'expired' ? "This sign-in has already expired, so the signature can't be used." : undefined,
      });
    if (parsed.notBefore) fields.push({ label: 'Not before', value: parsed.notBefore });
    if (requestId && !requestCode) fields.push({ label: 'Request ID', value: requestId });
  }

  return (
    <ShellDialog
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!isProcessing}
      // No X once the sign-in is delivered — there is nothing left to cancel.
      onClose={isSuccess ? undefined : onCancel}
      contentClassName="min-h-[510px]"
    >
      {isSuccess ? (
        <SuccessScreen seedAddress={signerAddress} avatarUrl={avatarUrl} label="Signed in" />
      ) : isProcessing ? (
        <ProcessingScreen
          seedAddress={signerAddress}
          avatarUrl={avatarUrl}
          appAvatar={appAvatar}
          title="Signing in..."
          subtitle="Confirm with your passkey"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Pinned header */}
          <div className="flex-none px-6 pt-6">
            <DialogAppHeader
              appName={appName}
              appLogoUrl={appLogoUrl}
              origin={origin}
              chainName={chainName}
              chainIcon={chainIcon}
            />
            <AccountHeaderRow
              label="Sign In as"
              seedAddress={signerAddress}
              displayName={displayName}
              avatarUrl={avatarUrl}
            />
            {/* Generic wallet-chrome line describing the action. The dApp's own
                statement text is NOT shown here — it goes in a quarantined,
                labelled box in the scroll area so it can't masquerade as chrome. */}
            <p className="text-muted-foreground text-body-xs mt-2 pl-3 leading-normal">
              A site wants you to sign in to prove you own this account.
            </p>
          </div>

          {/* Scrollable content (block layout so children overflow, not shrink). */}
          <div ref={scrollRef} className="jaw-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-3 pt-3">
            {/* Unparseable → no checks ran; tell the user plainly, raw message shown below. */}
            {parseFailed && (
              <div className="border-destructive/30 bg-destructive/10 rounded-box flex items-start gap-2 border p-3">
                {/* mt-0.5: optical nudge onto the first text line, not spacing rhythm. */}
                <TriangleAlert className="text-destructive mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={2} />
                <p className="text-destructive text-body-sm min-w-0">
                  We couldn't read the full sign-in request. Review the raw message below carefully before signing.
                </p>
              </div>
            )}

            {/* A short request id, large, so a person can match it against a code shown
                elsewhere. The dApp writes it, so it is labelled as the request's own value;
                the line asking for a match only shows where the caller has a page to match. */}
            {requestCode && (
              <div className="border-border rounded-box border p-3 text-center">
                <span className="text-muted-foreground text-label font-mono uppercase">Request code</span>
                <p className="text-foreground text-title mt-1 font-mono font-semibold tracking-widest">{requestCode}</p>
                {requestCodeHint && !warningMessage && (
                  <p className="text-muted-foreground text-body-xs mt-1 leading-normal">
                    Check it matches the code on the page that sent you here.
                  </p>
                )}
              </div>
            )}

            {/* The dApp's statement, quarantined in its own box so this
                attacker-supplied text is unmistakably content, never chrome. */}
            {parsed?.statement && (
              <div className="border-border bg-foreground/[0.03] rounded-box border p-3">
                <p className="text-foreground text-body-sm whitespace-pre-wrap break-words leading-normal">
                  {parsed.statement}
                </p>
              </div>
            )}

            {fields.length > 0 ? (
              <div className="border-border rounded-box overflow-hidden border">
                {fields.map((f) => (
                  <Field
                    key={f.label}
                    label={f.label}
                    value={f.value}
                    copyValue={f.copyValue}
                    warning={f.warning}
                    warningTone={f.warningTone}
                  />
                ))}
              </div>
            ) : (
              // Fallback: message didn't parse as SIWE — show it raw.
              <div className="border-border rounded-box border p-3">
                <p className="text-foreground text-body-xs whitespace-pre-wrap break-words font-mono leading-relaxed">
                  {message || 'No message provided'}
                </p>
              </div>
            )}

            {/* Resources — ReCap/EIP-5573 capability grants the signature authorizes.
                Security-relevant, so listed explicitly rather than hidden. */}
            {parsed?.resources && parsed.resources.length > 0 && (
              <div className="border-border rounded-box border p-3">
                <span className="text-muted-foreground text-label font-mono uppercase">Resources</span>
                <div className="mt-2 flex flex-col gap-1">
                  {parsed.resources.map((r, i) => (
                    <span key={i} className="text-foreground text-body-xs break-all font-mono leading-normal">
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Raw message under a disclosure (canvas: "Message text"). */}
            {fields.length > 0 && (
              <details className="border-border rounded-chip group overflow-hidden border [&_summary::-webkit-details-marker]:hidden">
                <summary className="hover:bg-foreground/[0.03] flex cursor-pointer list-none items-center justify-between px-3 py-2">
                  <span className="text-muted-foreground text-body-sm font-medium">Message text</span>
                  <svg
                    className="text-muted-foreground h-3 w-3 transition-transform group-open:rotate-180"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </summary>
                <div className="border-border/40 border-t p-3">
                  <p className="text-muted-foreground text-code whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {message}
                  </p>
                </div>
              </details>
            )}

            {hasError && (
              <div className="bg-destructive/10 border-destructive/20 rounded-box border px-3 py-2">
                <span className="text-destructive break-words text-xs">{siweStatus}</span>
              </div>
            )}

            {/* Phishing warning + acknowledgement gate (error state). In the scroll
                  flow — below the expandable message, not pinned over it. */}
            {warningMessage && (
              <div className="border-destructive/30 bg-destructive/10 rounded-box border p-3">
                <div className="flex items-start gap-2">
                  {/* mt-0.5: optical nudge onto the first text line, not spacing rhythm. */}
                  <TriangleAlert className="text-destructive mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={2} />
                  <p className="text-destructive text-body-sm min-w-0">{warningMessage}</p>
                </div>
                <label htmlFor={ackId} className="mt-3 flex cursor-pointer items-center gap-2">
                  <Checkbox
                    id={ackId}
                    checked={acknowledged}
                    onCheckedChange={(checked) => setAcknowledged(checked === true)}
                    // The primitive's border-input is near-white in light mode and vanishes
                    // on this red-tinted box — theme the control destructive, with an opaque
                    // base fill so the unchecked box reads clearly on the tint.
                    className="bg-background border-destructive/60 data-[state=checked]:border-destructive data-[state=checked]:bg-destructive data-[state=checked]:text-destructive-foreground dark:data-[state=checked]:bg-destructive"
                  />
                  <span className="text-destructive text-body-sm font-medium">I accept the risk</span>
                </label>
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
                disabled={!canSign || (!!warningMessage && !acknowledged)}
                className="rounded-box text-button h-10 flex-[56] font-semibold focus-visible:ring-1"
              >
                Sign In
              </Button>
            </div>
          </div>
        </div>
      )}
    </ShellDialog>
  );
};

export * from './types';
