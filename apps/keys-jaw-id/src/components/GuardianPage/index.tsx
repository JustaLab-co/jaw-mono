'use client';

import { useRef, useState, type ReactNode } from 'react';
import {
  GuardianApproved,
  GuardianBlockNotice,
  GuardianChecks,
  GuardianRequestFacts,
  OpenRequestsNotice,
  ProcessingScreen,
  RecoveryNotice,
  SectionHeading,
  guardianApprovalBlock,
  usePendingRecoveries,
  useRecoveryName,
  useRecoveryRequest,
  useReverseIdentity,
} from '@jaw.id/ui';
import {
  Account,
  JAW_RPC_URL,
  approveRecovery,
  standardErrorCodes,
  type Ceremony,
  type CeremonyApproval,
} from '@jaw.id/core';
import {
  createWalletClient,
  custom,
  getAddress,
  isHex,
  size,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { recoveryErrorCode } from '../../lib/recovery-error';

/**
 * Who approves: a keys passkey signed in on this page, or a browser wallet. A passkey's key is
 * known before its approve prompt, so a key that is no guardian of the request is refused first.
 */
type Guardian =
  | { kind: 'passkey'; address: Address; publicKey?: Hex; account: Account }
  | { kind: 'wallet'; address: Address };

/** What the page is waiting on: the passkey sign-in, the wallet's account, or the approval itself. */
type Busy = 'signing-in' | 'connecting' | 'approving';

export interface GuardianPageProps {
  /** The request id from the link, as typed: checked here before anything is read. */
  requestId: string;
  /** The key the page approves under (`NEXT_PUBLIC_RECOVERY_API_KEY`): no dApp hands it one. */
  apiKey: string | undefined;
}

/**
 * The page a recovery request's guardians open from the shared link (artboard 7): a full page on
 * keys, never framed. A friend with a JAW account approves with their passkey right here; a wallet
 * guardian connects a browser wallet. The app's dialog (GuardianApproveDialog) and this page share
 * the approval pieces, so both say the same thing.
 *
 * What is signed is the request this page shows: only its id goes to core, which reads that
 * request again and checks the id hashes from its account and new passkey before any prompt.
 */
export function GuardianPage({ requestId, apiKey }: GuardianPageProps) {
  const validId = isHex(requestId) && size(requestId) === 32;

  return (
    <div data-jaw-ui className="bg-background text-foreground flex min-h-screen flex-col">
      <header className="border-border bg-background flex h-[60px] flex-none items-center justify-between gap-3 border-b px-4 sm:px-8">
        <span className="flex min-w-0 items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/jaw-logo.png" alt="" className="h-7 w-7 flex-none rounded-lg" />
          <span className="text-[15px] font-bold tracking-tight">JAW</span>
          <span className="text-muted-foreground truncate font-mono text-[11px]">keys.jaw.id</span>
        </span>
        <span className="text-muted-foreground text-label flex-none font-mono uppercase">Guardian approval</span>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-10 sm:px-8">
        <div className="border-border bg-background rounded-card flex w-full max-w-[400px] flex-col border shadow-lg">
          {!apiKey ? (
            <PageNotice tone="info" title="Recovery approval is unavailable">
              This page can’t approve requests right now. Try again later.
            </PageNotice>
          ) : !validId ? (
            <PageNotice tone="destructive" title="This link isn’t valid">
              Ask for the link again.
            </PageNotice>
          ) : (
            <GuardianApproval requestId={requestId} apiKey={apiKey} />
          )}
        </div>
      </main>
    </div>
  );
}

function PageNotice({ tone, title, children }: { tone: 'info' | 'destructive'; title: string; children: ReactNode }) {
  return (
    <div className="p-6">
      <RecoveryNotice tone={tone} title={title}>
        {children}
      </RecoveryNotice>
    </div>
  );
}

/** The network a passkey signs in on: the lowest one in the request, where its guardians are read. */
function signInChainId(ceremony: Ceremony): number {
  return ceremony.chains.length > 0 ? Math.min(...ceremony.chains.map((chain) => chain.chainId)) : 1;
}

function GuardianApproval({ requestId, apiKey }: { requestId: Hex; apiKey: string }) {
  const mainnetRpcUrl = `${JAW_RPC_URL}?chainId=1&api-key=${apiKey}`;
  const { ceremony, failed } = useRecoveryRequest(requestId, apiKey);
  const openRequests = usePendingRecoveries(ceremony?.account, apiKey);
  const { name: owner } = useRecoveryName(ceremony?.account, mainnetRpcUrl);

  const [contacted, setContacted] = useState(false);
  const [calm, setCalm] = useState(false);
  const [guardian, setGuardian] = useState<Guardian | null>(null);
  const guardianIdentity = useReverseIdentity(guardian?.address, 1, mainnetRpcUrl);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [approval, setApproval] = useState<CeremonyApproval | null>(null);
  // Core refused the signer before any prompt (-32602): it is none of the request's guardians.
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  // Synchronous re-entry guard: one tap, one prompt.
  const busyRef = useRef(false);

  const block = refused
    ? 'not-guardian'
    : ceremony
      ? guardianApprovalBlock(ceremony, guardian?.kind === 'passkey' ? guardian.publicKey : undefined)
      : null;
  const checked = contacted && calm;

  const run = async (step: Busy, work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(step);
    setError('');
    try {
      await work();
    } catch (failure) {
      console.error('Recovery approval failed:', failure);
      const code = recoveryErrorCode(failure);
      // A cancelled passkey prompt or wallet: back to the page as it was.
      if (code === standardErrorCodes.provider.userRejectedRequest) return;
      if (code === standardErrorCodes.rpc.invalidParams) setRefused(true);
      else setError(`Error: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  // A keys passkey stored on this device that is one of the request's guardians signs in with no
  // prompt; otherwise the browser's passkey picker, once. The page then shows "Approving as"
  // before the approve prompt.
  const signInWithPasskey = () =>
    run('signing-in', async () => {
      if (!ceremony) return;
      const config = { chainId: signInChainId(ceremony), apiKey };
      const stored = Account.getStoredAccounts(apiKey).find(
        (entry) => guardianApprovalBlock(ceremony, entry.publicKey) !== 'not-guardian'
      );
      const account = stored
        ? await Account.restore(config, stored.credentialId, stored.publicKey)
        : await Account.import(config);
      const credentialId = stored?.credentialId ?? account.getMetadata()?.credentialId;
      const publicKey =
        stored?.publicKey ??
        Account.getStoredAccounts(apiKey).find((entry) => entry.credentialId === credentialId)?.publicKey;
      setGuardian({ kind: 'passkey', address: account.address, publicKey, account });
    });

  const approveWithPasskey = () =>
    run('approving', async () => {
      if (guardian?.kind !== 'passkey') return;
      // Core reads the request by this id again and signs it: the id hashes from the account and
      // the new passkey this page shows, and core checks that before the prompt.
      setApproval(await guardian.account.approveRecovery(requestId));
    });

  // Browser wallets only: the one `window.ethereum` injects. Its account is asked for, then core
  // checks it is a guardian and has the wallet sign the request's typed data (eth_signTypedData_v4).
  const approveWithWallet = () =>
    run('connecting', async () => {
      const ethereum = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
      if (!ethereum) throw new Error('No browser wallet found. Open this page in a browser with a wallet.');
      const [connected] = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!connected) throw new Error('The wallet shared no account.');
      const address = getAddress(connected);
      setGuardian({ kind: 'wallet', address });
      setBusy('approving');
      const wallet = createWalletClient({ account: address, transport: custom(ethereum) });
      setApproval(
        await approveRecovery({
          requestId,
          apiKey,
          signer: { address, signTypedData: (typedData) => wallet.signTypedData(typedData) },
        })
      );
    });

  const back = () => {
    setGuardian(null);
    setRefused(false);
    setError('');
  };

  if (approval && ceremony) {
    return (
      <GuardianApproved
        ceremony={ceremony}
        approval={approval}
        guardian={guardian?.address}
        mainnetRpcUrl={mainnetRpcUrl}
      />
    );
  }

  if (busy === 'approving' && guardian) {
    return (
      <ProcessingScreen
        seedAddress={guardian.address}
        avatarUrl={guardianIdentity.avatar}
        // eslint-disable-next-line @next/next/no-img-element
        appAvatar={<img src="/jaw-logo.png" alt="" className="h-full w-full object-cover" />}
        title="Approving recovery"
        subtitle={guardian.kind === 'wallet' ? 'Confirm in your wallet' : 'Confirm with your passkey'}
      />
    );
  }

  const buttonClass =
    'rounded-box text-button inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 font-semibold shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-50';
  const primary = `${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`;
  const secondary = `${buttonClass} bg-secondary text-secondary-foreground hover:bg-secondary/80`;

  const footer = !ceremony ? null : block === 'closed' ? null : block === 'not-guardian' ? (
    <button type="button" onClick={back} className={secondary}>
      Back
    </button>
  ) : guardian?.kind === 'passkey' ? (
    <div className="flex gap-2">
      <button type="button" onClick={back} disabled={!!busy} className={`${secondary} flex-[44]`}>
        Back
      </button>
      <button
        type="button"
        onClick={approveWithPasskey}
        disabled={!checked || !!busy}
        className={`${primary} flex-[56]`}
      >
        Approve
      </button>
    </div>
  ) : (
    <>
      <button type="button" onClick={signInWithPasskey} disabled={!checked || !!busy} className={primary}>
        <KeyIcon />
        Approve with passkey
      </button>
      <button type="button" onClick={approveWithWallet} disabled={!checked || !!busy} className={secondary}>
        <WalletIcon />
        Approve with a wallet
      </button>
      <p className="text-muted-foreground text-body-sm text-center">
        One approval counts on every network. No sign-in, no fees.
      </p>
    </>
  );

  return (
    <>
      <div className="flex flex-col gap-3 px-6 pb-3 pt-6">
        {!ceremony ? (
          failed ? (
            <RecoveryNotice tone="destructive" title="This request couldn’t be loaded">
              Check your connection. This screen tries again on its own.
            </RecoveryNotice>
          ) : (
            <div className="flex min-h-[200px] items-center justify-center">
              <div role="status" className="border-primary h-5 w-5 animate-spin rounded-full border-b-2">
                <span className="sr-only">Loading the request</span>
              </div>
            </div>
          )
        ) : (
          <>
            <div>
              <h1 className="text-foreground text-title-xl">{`Approve ${owner}’s new passkey.`}</h1>
              <p className="text-muted-foreground text-body mt-2">
                {owner} lost their passkey and made a new one. You’re approving that new passkey for their account.
              </p>
            </div>

            <div className="mt-1 flex flex-col gap-2">
              <SectionHeading label="Request" />
              <GuardianRequestFacts ceremony={ceremony} guardian={guardian?.address} mainnetRpcUrl={mainnetRpcUrl} />
            </div>

            {block ? (
              <GuardianBlockNotice block={block} ceremony={ceremony} owner={owner} />
            ) : (
              <>
                {openRequests && (
                  <OpenRequestsNotice requests={openRequests} requestId={ceremony.requestId} owner={owner} />
                )}
                <RecoveryNotice tone="warning" title="Before you approve">
                  A call, a new number or a voice note is not proof. Voices can be faked. Contact {owner} yourself.
                </RecoveryNotice>
                <GuardianChecks
                  owner={owner}
                  contacted={contacted}
                  calm={calm}
                  onContactedChange={setContacted}
                  onCalmChange={setCalm}
                  disabled={!!busy}
                />
              </>
            )}

            {error && (
              <div className="bg-destructive/10 rounded-box p-3">
                <p className="text-destructive text-body">{error}</p>
              </div>
            )}
          </>
        )}
      </div>

      {footer && <div className="border-border/40 flex flex-col gap-2 border-t px-6 pb-5 pt-3">{footer}</div>}
    </>
  );
}

/** The key on "Approve with passkey" (lucide KeyRound). */
function KeyIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

/** The wallet on "Approve with a wallet" (lucide Wallet). */
function WalletIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}
