'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ScanFace } from 'lucide-react';
import { getAddress, isAddress, type Address } from 'viem';
import { getRecoveryConfig, minimumRecoveryDelay, type RecoveryChainConfig } from '@jaw.id/core';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Spinner } from '../ui/spinner';
import { ShellDialog } from '../ShellDialog';
import { ProcessingScreen } from '../ProcessingScreen';
import { AppAvatar } from '../AppAvatar';
import { AccountAvatar } from '../AccountAvatar';
import {
  Badge,
  NetworkIcon,
  RecoveryFact,
  RecoveryNotice,
  SectionHeading,
  chainName,
} from '../RecoveryDialog/Sections';
import { cn } from '../../lib/utils';
import { useChainIcons } from '../../hooks/useChainIcons';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import { useRecoveryRequest } from '../../hooks/useRecoveryRequest';
import { formatAddress } from '../../utils/formatAddress';
import { resolveEnsToAddress } from '../../utils/ensResolve';
import { formatRecoveryDelay } from '../../utils/recoverySetup';
import { recoveryOnNetworks } from '../../utils/recoveryRequest';
import { RecoveryStatus } from './RecoveryStatus';
import { RecoveryBackButton, RecoveryScreen, RecoveryScreenTitle } from './RecoveryScreen';
import type { RecoveryStartDialogProps } from './types';

/** Names are resolved and shown from mainnet: a recovery is account-level, on every network. */
const NAME_CHAIN_ID = 1;
const LOOKUP_DEBOUNCE_MS = 400;

type AccountLookup =
  | { state: 'idle' }
  | { state: 'looking' }
  | { state: 'not-found' }
  | { state: 'failed' }
  | { state: 'found'; address: Address; name: string | null; networks: RecoveryChainConfig[] };

/** A hex address or something that reads as an ENS name: the inputs worth looking up. */
function lookupable(query: string): boolean {
  return isAddress(query, { strict: false }) || query.includes('.');
}

/**
 * The account a name or an address points at, and the networks where it can be recovered. A name
 * resolves on mainnet; the networks come from the backend's live read (`getRecoveryConfig`),
 * which `Account.startRecovery` makes again before any prompt.
 */
