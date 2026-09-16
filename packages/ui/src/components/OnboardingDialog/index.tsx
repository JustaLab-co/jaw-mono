'use client';

import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Skeleton } from '../ui/skeleton';
import { Spinner } from '../ui/spinner';
import { Check, ChevronLeft, ChevronRight, Fingerprint, ScanFace, Users, X } from 'lucide-react';
import { DialogShell } from '../DialogShell';
import { AccountAvatar } from '../AccountAvatar';
import { OnboardingDialogProps, LocalStorageAccount } from './types';
import { selectDefaultAccount } from './selectDefaultAccount';
import { backfillLocalAccountAddresses } from './accountHelpers';
import { useState, useEffect, useMemo, useRef } from 'react';
import { getJustaNameInstance } from '../../utils/justaNameInstance';
import { reverseResolveWithAvatars } from '../../utils/reverseResolve';
import { cn } from '../../lib/utils';
import { toCoinType } from 'viem';

// Props needed by the create form — the create-related subset of OnboardingDialogProps.
type CreateAccountFormProps = Pick<
  OnboardingDialogProps,
  | 'onCreateAccount'
  | 'onAccountCreationComplete'
  | 'onAccountCreationError'
  | 'isCreating'
  | 'ensDomain'
  | 'chainId'
  | 'mainnetRpcUrl'
  | 'apiKey'
  | 'supportedChains'
  | 'subnameTextRecords'
> & {
  /** Primary when create is the main action (sign-up view, or a username draft in progress), secondary otherwise. */
  buttonVariant?: 'default' | 'secondary';
  /** Reports whether the username field has text, so the parent can shift emphasis to Create. */
  onDraftChange?: (hasText: boolean) => void;
};

/**
 * Font-size class for an account name, stepped down by length so long ENS
 * names render in FULL — an ellipsized name misrepresents the identity.
 * `base` is the size used for comfortably short names; truncation remains only
 * as a backstop for pathological lengths (60+ chars).
 *
 * Deliberately raw sizes rather than the design-spec type roles: every role
 * carries a weight, line-height and tracking alongside its size, so stepping
 * through them would also step the weight — a long name would render lighter
 * than a short one. This ladder must change size and nothing else, leaving the
 * caller's own `font-*` intact.
 */
function nameFitClass(name: string, base: string): string {
  if (name.length > 36) return 'text-[9px]';
  if (name.length > 32) return 'text-[10px]';
  if (name.length > 26) return 'text-[11px]';
  if (name.length > 20) return 'text-[13px]';
  return base;
}

/** Hairline divider with a small mono uppercase label ("NEW TO JAW?", "OR"). */
function MonoDivider({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-label font-mono uppercase">{label}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

/**
 * Username input + availability check + Create button + error display.
 * Shared between the fresh sign-in view and the "Create new account" path.
 */
function CreateAccountForm({
  onCreateAccount,
  onAccountCreationComplete,
  onAccountCreationError,
  isCreating,
  ensDomain,
  chainId,
  mainnetRpcUrl,
  apiKey,
  supportedChains,
  subnameTextRecords,
  buttonVariant = 'secondary',
  onDraftChange,
}: CreateAccountFormProps) {
  const [isValid, setIsValid] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [username, setUsername] = useState('');
  const [debouncedUsername, setDebouncedUsername] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Deliberately keyed on the live username, not the debounced one: emphasis must
  // track every keystroke (including backspacing to empty) with zero lag. Trimmed
  // so a stray space doesn't count as create intent. Reset on unmount so a stale
  // draft can't keep Create promoted after the form is gone.
  const hasDraft = username.trim().length > 0;
  useEffect(() => {
    onDraftChange?.(hasDraft);
  }, [hasDraft, onDraftChange]);
  useEffect(() => {
    return () => onDraftChange?.(false);
  }, [onDraftChange]);

  // Debounce username input
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedUsername(username);
    }, 500);
    return () => clearTimeout(handler);
  }, [username]);

  // Validate username and check availability
  useEffect(() => {
    setIsLoading(false);
    setIsValid(false);
    setMessage('');

    if (username.includes('.')) {
      setMessage('Invalid format');
      return;
    }

    if (username.length > 0 && username.length <= 2) {
      setMessage('Minimum 3 characters');
      return;
    }

    if (username.length === 0) {
      return;
    }

    if (!ensDomain) {
      setMessage('Available');
      setIsValid(true);
      return;
    }

    // Only query once the debounce has settled on the current input — while it is
    // pending, debouncedUsername is stale and would fire un-debounced requests for
    // the previous value.
    if (debouncedUsername !== username || !chainId) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setMessage('Checking availability...');

    (async () => {
      try {
        const justaName = getJustaNameInstance(mainnetRpcUrl);
        const result = await justaName.subnames.isSubnameAvailable({
          subname: debouncedUsername + '.' + ensDomain,
          chainId: 1, // ENS offchain subnames must always be issued on Ethereum mainnet (chainId 1)
        });

        if (cancelled) return;
        if (result?.isAvailable) {
          setMessage('Available');
          setIsValid(true);
        } else {
          setMessage('Unavailable');
        }
      } catch (error) {
        if (cancelled) return;
        console.error('Error checking subname availability:', error);
        setMessage('Error checking availability');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    // Superseded checks must not write state: without this, the last response to
    // resolve wins, even when it answers for an older username.
    return () => {
      cancelled = true;
    };
  }, [debouncedUsername, username, ensDomain, chainId, mainnetRpcUrl]);

  // Availability rendered as an inline icon at the input's right edge instead of a
  // text line below, so the layout stays stable while typing. The debounce-pending
  // window counts as 'checking': to the user the check began at the keystroke, and
  // it stops the icon blinking out between debounce and query. Only 'invalid' still
  // gets a text line below — an X alone can't distinguish taken / too short / bad
  // format, and those need different fixes.
  const availabilityStatus: 'idle' | 'checking' | 'available' | 'invalid' = (() => {
    if (username.length === 0) return 'idle';
    if (isValid) return 'available';
    if (isLoading) return 'checking';
    if (message) return 'invalid';
    if (ensDomain && chainId && debouncedUsername !== username) return 'checking';
    return 'idle';
  })();

  const availabilityIcon = availabilityStatus !== 'idle' && (
    // Keyed by status so each swap re-runs the fade-in — no hard tick↔X strobe.
    <span
      key={availabilityStatus}
      role="status"
      className="animate-in fade-in flex items-center duration-150 motion-reduce:animate-none"
    >
      {availabilityStatus === 'checking' && <Spinner className="text-muted-foreground !h-3.5 !w-3.5" />}
      {availabilityStatus === 'available' && <Check className="text-success h-3.5 w-3.5" strokeWidth={3} />}
      {availabilityStatus === 'invalid' && <X className="text-destructive h-3.5 w-3.5" strokeWidth={3} />}
      <span className="sr-only">
        {availabilityStatus === 'checking'
          ? 'Checking availability'
          : availabilityStatus === 'available'
            ? 'Available'
            : message || 'Invalid username'}
      </span>
    </span>
  );

  // The invalid message reveals via an animated height collapse (0fr→1fr grid trick)
  // rather than mounting/unmounting, so the Create button glides instead of jumping.
  // The last message is held in state so the collapse animates with its text still
  // visible — unmounting the text first would blank-flash the closing box.
  const showInvalidMessage = availabilityStatus === 'invalid' && !!message && !error;
  const [displayedMessage, setDisplayedMessage] = useState('');
  useEffect(() => {
    if (showInvalidMessage) setDisplayedMessage(message);
  }, [showInvalidMessage, message]);

  const handleCreateAccountClick = async () => {
    setError(null);

    try {
      const accountData = await onCreateAccount(username);

      if (ensDomain && chainId && apiKey && supportedChains && accountData.address) {
        try {
          const justaName = getJustaNameInstance(mainnetRpcUrl);

          const addresses = supportedChains.map((chain) => ({
            address: accountData.address,
            coinType: toCoinType(chain.id).toString(),
          }));

          // Use subnameTextRecords from capabilities if provided (only used during new account creation)
          // If not provided or empty, use empty array (no text records will be set)
          await justaName.subnames.addSubname(
            {
              username: username,
              ensDomain: ensDomain,
              chainId: 1, // ENS offchain subnames must always be issued on Ethereum mainnet (chainId 1)
              addresses: addresses,
              overrideSignatureCheck: true,
              text: subnameTextRecords && subnameTextRecords.length > 0 ? subnameTextRecords : [],
            },
            {
              xApiKey: apiKey,
              xAddress: accountData.address,
              xMessage: '',
            }
          );
        } catch (subnameError) {
          const errorMessage = `Failed to register subname: ${subnameError instanceof Error ? subnameError.message : 'Unknown error'}`;
          console.error('❌ SUBNAME ERROR:', errorMessage, subnameError);
          setError(errorMessage);
          onAccountCreationError?.(subnameError);
          return; // Don't complete if subname registration fails
        }
      }

      // Pass account data through to completion handler
      await onAccountCreationComplete(accountData);
    } catch (error) {
      const errorMessage = `Account creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error('❌ ACCOUNT CREATION ERROR:', errorMessage, error);
      setError(errorMessage);
      onAccountCreationError?.(error);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        // `md:text-body` too: the Input primitive ships `md:text-sm`, and tailwind-merge keeps a
        // modifier-prefixed class in its own group, so the bare role loses above 768px.
        className="bg-muted rounded-box text-body md:text-body h-11 font-mono"
        // Prevent password-manager extensions (1Password, LastPass, Dashlane,
        // Bitwarden) from attaching their inline overlay to this field. Their
        // overlay covers the embedded iframe, which the clickjacking guard
        // (EnsureVisibility) then reads as occlusion and disables interaction.
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        data-bwignore
        right={
          ensDomain || availabilityIcon ? (
            <span className="flex items-center gap-2">
              {ensDomain && <span className="text-muted-foreground font-mono text-xs">{`.${ensDomain}`}</span>}
              {availabilityIcon}
            </span>
          ) : undefined
        }
      />
      {/* -mt-2 cancels the parent's gap-2 while collapsed, so the input→button
          rhythm is identical to having no message row at all. */}
      <div
        aria-hidden={!showInvalidMessage}
        className={cn(
          '-mt-2 grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          showInvalidMessage ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <span className="text-destructive block px-1 pt-1 text-xs font-medium">{displayedMessage}</span>
        </div>
      </div>
      {isCreating ? (
        <div className="flex h-11 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <Button
          variant={buttonVariant}
          onClick={async () => {
            try {
              await handleCreateAccountClick();
            } catch (err) {
              console.error('❌ Button onClick caught error:', err);
            }
          }}
          disabled={!isValid || isLoading}
          className="rounded-box text-button h-11 w-full font-semibold"
        >
          <ScanFace className="!h-4 !w-4" />
          Create Account
        </Button>
      )}
      {error && (
        <div className="bg-destructive/10 border-destructive/20 flex flex-col gap-2 overflow-hidden rounded-md border px-2 py-2">
          <span className="text-destructive break-all text-xs font-medium">{error}</span>
          <Button
            onClick={() => setError(null)}
            variant="ghost"
            className="text-destructive hover:text-destructive/80 hover:bg-destructive/10 h-6 text-xs"
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

// 'signin' and 'signup' are the same screen with intent-swapped emphasis:
// sign-in leads with the passkey button, sign-up leads with the create form.
type OnboardingView = 'welcome' | 'signin' | 'signup';

export function OnboardingDialog({
  accounts,
  onAccountSelect,
  loggingInAccount,
  onImportAccount,
  isImporting,
  onCreateNewAccount,
  startInCreate,
  onClose,
  onCreateAccount,
  onAccountCreationComplete,
  onAccountCreationError,
  isCreating,
  ensDomain,
  chainId,
  mainnetRpcUrl,
  apiKey,
  supportedChains,
  subnameTextRecords,
  lastAuthenticatedCredentialId,
}: OnboardingDialogProps) {
  const defaultAccount = useMemo(
    () => selectDefaultAccount(accounts, lastAuthenticatedCredentialId),
    [accounts, lastAuthenticatedCredentialId]
  );

  const [view, setView] = useState<OnboardingView>(startInCreate ? 'signup' : defaultAccount ? 'welcome' : 'signin');
  const isBusy = loggingInAccount !== null || isImporting || isCreating;

  // Addresses for the switch-account chips and avatar resolution. New records
  // carry them; legacy records get a one-time ceremony-free factory derivation,
  // persisted back so subsequent opens are pure localStorage reads.
  const [addressByCredentialId, setAddressByCredentialId] = useState<Record<string, string>>({});
  const [backfillInFlight, setBackfillInFlight] = useState(false);
  const hasAddressGaps = accounts.some((a) => !a.address && a.credentialId);
  useEffect(() => {
    if (!hasAddressGaps) return;
    let cancelled = false;
    setBackfillInFlight(true);
    backfillLocalAccountAddresses({ chainId, apiKey })
      .then((byCredentialId) => {
        if (!cancelled) setAddressByCredentialId(byCredentialId);
      })
      .catch(() => {
        // Rows simply render without an address chip
      })
      .finally(() => {
        if (!cancelled) setBackfillInFlight(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasAddressGaps, chainId, apiKey]);
  const addressOf = (account: LocalStorageAccount) =>
    account.address ?? (account.credentialId ? addressByCredentialId[account.credentialId] : undefined);

  const [identityByAddress, setIdentityByAddress] = useState<Record<string, { name: string; avatar?: string }>>({});
  const [settledAddresses, setSettledAddresses] = useState<ReadonlySet<string>>(new Set());
  const attemptedAvatarsRef = useRef<Set<string>>(new Set());
  const knownAddresses = accounts
    .map((account) => addressOf(account)?.toLowerCase())
    .filter((address): address is string => !!address);
  const knownAddressKey = [...new Set(knownAddresses)].sort().join(',');
  useEffect(() => {
    const unique = knownAddressKey.split(',').filter((a) => a && !attemptedAvatarsRef.current.has(a));
    if (unique.length === 0) return;
    unique.forEach((address) => attemptedAvatarsRef.current.add(address));

    let cancelled = false;
    reverseResolveWithAvatars(
      unique.map((address) => ({ address, chainId: 1 })),
      mainnetRpcUrl
    )
      .then((resolved) => {
        if (cancelled) return;
        const next: Record<string, { name: string; avatar?: string }> = {};
        for (const address of unique) {
          const identity = resolved[address];
          if (identity?.name) next[address] = { name: identity.name, avatar: identity.avatar };
        }
        if (Object.keys(next).length > 0) {
          setIdentityByAddress((prev) => ({ ...prev, ...next }));
        }
        setSettledAddresses((prev) => new Set([...prev, ...unique]));
      })
      .catch(() => {
        // Blobs remain — but the addresses are settled, stop the skeleton
        setSettledAddresses((prev) => new Set([...prev, ...unique]));
      });
    return () => {
      cancelled = true;
      unique.forEach((address) => attemptedAvatarsRef.current.delete(address));
    };
    // chainId is intentionally omitted: ENS always resolves on mainnet (chainId 1
    // is hardcoded above), so a dApp chain switch must not re-fire this fetch.
  }, [knownAddressKey, mainnetRpcUrl]);
  const identityOf = (account: LocalStorageAccount) => {
    const address = addressOf(account);
    return address ? identityByAddress[address.toLowerCase()] : undefined;
  };
  const avatarFor = (account: LocalStorageAccount) => identityOf(account)?.avatar;
  const displayNameOf = (account: LocalStorageAccount) => identityOf(account)?.name ?? account.username;
  /**
   * True while this account's final identity is still unknown: either its
   * address is being backfilled, or the address's reverse resolution hasn't
   * settled. Drives the skeleton so the tile reveals once, without the
   * blob→avatar / username→name flip.
   */
  const identityPending = (account: LocalStorageAccount) => {
    const address = addressOf(account);
    if (address) return !settledAddresses.has(address.toLowerCase());
    return backfillInFlight && !!account.credentialId;
  };

  // Sign-up intent flips the screen's emphasis: create on top as the primary
  // action, passkey sign-in demoted to a secondary escape hatch below.
  const isSignUp = view === 'signup';

  // Typing a username on the sign-in view is the same declaration of intent, so
  // it promotes Create too — variant swap only, layout order never changes.
  // Emptying the field (backspace, clear) reverts instantly.
  const [hasCreateDraft, setHasCreateDraft] = useState(false);
  const promoteCreate = isSignUp || hasCreateDraft;

  const createForm = (
    <CreateAccountForm
      onCreateAccount={onCreateAccount}
      onAccountCreationComplete={onAccountCreationComplete}
      onAccountCreationError={onAccountCreationError}
      isCreating={isCreating}
      ensDomain={ensDomain}
      chainId={chainId}
      mainnetRpcUrl={mainnetRpcUrl}
      apiKey={apiKey}
      supportedChains={supportedChains}
      subnameTextRecords={subnameTextRecords}
      buttonVariant={promoteCreate ? 'default' : 'secondary'}
      onDraftChange={setHasCreateDraft}
    />
  );

  const passkeyButton = (
    <Button
      onClick={onImportAccount}
      disabled={isBusy}
      variant={promoteCreate ? 'secondary' : 'default'}
      className="rounded-box text-button h-11 w-full font-semibold"
    >
      <Fingerprint className="!h-4 !w-4" />
      {isImporting ? 'Opening Passkey...' : 'Sign in'}
    </Button>
  );

  // Fresh sign-in / create view — also the "Create new account" destination.
  if (view !== 'welcome' || !defaultAccount) {
    return (
      <DialogShell onClose={isBusy ? undefined : onClose}>
        <div className="flex flex-col p-6">
          {defaultAccount && (
            // Top-left escape back to the welcome view, styled as the dialog's
            // mono uppercase label language. -ml-1 optically aligns the chevron
            // with the title's left edge.
            <button
              onClick={() => setView('welcome')}
              disabled={isBusy}
              className="text-muted-foreground hover:text-foreground text-label -ml-1 mb-4 flex w-fit cursor-pointer items-center gap-1 bg-transparent font-mono uppercase transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </button>
          )}
          <h2 className="text-foreground text-title-xl leading-none">Sign {isSignUp ? 'up.' : 'in.'}</h2>
          <p className="text-muted-foreground text-body mt-2">
            {isSignUp ? 'Pick a username to create your account.' : 'Use a saved passkey, or create a new account.'}
          </p>

          {isSignUp ? (
            <>
              <div className="mt-6">{createForm}</div>
              <MonoDivider label="Already have an account?" className="my-5" />
              {passkeyButton}
            </>
          ) : (
            <>
              <div className="mt-6">{passkeyButton}</div>
              <MonoDivider label="New to JAW?" className="my-5" />
              {createForm}
            </>
          )}
        </div>
      </DialogShell>
    );
  }

  // Welcome-back view — one-tap continue with the last account.
  return (
    <DialogShell onClose={isBusy ? undefined : onClose}>
      <div className="flex flex-col p-6">
        <h2 className="text-foreground text-title-xl leading-none">Welcome back.</h2>
        <p className="text-muted-foreground text-body mt-2">Pick up where you left off.</p>

        <button
          onClick={() => onAccountSelect(defaultAccount)}
          disabled={isBusy}
          className="bg-primary hover:bg-primary/90 rounded-box mt-6 flex cursor-pointer items-center gap-3 p-3 text-left transition-colors disabled:cursor-default disabled:opacity-70"
        >
          {identityPending(defaultAccount) ? (
            // Skeleton until the identity settles — one reveal, no
            // blob→avatar / username→name flip.
            <>
              {/* bg override: the default bg-accent token is near-invisible on this white tile */}
              <Skeleton className="bg-primary-foreground/10 rounded-box h-10 w-10 flex-none" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-primary-foreground/60 text-label font-mono uppercase">Last used</span>
                <Skeleton className="bg-primary-foreground/10 rounded-xs h-3.5 w-36" />
              </span>
            </>
          ) : (
            <>
              {/* Seed by address (matching the signing pills) so the same account shows
                  the same identicon everywhere; fall back to username for older records
                  that predate address persistence. */}
              <AccountAvatar
                seed={defaultAccount.address ?? defaultAccount.username}
                avatarUrl={avatarFor(defaultAccount)}
                size={40}
                className="rounded-box h-10 w-10"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-primary-foreground/60 text-label font-mono uppercase">Last used</span>
                <span
                  className={cn(
                    'text-primary-foreground truncate font-semibold',
                    nameFitClass(displayNameOf(defaultAccount), 'text-[15px]')
                  )}
                >
                  {displayNameOf(defaultAccount) || 'your account'}
                </span>
              </span>
            </>
          )}
          {loggingInAccount === defaultAccount.username ? (
            <Spinner className="text-primary-foreground !h-4 !w-4" />
          ) : (
            <ChevronRight className="text-primary-foreground/70 h-4 w-4 flex-none" />
          )}
        </button>

        <MonoDivider label="or" className="my-5" />

        <Button
          onClick={onImportAccount}
          disabled={isBusy}
          variant="secondary"
          className="rounded-box text-button h-11 w-full font-semibold"
        >
          <Users className="!h-4 !w-4" />
          {isImporting ? 'Opening Passkey...' : 'Show more accounts'}
        </Button>

        <button
          onClick={onCreateNewAccount ?? (() => setView('signup'))}
          disabled={isBusy}
          className="text-muted-foreground hover:text-foreground mx-auto mt-4 cursor-pointer bg-transparent text-xs font-medium transition-colors"
        >
          Create new account
        </button>
      </div>
    </DialogShell>
  );
}

export * from './types';
export * from './accountHelpers';