function useRecoveryAccount(
  input: string,
  apiKey: string | undefined,
  mainnetRpcUrl: string,
  immediate: boolean
): AccountLookup {
  const query = input.trim().toLowerCase();
  const [settled, setSettled] = useState(immediate ? query : '');
  useEffect(() => {
    if (immediate) {
      setSettled(query);
      return;
    }
    const timer = setTimeout(() => setSettled(query), LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, immediate]);

  const [lookup, setLookup] = useState<AccountLookup>({ state: 'idle' });
  useEffect(() => {
    if (!lookupable(settled)) {
      setLookup({ state: 'idle' });
      return;
    }
    const isName = !isAddress(settled, { strict: false });
    let cancelled = false;
    setLookup({ state: 'looking' });
    (async () => {
      let address: Address;
      try {
        address = getAddress(isName ? await resolveEnsToAddress(settled, NAME_CHAIN_ID, mainnetRpcUrl) : settled);
      } catch {
        if (!cancelled) setLookup({ state: 'not-found' });
        return;
      }
      try {
        const { chains } = await getRecoveryConfig(address, apiKey);
        if (cancelled) return;
        setLookup({ state: 'found', address, name: isName ? settled : null, networks: recoveryOnNetworks(chains) });
      } catch {
        if (!cancelled) setLookup({ state: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settled, apiKey, mainnetRpcUrl]);

  // While the text is ahead of the last lookup, what is on screen answers older text.
  if (query !== settled && lookupable(query)) return { state: 'looking' };
  return lookup;
}

/**
 * The recovering user's screens: find the account by its name or address, review what a new
 * passkey for it means, create the passkey and open the request, then follow it. The new passkey
 * is an owner only once enough guardians approve and the wait passes, so nothing here signs.
 *
 * The account shown on the review screen is exactly the one `onStart` gets: it is never looked up
 * again in between.
 */
export const RecoveryStartDialog = ({
  open,
  onOpenChange,
  account,
  approveUrl,
  appName,
  appLogoUrl,
  apiKey,
  mainnetRpcUrl,
  onStart,
  isStarting,
  error,
  requestId,
  onBack,
  onClose,
  onDone,
  onStartAgain,
  onOpenAccount,
  isOpeningAccount = false,
  chainId,
}: RecoveryStartDialogProps) => {
  const inputId = useId();
  const [step, setStep] = useState<'find' | 'review'>(account ? 'review' : 'find');
  const [query, setQuery] = useState('');

  const lookup = useRecoveryAccount(account ?? query, apiKey, mainnetRpcUrl, !!account);
  const found = lookup.state === 'found' ? lookup : null;
  const reverse = useReverseIdentity(found?.address, NAME_CHAIN_ID, mainnetRpcUrl);
  const name = found ? (found.name ?? reverse.name) : null;
  const recoveryOn = !!found && found.networks.length > 0;

  const request = useRecoveryRequest(requestId, apiKey);
  const busy = isStarting || isOpeningAccount;

  const accountCard = found && (
    <AccountCard
      address={found.address}
      name={name}
      avatar={reverse.avatar}
      badge={step === 'find' && recoveryOn ? <Badge tone="success">Recovery on</Badge> : null}
    />
  );
  const notSetUp = found && !recoveryOn && (
    <RecoveryNotice tone="warning" title="Recovery isn’t set up for this account" />
  );

  const renderFind = () => (
    <RecoveryScreen
      footerBorder={false}
      footer={
        <>
          <p className="text-muted-foreground text-body-sm pb-1 text-center">
            Already started? Sign in with your new passkey to see where it stands.
          </p>
          <Button
            onClick={() => setStep('review')}
            disabled={!recoveryOn}
            className="rounded-box text-button h-11 w-full font-semibold focus-visible:ring-1"
          >
            Continue
          </Button>
        </>
      }
    >
      {onBack && <RecoveryBackButton onClick={onBack} />}
      <RecoveryScreenTitle title="Recover your account.">
        Your guardians can approve a new passkey for it. Start with the account’s name or address.
      </RecoveryScreenTitle>

      <div className="flex flex-col gap-2 pt-3">
        <label htmlFor={inputId} className="text-muted-foreground text-label block font-mono uppercase">
          Account
        </label>
        <Input
          id={inputId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or address"
          // `md:text-body` too: the Input primitive ships `md:text-sm`, and tailwind-merge keeps a
          // modifier-prefixed class in its own group, so the bare role loses above 768px.
          className="bg-muted rounded-box text-body md:text-body h-11"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          // Keep password-manager overlays off the field, as the sign-in screen does: in the keys
          // iframe an overlay reads as occlusion to the clickjacking guard.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          data-bwignore
          right={
            lookup.state === 'looking' ? (
              <span role="status" className="flex items-center">
                <Spinner className="text-muted-foreground !h-3.5 !w-3.5" />
                <span className="sr-only">Looking up the account</span>
              </span>
            ) : undefined
          }
        />
      </div>

      {accountCard}
      {notSetUp}
      {lookup.state === 'not-found' && (
        <p className="text-destructive dark:text-negative text-body-sm px-1 font-medium">
          No account found for this name.
        </p>
      )}
      {lookup.state === 'failed' && (
        <p className="text-destructive dark:text-negative text-body-sm px-1 font-medium">
          This account couldn’t be checked. Try again.
        </p>
      )}
    </RecoveryScreen>
  );

  const renderReview = () => {
    const back = account ? onBack : () => setStep('find');
    return (
      <RecoveryScreen
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={onBack ?? onClose}
              className="rounded-box text-button h-11 flex-[44] font-semibold focus-visible:ring-1"
            >
              Cancel
            </Button>
            <Button
              onClick={() => found && onStart(found.address, name ?? formatAddress(found.address))}
              disabled={!recoveryOn || busy}
              className="rounded-box text-button h-11 flex-[56] font-semibold focus-visible:ring-1"
            >
              <ScanFace className="!h-4 !w-4" />
              Create new passkey
            </Button>
          </div>
        }
      >
        {back && <RecoveryBackButton onClick={back} />}
        <RecoveryScreenTitle title="New key, same account.">
          Your lost passkey can’t be brought back, so you’ll make a new one on this device. Your account and everything
          in it stays put.
        </RecoveryScreenTitle>

        {!found ? (
          <div className="flex min-h-[200px] items-center justify-center">
            {lookup.state === 'looking' || lookup.state === 'idle' ? (
              <Spinner className="size-5" />
            ) : (
              <p className="text-destructive dark:text-negative text-body-sm font-medium">
                This account couldn’t be checked. Try again.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 pt-2">
              <SectionHeading label="Account" />
              {accountCard}
            </div>
            {recoveryOn ? (
              <div className="flex flex-col gap-2">
                <SectionHeading label="Recovery" />
                <RecoveryTermsCard networks={found.networks} apiKey={apiKey} />
              </div>
            ) : (
              notSetUp
            )}
          </>
        )}

        <RecoveryNotice tone="info">
          Nothing changes until your guardians approve and the wait passes. If you find your old passkey, it can cancel
          this.
        </RecoveryNotice>

        {error && (
          <div className="bg-destructive/10 rounded-box p-3">
            <p className="text-destructive dark:text-negative text-body">{error}</p>
          </div>
        )}
      </RecoveryScreen>
    );
  };

  return (
    <ShellDialog
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!busy}
      onClose={onClose}
      contentClassName="min-h-[510px]"
    >
      {requestId ? (
        <RecoveryStatus
          ceremony={request.ceremony}
          failed={request.failed}
          approveUrl={approveUrl}
          apiKey={apiKey}
          mainnetRpcUrl={mainnetRpcUrl}
          onDone={onDone}
          onStartAgain={onStartAgain}
          onOpenAccount={onOpenAccount}
          isOpeningAccount={isOpeningAccount}
          chainId={chainId}
        />
      ) : isStarting ? (
        <ProcessingScreen
          seedAddress={found?.address ?? account ?? ''}
          avatarUrl={reverse.avatar}
          appAvatar={<AppAvatar appName={appName} appLogoUrl={appLogoUrl} />}
          title="Creating your new passkey"
          subtitle="Follow your device’s prompt"
        />
      ) : step === 'find' ? (
        renderFind()
      ) : (
        renderReview()
      )}
    </ShellDialog>
  );
};

/** The account being recovered: its name when it has one, its short address underneath. */
function AccountCard({
  address,
  name,
  avatar,
  badge,
}: {
  address: Address;
  name: string | null;
  avatar: string | null;
  badge?: ReactNode;
}) {
  return (
    <div className="border-border rounded-box flex items-center gap-3 border p-3">
      <AccountAvatar seed={address} avatarUrl={avatar} size={28} className="rounded-chip size-blob-lg flex-none" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {name && <span className="text-foreground text-body truncate font-semibold">{name}</span>}
        <span
          className={cn('text-body-xs font-mono', name ? 'text-muted-foreground' : 'text-foreground font-semibold')}
        >
          {formatAddress(address)}
        </span>
      </span>
      {badge}
    </div>
  );
}

/**
 * The recovery the guardians will run: how many approve, how long the wait is, and the networks.
 * Read from the lowest network where recovery is on, the one the backend reads the guardians from.
 */
function RecoveryTermsCard({ networks, apiKey }: { networks: RecoveryChainConfig[]; apiKey?: string }) {
  const icons = useChainIcons(apiKey);
  const [base] = networks;
  const delay = minimumRecoveryDelay(base.recoveries, base.threshold);

  return (
    <div className="border-border rounded-box overflow-hidden border">
      <RecoveryFact label="Guardians">{`${base.recoveries.length} · any ${base.threshold} approve`}</RecoveryFact>
      <RecoveryFact label="Waiting period">
        {delay === null ? 'Not set' : `${formatRecoveryDelay(delay)} after they approve`}
      </RecoveryFact>
      <RecoveryFact label="Networks">
        <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {networks.map((network) => (
            <span key={network.chainId} className="flex items-center gap-1.5">
              <NetworkIcon icon={icons[network.chainId]} />
              {chainName(network.chainId)}
            </span>
          ))}
        </span>
      </RecoveryFact>
    </div>
  );
}

export { RecoveryStatus, type RecoveryStatusProps } from './RecoveryStatus';
export * from './types';
