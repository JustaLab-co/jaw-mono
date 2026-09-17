'use client';

import { useCallback, useEffect, useState, useRef, type MutableRefObject } from 'react';
import { debugLog } from '../lib/debug-log';
import { createFlowLock } from '../lib/flow-lock';
import { buildHandshakeFailure, routeHandshake, routeOwnsScreen } from '../lib/handshake-route';
import { selectScreen, type Phase } from '../lib/select-screen';
import { RequestModals } from '../components/RequestModals';
import { extractTransactionData } from '../lib/tx-handler';
import type { TransactionRequestData } from '../components/TransactionModal';
import { useAuth, usePasskeys } from '../hooks';
import { SignInScreen, type AuthenticatedAccount } from '../components/OnboardingSection';
import { PasskeyManager, type PasskeyAccount } from '@jaw.id/core';
import { SiweModal } from '../components/SiweModal';
import { ensureIntNumber, type SignInWithEthereumCapabilityRequest } from '@jaw.id/core';
import { ConnectModal } from '../components/ConnectModal';
import { UnsupportedMethodModal } from '../components/UnsupportedMethodModal';
import { SDKRequestType } from '../lib/sdk-types';
import { PopupCommunicator, type Message } from '../lib/popup-communicator';
import { EmbeddedShell } from '../components/EmbeddedShell';
import { CryptoHandler } from '../lib/crypto-handler';
import { applyAccountHint } from '../lib/account-hint';
import { iframeBlocksPasskeyCreation } from '../lib/embedded-ui';
import { isSilentContinueAsConnect } from '../lib/continue-as-connect';
import { sendSessionHandoff, registerSessionHandoffListener } from '../lib/session-handoff';
import type { SessionAuthState } from '../lib/session-manager';
import type { RPCRequestMessage, RPCResponseMessage, MessageID } from '@jaw.id/core';
import { RECONNECT_REQUIRED } from '@jaw.id/core';
import { getSiweOriginWarning, OnboardingSkeleton } from '@jaw.id/ui';
import { applyDappTheme } from '../lib/apply-dapp-theme';
import { createSiweMessage } from 'viem/siwe';
import { ChainId } from '@justaname.id/sdk';
import type { PopupConfig, PendingRequest } from '../utils/types';
import { extractSubnameTextRecords } from '../lib/extractSubnameTexts';
import { standardErrorCodes } from '@jaw.id/core';

// Note: TransactionRequestData is now imported from TransactionModal for consistency

// Simple state types
// Phase lives with the screen decision (lib/select-screen) so the two unions
// stay disjoint by construction — sharing members is what made half of that
// function an identity mapping.

// Delay before closing the dialog once a flow completes. The response is
// already posted to the SDK *before* this timer starts (each flow does
// `await onApprove(...)` then `scheduleClose(...)`), and a 'completed'
// DialogClose never rejects a pending request — so this is purely event-loop
// margin to let the SDK drain the result ahead of the close, not a round-trip
// budget. 300ms stays effectively instant while giving a busy main thread
// comfortable headroom.
const CLOSE_DELAY_MS = 300;

// After a signature is delivered, hold the "Signed ✓" confirmation on screen this
// long before the dialog closes. This delays ONLY the close — the signature is
// already posted to the dApp via `await onApprove(...)` before the hold — so the
// dApp never waits on the animation. The hold rides on the cancelable close timer
// rather than an awaited sleep, so a new request arriving mid-tick simply cancels
// it (see finishDeliveredFlow).
const SIGNED_TICK_MS = 850;

export default function KeysJawIdApp() {
  // Single communicator instance, shared by the embedded shell (presentation
  // + iframe escape hatches) and the app content (message flow).
  const [communicator] = useState(() => new PopupCommunicator());
  // The shell owns the overlay tap but the content owns the flow state, so the
  // content registers what a cancel should drop.
  const cancelFlowRef = useRef<(() => void) | undefined>(undefined);

  return (
    <EmbeddedShell communicator={communicator} onCancel={() => cancelFlowRef.current?.()}>
      <KeysJawIdAppContent communicator={communicator} cancelFlowRef={cancelFlowRef} />
    </EmbeddedShell>
  );
}

function KeysJawIdAppContent({
  communicator,
  cancelFlowRef,
}: {
  communicator: PopupCommunicator;
  cancelFlowRef: MutableRefObject<(() => void) | undefined>;
}) {
  // Current origin for session-based auth
  const [currentOrigin, setCurrentOrigin] = useState<string | null>(null);

  // Use hooks for passkey operations (pass origin for session-based auth)
  const authQuery = useAuth({ origin: currentOrigin || undefined });
  const passkeyQuery = usePasskeys();

  // Service instances (created once)
  const [cryptoHandler] = useState(() => new CryptoHandler());

  // Simple state
  const [isSDKMode, setIsSDKMode] = useState(false);
  const [phase, setPhase] = useState<Phase>('starting');
  const [config, setConfig] = useState<PopupConfig | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  // Parent-owned so the "Signed ✓" tick appears only AFTER onApprove confirms delivery,
  // never before. Reset per request (below) so a prior tick can't bleed into the next.
  const [signDelivered, setSignDelivered] = useState(false);
  const [currentAccount, setCurrentAccount] = useState<PasskeyAccount | null>(null);
  // Parsed here, not in the modal's render: a child reporting a parse failure
  // through these setters blanks the dialog for a frame, and the dApp gets no
  // rejection.
  const [txData, setTxData] = useState<TransactionRequestData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ensConfig, setEnsConfig] = useState<string | undefined>(undefined);
  const [chainId, setChainId] = useState<ChainId | undefined>(undefined);
  // The dApp's API key. It arrives in the transport config message (seeded from
  // the SDK's store), is used to bootstrap the account screen, and is then
  // overridden by the handshake's chain.rpcUrl — the authoritative source. Never
  // fall back to the keys app's own key: that key identifies a different project
  // for ENS subname issuance and billing, so using it would misattribute both.
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  // Embedded only: credentialId of the account the dApp is currently
  // connected as (the handshake's lastAccount hint). Preferred as the
  // "Continue as" default so this partition tracks a popup-side account
  // switch it can otherwise never see. UI pointer only — auth state still
  // comes exclusively from the passkey ceremony.
  const [hintedCredentialId, setHintedCredentialId] = useState<string | null>(null);
  // This popup was opened by the SDK because the embedded iframe couldn't run
  // WebAuthn create() (the reason WE sent rides back on the URL) — the user
  // was creating an account, so open on the create view.
  const [startInCreate] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('switch-reason') === 'webauthn-unsupported'
  );
  const effectiveChainId = (chainId ?? pendingRequest?.chain?.id ?? 1) as ChainId;

  // Reset the tick on each new request so a prior success can't bleed into the next.
  useEffect(() => {
    setSignDelivered(false);
  }, [pendingRequest]);

  const configRef = useRef<PopupConfig | null>(null);
  // Mirrors `phase` so the (once-registered) message listener can read the
  // CURRENT phase without a stale closure. Updated on every render.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // The in-flight hint apply. Until it settles, a wiped partition reads empty.
  const hintApplyRef = useRef<Promise<unknown> | null>(null);
  // One request at a time (lib/flow-lock). Claimed at handler entry, released
  // wherever a flow ends — answered, failed, or dismissed.
  const flowLock = useRef(createFlowLock()).current;
  // Holds the pending success→close timer so a new flow can cancel a previous
  // flow's auto-close (the embedded iframe stays mounted across flows).
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Put the dialog back to a blank slate once a flow is over.
   *
   * Called while it is hidden, not when the next request arrives: the SDK
   * reveals the dialog before that request reaches us (postMessage shows first),
   * so anything left on screen flashes back — a transaction the user just
   * cancelled, or a "Please wait" caption for a request they have not seen. The
   * skeleton is what the next screen grows out of anyway.
   */
  const clearScreen = useCallback(() => {
    setPendingRequest(null);
    setError(null);
    setPhase('reading-passkeys');
  }, []);

  /**
   * Schedule the dialog close after a flow completes. Cancelable: starting a new
   * flow clears any pending close so a prior flow's timer can't hide the dialog
   * mid-request (which, with no business-request timeout, would hang the dApp).
   */
  const scheduleClose = useCallback(
    (ms: number) => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        communicator.requestClose();
        clearScreen();
      }, ms);
    },
    [communicator, clearScreen]
  );

  /**
   * Close out a flow whose response has already been delivered, holding the tick on
   * screen first.
   *
   * The flow already stopped owning the screen — onApprove dropped the lock before
   * this runs — so only the tick and the (cancelable) close timer are left. Nothing
   * is awaited, so there is no continuation that could outlive the flow and write
   * over a newer request's screen; and if a new request does arrive during the hold,
   * the listener cancels this timer and resets, which is exactly right.
   */
  const finishDeliveredFlow = useCallback(() => {
    setSignDelivered(true);
    scheduleClose(SIGNED_TICK_MS + CLOSE_DELAY_MS);
  }, [scheduleClose]);

  // The user walked away (dialog X, or a tap outside an inline screen — modals
  // capture their own outside clicks). The shell already closed the dialog, so
  // its end only drops the flow.
  cancelFlowRef.current = () => {
    flowLock.release();
    clearScreen();
  };
  const cancelFlow = useCallback(() => {
    cancelFlowRef.current?.();
    communicator.requestClose('cancelled');
  }, [communicator, cancelFlowRef]);

  // Latest auth refetch for the (once-registered) handoff listener below —
  // same stale-closure guard as phaseRef.
  const refetchAuthRef = useRef(authQuery.refetch);
  refetchAuthRef.current = authQuery.refetch;

  // Safari cannot CREATE passkeys inside the cross-origin iframe (get() works,
  // so "Continue as" stays embedded). The create action must escape to the
  // popup synchronously within the user's click — an attempt-then-switch loses
  // the transient activation and Safari blocks the popup window.
  const createEscapesToPopup = communicator.isEmbedded() && iframeBlocksPasskeyCreation();
  const switchToPopupForCreate = useCallback(
    () => communicator.requestSwitchToPopup('webauthn-unsupported'),
    [communicator]
  );

  /**
   * Popup context only: after the user approves a connection, hand the
   * freshly authenticated session to the embedded keys iframe in the dApp
   * page, so the next embedded action decrypts directly instead of walking
   * the user through reconnect + a second "Continue as" passkey ceremony
   * (Safari storage partitioning). Best-effort — see lib/session-handoff.ts.
   */
  const handOffSessionToEmbedded = useCallback(
    async (origin: string) => {
      if (communicator.getContext() !== 'popup') return;
      try {
        const session = await cryptoHandler.getSession(origin);
        if (session?.authState) {
          sendSessionHandoff({ dappOrigin: origin, session });
        } else {
          debugLog('[SessionHandoff] not sent: no session/authState for', origin);
        }
      } catch {
        /* best-effort: the reconnect + Continue-as flow remains the fallback */
      }
    },
    [communicator, cryptoHandler]
  );

  // Embedded only: accept a session handed off by the same-origin popup. This
  // listens on the raw window on purpose — the sender is the popup, not the
  // communicator counterpart (the parent), so the communicator's
  // source-checked channel does not apply (see lib/session-handoff.ts).
  useEffect(() => {
    if (!communicator.isEmbedded()) return;
    return registerSessionHandoffListener({
      isEmbedded: () => communicator.isEmbedded(),
      getEmbedderOrigin: () => communicator.getOrigin(),
      importSession: (origin, session) => cryptoHandler.getSessionManager().importSession(origin, session),
      seedAccountList: (authState) =>
        new PasskeyManager().addAccountToList({
          username: authState.username,
          credentialId: authState.credentialId,
          publicKey: authState.publicKey,
          address: authState.address,
          creationDate: new Date().toISOString(),
          isImported: false,
        }),
      onImported: () => {
        void refetchAuthRef.current();
      },
    });
  }, [communicator, cryptoHandler]);

  // Single useEffect for all message handling
  useEffect(() => {
    // Check if running in popup mode
    if (!communicator.hasOpener()) {
      debugLog('📱 Running in normal mode (no opener)');
      setIsSDKMode(false);
      return;
    }

    debugLog('🚀 Running in SDK popup mode');
    setIsSDKMode(true);

    // Initialize crypto handler
    cryptoHandler
      .initialize()
      .then(() => {
        debugLog('✅ CryptoHandler initialized');
        // Send PopupLoaded event
        communicator.sendPopupLoaded();
      })
      .catch((err) => {
        console.error('❌ Failed to initialize CryptoHandler:', err);
        setError('Failed to initialize');
        setPhase('failed');
      });

    // Listen for messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = communicator.onMessage<PopupConfig>((message: any) => {
      // Log only the message shape, never the full payload — it includes the
      // embedder URL, metadata and the encrypted envelope (visible to any
      // extension with console access).
      debugLog('📥 Received message:', message?.event ?? (message?.requestId ? 'response' : 'request'));

      // Handle config message
      if (message.data?.version) {
        setConfig(message.data);
        configRef.current = message.data;

        setEnsConfig(message.data.preference?.ens);
        setChainId(message.data.metadata?.defaultChainId as ChainId);
        // Bootstrap the API key from the transport config message so the account
        // screen has the dApp's key before the handshake arrives. Guarded so a
        // config message without one can't wipe a key already set; the handshake
        // chain.rpcUrl remains the authoritative source and overrides it.
        if (message.data.apiKey) {
          setApiKey(message.data.apiKey);
        }

        // Apply the dApp's theme tokens so the embedded dialog matches its
        // look & feel (accent color, border radius, light/dark), translated
        // into keys' own shadcn-HSL token system. Falls back to the OS theme
        // (SystemThemeListener) when no theme is sent.
        if (message.data.theme) {
          applyDappTheme(message.data.theme);
        }

        // Embedded only: our storage is partitioned (wiped between visits in
        // Brave/Safari) AND blind to flows that ran in the popup's first-party
        // world — on Safari an account switch routes to the popup, so this
        // partition would keep offering the OLD identity and sign with the
        // wrong passkey. Apply the dApp-side hint (the account the dApp is
        // actually connected as) before checkForPasskeys reads the list:
        // append-only on the account list, and preferred as the "Continue as"
        // default. The hint is only a credentialId pointer — the public key
        // and display name are resolved from the backend registry, never
        // trusted from the dApp. The apply is async (backend roundtrip,
        // bounded by a timeout), so only checkForPasskeys waits on it; the
        // handshake ack below must not. Popup/standalone contexts have real
        // first-party storage and take no hint.
        if (communicator.isEmbedded()) {
          hintApplyRef.current = applyAccountHint(message.data.lastAccount, {
            apiKey: message.data.apiKey,
          }).then((hinted) => {
            if (hinted) {
              setHintedCredentialId(hinted);
              debugLog('🌱 Applied backend-resolved lastAccount hint as the Continue-as default');
            }
            // Always show account selection UI - never auto-authenticate
            return checkForPasskeys();
          });
        } else {
          // Always show account selection UI - never auto-authenticate
          checkForPasskeys();
        }

        communicator.sendPopupReady(message.requestId);
      }

      // Live theme update: the dApp pushed a new theme (e.g. an OS light/dark
      // flip) without reconnecting. Re-apply it so the embedded dialog tracks
      // the host — this is what makes theme sync robust against the prewarm
      // one-shot. Same mapping as the config branch.
      if (message.event === 'SetTheme') {
        if (message.data?.theme) {
          applyDappTheme(message.data.theme);
        }
      }

      // Every hide() means the flow is over. Backstop for Escape and the host
      // backdrop, which the SDK dismisses without telling us anything else.
      if (
        message.event === 'DialogVisibility' &&
        (message.data as { visible?: boolean } | undefined)?.visible === false
      ) {
        if (flowLock.isOpen()) {
          debugLog('👋 Dialog hidden with a flow still open — treating it as dismissed');
          flowLock.release();
          clearScreen();
        }
      }

      // Handle selectSignerType event
      if (message.event === 'selectSignerType') {
        communicator.sendResponse(message.id, 'scw');
      }

      // Handle RPC requests
      if (message.id && message.sender && message.content) {
        // The embedded iframe stays mounted across flows, so a previous flow may
        // have left a terminal phase ('done'/'failed'), a stale pendingRequest,
        // and a scheduled auto-close — none of which the popup ever hit (fresh
        // page per flow). Reset before handling the new request so it renders its
        // own UI and is not closed by the previous flow's timer. Read the live
        // state via a ref (the listener is registered once → stale closure).
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
        // Reset only a FINISHED flow — an in-progress one (e.g. a cold connect's
        // passkey screen) must survive. Finished from the moment the response was
        // handed off, not when the tick stops: the SDK does not serialize requests,
        // so a new one can genuinely arrive mid-tick.
        if (flowLock.isFinished(phaseRef.current)) {
          setError(null);
          setPendingRequest(null);
          // The skeleton, not 'working': the handler below has real work to do
          // first (a connect rebuilds the session, keypair and all), and
          // 'working' renders a "Please wait while we process your request"
          // caption for a request the user has not been shown yet.
          setPhase('reading-passkeys');
        }

        const rpcMessage = message as RPCRequestMessage;

        // Handle handshake (unencrypted initial request)
        if ('handshake' in rpcMessage.content) {
          handleHandshakeRequest(rpcMessage);
        }

        // Handle encrypted request
        if ('encrypted' in rpcMessage.content) {
          handleEncryptedRequest(rpcMessage);
        }
      }
    });

    // Cleanup message listener on unmount (PopupUnload is handled by communicator's beforeunload)
    return () => {
      cleanup();
      // Don't let a scheduled close fire after unmount (dev hot-reload / nav).
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle transition to account-selection when handshake arrives for authenticated users
  useEffect(() => {
    if (
      pendingRequest?.type === SDKRequestType.CONNECT &&
      currentAccount &&
      (phase === 'working' || phase === 'confirming-account' || phase === 'creating-passkey')
    ) {
      setPhase('choosing-account');
    }
  }, [pendingRequest, phase, currentAccount]);

  // A terminal phase is the end of the flow however it got there — including
  // ways no answering callback covers, like the passkey read failing after the
  // handshake handed ownership on. Without this the lock is held with nothing on
  // screen to release it, and every later request is refused as busy.
  useEffect(() => {
    if (phase === 'done' || phase === 'failed') flowLock.release();
  }, [phase, flowLock]);

  // Connect screen with no address: nothing can be approved, so answer the dApp.
  // In an effect, not in the render that discovers it: onReject posts to the SDK
  // and clears state, and a render must not do either.
  useEffect(() => {
    if (phase !== 'choosing-account') return;
    if (pendingRequest?.type !== SDKRequestType.CONNECT) return;
    if (authQuery.walletAddress) return;
    console.error('❌ Connect screen reached with no wallet address');
    void pendingRequest.onReject('Internal error: wallet address not available', standardErrorCodes.rpc.internal);
  }, [phase, pendingRequest, authQuery.walletAddress]);

  // Handle eth_chainId request (no UI needed, respond directly)
  useEffect(() => {
    if (pendingRequest?.type === SDKRequestType.CHAIN_ID && isSDKMode) {
      const handleChainId = async () => {
        try {
          const chainId = pendingRequest.chain?.id ?? 1;
          const chainIdHex = `0x${chainId.toString(16)}`;
          await pendingRequest.onApprove(chainIdHex);
          scheduleClose(CLOSE_DELAY_MS);
        } catch (error) {
          console.error('❌ Failed to handle eth_chainId:', error);
          await pendingRequest.onReject(
            error instanceof Error ? error.message : 'Failed to get chain ID',
            standardErrorCodes.rpc.internal
          );
          scheduleClose(CLOSE_DELAY_MS);
        }
      };
      handleChainId();
    }
  }, [pendingRequest, isSDKMode, scheduleClose]);

  // Waits on the hint apply: reading the account list mid-lookup shows an empty
  // partition and flashes create-account at a returning user.
  const driveAccountScreen = () => {
    void Promise.resolve(hintApplyRef.current).then(() => checkForPasskeys());
  };

  // Check for existing passkeys using hooks
  const checkForPasskeys = async () => {
    setPhase('reading-passkeys');

    try {
      // Refetch and use the returned fresh data (not the cached hook values)
      const accountsResult = await passkeyQuery.refetchAccounts();

      const accounts = accountsResult.data || [];

      if (accounts.length > 0) {
        // Has accounts - show account selection/auth screen
        setPhase('confirming-account');
      } else {
        // No accounts - need to create
        setPhase('creating-passkey');
      }
    } catch (err) {
      console.error('❌ Error checking passkeys:', err);
      setError('Failed to check for passkeys');
      setPhase('failed');
    }
  };

  // One shape, so the object the modals get is the one the tx was parsed from.
  const toRequestChain = (
    chain?: { id: number; rpcUrl?: string; paymaster?: { url: string; context?: Record<string, unknown> } } | undefined
  ) =>
    chain
      ? { id: chain.id, rpcUrl: chain.rpcUrl ?? '', ...(chain.paymaster && { paymaster: chain.paymaster }) }
      : undefined;

  const rejectHandshake = (request: RPCRequestMessage, code: number, message: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    communicator.sendMessage(buildHandshakeFailure(request, code, message) as any);
  };

  // Handle handshake request (unencrypted)
  const handleHandshakeRequest = async (request: RPCRequestMessage) => {
    // Checked before the first await: a second handshake while a request is still
    // on screen would rotate the peer key and take over pendingRequest, stranding
    // a flow neither side times out.
    if (flowLock.isOpen()) {
      debugLog('⛔ Handshake while a request is still open — refusing as busy');
      rejectHandshake(request, standardErrorCodes.rpc.resourceUnavailable, 'A request is already in progress');
      return;
    }
    flowLock.claim();

    // Only two paths leave a flow owning the screen: the cold-start ack (whose
    // request lands next and re-claims) and a connect (whose modal answers via
    // onApprove/onReject). Every other exit — invalid, 4100, unrecognised
    // method, a throw — answered or gave up, and must let the lock go. Tracking
    // that in a `finally` rather than at each `return` is what stops the next
    // early exit added here from wedging the gate.
    let ownsScreen = false;

    try {
      if (!('handshake' in request.content) || !request.content.handshake) {
        console.error('❌ Invalid handshake request');
        return;
      }

      // Get origin and set it as current context
      const origin = communicator.getOrigin() || '';
      setCurrentOrigin(origin);
      cryptoHandler.setOrigin(origin);

      const peerPublicKey = request.sender;
      const method = request.content.handshake.method;
      const params = request.content.handshake.params;
      const chain = request.content.chain;

      debugLog('🔍 =========================');
      debugLog('🔍 HANDSHAKE REQUEST RECEIVED:');
      debugLog('🔍 Origin:', origin);
      debugLog('🔍 Method:', method);
      debugLog('🔍 =========================');

      const apiKeyFromProvider = request.content?.chain?.rpcUrl?.split('api-key=')[1];
      if (apiKeyFromProvider && apiKeyFromProvider !== apiKey) {
        setApiKey(apiKeyFromProvider);
      }

      // Check for existing session
      const existingSession = await cryptoHandler.getSession(origin);
      const route = routeHandshake({ hasHandshake: true, method, hasSession: !!existingSession });

      // First request before any connect. Returning silently hangs the dApp
      // (no timeout, isAlive() stays true). 4100 is what JAWProvider reads as
      // "connect first"; minting a session would approve an origin the user
      // never did.
      if (route === 'connect-first') {
        debugLog('🔑 Handshake without session — answering 4100 (connect first)');
        rejectHandshake(
          request,
          standardErrorCodes.provider.unauthorized,
          'No connection for this origin; call wallet_connect first'
        );
        // The transport opened the dialog before posting; nothing here will
        // close it. Safe only on this branch — no session, no live flow.
        communicator.requestClose();
        return;
      }

      // Pure key exchange — the SDK's cold-start signal, sent only from its
      // no-signer branch. A reload with a live signer never lands here.
      if (route === 'cold-start' && existingSession) {
        if (existingSession.peerPublicKey !== peerPublicKey) {
          // Update peer key if changed
          await cryptoHandler.getSessionManager().updatePeerKey(origin, peerPublicKey);
        }

        // Our authState outlives a dApp disconnect (different origin, no expiry),
        // so a cold start drops it and re-asks. Only the clearing is conditional
        // — running it unconditionally is what let a bare handshake wipe a live
        // flow.
        if (existingSession.authState) {
          await cryptoHandler.getSessionManager().updateSession(origin, { authState: null });
          await refetchAuthRef.current();
          debugLog('🧊 Cold-start handshake — dropped stale auth for this origin');
          setCurrentAccount(null);
          setPendingRequest(null);
          setError(null);
        }

        // Always drive: the request handler only ever `return`s, so nothing else
        // puts a screen up, and the listener may have just parked the phase at
        // 'working' — which renders as an endless "Processing…" with no request.
        driveAccountScreen();

        // Acknowledge the handshake; the request it belongs to arrives next.
        const response = await cryptoHandler.createHandshakeResponse(request.id, { accounts: [] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        communicator.sendMessage(response as unknown as Message);
        ownsScreen = routeOwnsScreen(route);
        return;
      }

      if (route === 'connect') {
        // Always create a fresh session with new keys for each connection request
        if (existingSession) {
          debugLog('🗑️ Deleting old session for:', origin);
          await cryptoHandler.getSessionManager().deleteSession(origin);
        }

        // Create new session with fresh keys (account will be set when user approves)
        debugLog('🔐 Creating fresh session for:', origin);
        await cryptoHandler.getSessionManager().createSession({
          origin,
          peerPublicKey,
        });

        // Reload session after creation
        await cryptoHandler.loadSession(origin);

        // The session was just recreated with no authState, so the client-side
        // mirror has to follow it. A surviving currentAccount lets the
        // account-selection effect jump straight to the approval screen, and the
        // user connects off a ceremony this session never had — after an
        // ephemeral wallet_sendCalls, connect would complete with no passkey at
        // all. Drive a screen too: nothing else here puts one up.
        setCurrentAccount(null);
        await refetchAuthRef.current();
        driveAccountScreen();

        // Set up pending request (for both new connections and SIWE)
        setPendingRequest({
          origin,
          type: SDKRequestType.CONNECT,
          requestId: request.id || '',
          correlationId: request.correlationId || '',
          metadata: configRef.current?.metadata || null,
          method,
          params: Array.isArray(params) ? params : [],
          chain: toRequestChain(chain),
          onApprove: async (result: unknown) => {
            flowLock.release();
            const response = await cryptoHandler.createHandshakeResponse(
              request.id,
              result as { accounts: Array<{ address: string; capabilities?: Record<string, unknown> }> }
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            communicator.sendMessage(response as any);
          },
          onReject: async (error: string, errorCode?: number) => {
            // Answer for real, with the caller's code. Closing alone leaves the
            // dApp to settle on the SDK's own dismissal 4001 — which flattens a
            // passkey failure into "user rejected", and in popup context only
            // settles because the window-close poller catches it. The peer key
            // is not exchanged until this handshake resolves, so the failure
            // goes out unencrypted; CrossPlatformSigner.handshake reads
            // content.failure before it touches `sender`.
            flowLock.release();
            setPendingRequest(null);
            rejectHandshake(request, errorCode ?? standardErrorCodes.provider.userRejectedRequest, error);
            // 'completed', not 'cancelled': a response is on its way, and
            // 'cancelled' would have the SDK reject the same promise again.
            communicator.requestClose();
          },
        });

        // Fresh session has no account - checkForPasskeys flow will handle passkey creation/selection
        ownsScreen = routeOwnsScreen(route);
      }
    } catch (err) {
      console.error('❌ Failed to handle handshake:', err);
      setError(err instanceof Error ? err.message : 'Handshake failed');
      setPhase('failed');
    } finally {
      if (!ownsScreen) flowLock.release();
    }
  };

  // Handle encrypted request
  const handleEncryptedRequest = async (request: RPCRequestMessage) => {
    // Claimed, never refused: an encrypted request is the dApp's only copy of
    // that call, so it must be served. The claim is what makes a *handshake*
    // arriving mid-transaction refusable, and what lets the dismissal backstop
    // recognise an Escape out of a sign or send screen.
    flowLock.claim();

    try {
      // Load session for this origin
      const origin = communicator.getOrigin() || '';

      // Update React state with current origin (needed for useAuth hook)
      setCurrentOrigin(origin);

      // Reply to the SDK with a reconnect-required sentinel (tied to this
      // request id, carries no secret) so it re-establishes a session against
      // this iframe and retries. Used both when there is NO session and when the
      // session is stale (decrypt fails) — Safari storage partitioning can leave
      // the iframe with a session whose keys no longer match the SDK's.
      const emitReconnectRequired = (reason: string) => {
        console.warn(`⚠️ ${reason} — requesting reconnect for origin:`, origin);
        // Answered, and nothing goes on screen. The SDK's recovery for this
        // sentinel is another handshake (CrossPlatformSigner.reconnectInIframe),
        // so holding the lock here would have the busy gate refuse the very
        // reconnect this response asks for.
        flowLock.release();
        const reconnectResponse: RPCResponseMessage = {
          requestId: request.id,
          id: crypto.randomUUID() as MessageID,
          sender: '',
          correlationId: request.correlationId,
          content: {
            failure: {
              code: standardErrorCodes.provider.disconnected,
              message: 'No usable session in this context; reconnect required',
              data: { reason: RECONNECT_REQUIRED },
            },
          },
          timestamp: new Date(),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        communicator.sendMessage(reconnectResponse as any);
      };

      const session = await cryptoHandler.loadSession(origin);

      if (!session) {
        if (communicator.isEmbedded()) {
          emitReconnectRequired('No session in iframe partition');
          return;
        }
        console.error('❌ No session found for origin:', origin);
        throw new Error('No session found. Please reconnect.');
      }

      // Verify and update peer key if changed
      await cryptoHandler.verifyAndUpdatePeerKey(request);

      // Decrypt the request. A stale iframe session (keys no longer match the
      // SDK's) fails here with an AES-GCM auth-tag mismatch — Web Crypto's
      // OperationError. Treat ONLY that, and only when embedded, like a missing
      // session: drop it and ask the SDK to reconnect + retry, instead of
      // dead-ending on an undecryptable request. Any other error (malformed
      // envelope, bug, corrupted ciphertext) must surface, not be masked behind a
      // reconnect cycle that would fail identically on retry.
      let decrypted: Awaited<ReturnType<typeof cryptoHandler.decryptRequest>>;
      try {
        decrypted = await cryptoHandler.decryptRequest(request);
      } catch (decryptErr) {
        const isStaleSession = decryptErr instanceof DOMException && decryptErr.name === 'OperationError';
        if (communicator.isEmbedded() && isStaleSession) {
          await cryptoHandler.getSessionManager().deleteSession(origin);
          emitReconnectRequired('Stale iframe session (decrypt failed)');
          return;
        }
        throw decryptErr;
      }

      const method = decrypted.action.method;
      const params = decrypted.action.params;
      const chain = decrypted.chain;

      // Extract API key from chain rpcUrl if present
      const apiKeyFromProvider = chain?.rpcUrl?.split('api-key=')[1];
      if (apiKeyFromProvider && apiKeyFromProvider !== apiKey) {
        setApiKey(apiKeyFromProvider);
      }

      // Determine request type and show appropriate UI
      let requestType: SDKRequestType;

      // Check for sign message requests
      // personal_sign: always a sign message request
      // wallet_sign: only if request.type === "0x45" (Personal Sign per EIP-191)
      if (
        method === 'personal_sign' ||
        (method === 'wallet_sign' && Array.isArray(params) && params[0]?.request?.type === '0x45')
      ) {
        requestType = SDKRequestType.SIGN_MESSAGE;
      } else if (
        method === 'eth_signTypedData_v4' ||
        (method === 'wallet_sign' && Array.isArray(params) && params[0]?.request?.type === '0x01')
      ) {
        requestType = SDKRequestType.SIGN_TYPED_DATA;
      } else if (method === 'wallet_sendCalls' || method === 'eth_sendTransaction') {
        requestType = SDKRequestType.SEND_TRANSACTION;
      } else if (method === 'eth_chainId') {
        requestType = SDKRequestType.CHAIN_ID;
      } else if (method === 'wallet_grantPermissions') {
        requestType = SDKRequestType.GRANT_PERMISSIONS;
      } else if (method === 'wallet_revokePermissions') {
        requestType = SDKRequestType.REVOKE_PERMISSIONS;
      } else if (method === 'wallet_addFunds') {
        requestType = SDKRequestType.ADD_FUNDS;
      } else if (method === 'wallet_connect') {
        requestType = SDKRequestType.CONNECT;
      } else {
        console.warn('⚠️ Unsupported method:', method);
        requestType = SDKRequestType.UNSUPPORTED_METHOD;
      }

      // Parse the transaction before the request goes on screen. On failure the
      // dApp gets a real rejection instead of a dialog stuck on an error screen
      // it never sent an answer for.
      const requestChain = toRequestChain(chain);
      let parsedTx: TransactionRequestData | null = null;
      if (requestType === SDKRequestType.SEND_TRANSACTION) {
        try {
          parsedTx = extractTransactionData(method, Array.isArray(params) ? params : [], requestChain);
        } catch (extractErr) {
          console.error('❌ Failed to extract transaction data:', extractErr);
          const failure = await cryptoHandler.createEncryptedErrorResponse(
            request.id || '',
            request.correlationId || '',
            standardErrorCodes.rpc.invalidParams,
            extractErr instanceof Error ? extractErr.message : 'Invalid transaction parameters'
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          communicator.sendMessage(failure as any);
          setError(extractErr instanceof Error ? extractErr.message : 'Invalid transaction parameters');
          setPhase('failed');
          return;
        }
      }
      setTxData(parsedTx);

      setPendingRequest({
        origin,
        type: requestType,
        requestId: request.id || '',
        correlationId: request.correlationId || '',
        metadata: configRef.current?.metadata || null,
        method,
        params: Array.isArray(params) ? params : [],
        chain: requestChain,
        onApprove: async (result: unknown) => {
          flowLock.release();
          const response = await cryptoHandler.createEncryptedResponse(
            request.id || '',
            request.correlationId || '',
            result
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          communicator.sendMessage(response as any);
        },
        onReject: async (error: string, errorCode?: number) => {
          flowLock.release();
          // Send standard error response (default: EIP-1193 code 4001)
          try {
            const errorResponse = await cryptoHandler.createEncryptedErrorResponse(
              request.id || '',
              request.correlationId || '',
              errorCode ?? standardErrorCodes.provider.userRejectedRequest, // Default to user rejected request (EIP-1193 standard)
              error || 'User rejected the request'
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            communicator.sendMessage(errorResponse as any);
            // Close window after sending error
            scheduleClose(CLOSE_DELAY_MS);
          } catch (err) {
            console.error('❌ Failed to send rejection response:', err);
            communicator.requestClose();
          }
        },
      });

      // No screen work here on purpose: selectScreen owns that decision and
      // reads auth straight from the session manager via useAuth.
    } catch (err) {
      console.error('❌ Failed to handle encrypted request:', err);
      setError(err instanceof Error ? err.message : 'Failed to decrypt request');
      setPhase('failed');
    }
  };

  // ==========================================
  // SDK MODE
  // ==========================================
  if (isSDKMode) {
    // One decision for the whole dialog (lib/select-screen). Every branch below
    // dispatches on it instead of re-deriving its own condition, so they cannot
    // disagree about which screen is showing.
    const screen = selectScreen({
      requestType: pendingRequest?.type,
      phase,
      isAuthenticated: authQuery.isAuthenticated,
    });

    // The screen decision above already settled whether a modal shows; this only
    // hands the request to the component that picks which one.
    if (screen.kind === 'modal' && pendingRequest) {
      return (
        <RequestModals
          pendingRequest={pendingRequest}
          communicator={communicator}
          apiKey={apiKey}
          currentOrigin={currentOrigin}
          txData={txData}
          setPhase={setPhase}
          setError={setError}
          scheduleClose={scheduleClose}
          finishDeliveredFlow={finishDeliveredFlow}
          closeDelayMs={CLOSE_DELAY_MS}
          signDelivered={signDelivered}
        />
      );
    }

    // Show unsupported method modal
    if (!!pendingRequest && pendingRequest?.type === SDKRequestType.UNSUPPORTED_METHOD) {
      return (
        // Keyed by request — see TransactionModal above.
        <UnsupportedMethodModal
          key={pendingRequest.requestId}
          origin={pendingRequest.origin}
          method={pendingRequest.method}
          appName={pendingRequest.metadata?.appName}
          appLogoUrl={pendingRequest.metadata?.appLogoUrl}
          onClose={async (error, errorCode) => {
            try {
              // Forward error and code directly from modal
              await pendingRequest.onReject(error.message, errorCode ?? standardErrorCodes.rpc.methodNotFound);
              communicator.requestClose();
            } catch (err) {
              console.error('❌ Failed to reject unsupported method:', err);
              communicator.requestClose();
            }
          }}
        />
      );
    }

    // Pre-first-screen window: the transport handshake has acked (which is what
    // reveals the embedded dialog) but we don't yet know whether this resolves
    // to "Continue as" or account creation — that needs the handshake account
    // hint resolved against the backend registry, a real roundtrip on a wiped
    // storage partition. Render the shape of the card that follows rather than
    // a captioned spinner: a distinct "Connecting to dApp… / SDK v1.1"
    // interstitial used to flash here whenever a request beat the SDK's
    // prewarm, and it both read as a separate screen and leaked the version.
    if (screen.kind === 'loading') {
      return (
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-md">
            <OnboardingSkeleton />
          </div>
        </div>
      );
    }

    // Show processing spinner
    if (screen.kind === 'progress') {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="max-w-md p-6 text-center">
            <div className="border-primary mx-auto mb-4 h-16 w-16 animate-spin rounded-full border-b-2"></div>
            <h3 className="text-foreground mb-2 text-xl font-semibold">
              {authQuery.isAuthenticated ? 'Connecting to dApp...' : 'Processing...'}
            </h3>
            <p className="text-muted-foreground mb-4">
              {authQuery.isAuthenticated && authQuery.accountName
                ? `Authenticated as ${authQuery.accountName}. Waiting for dApp connection...`
                : 'Please wait while we process your request.'}
            </p>
            {config?.metadata && <p className="text-muted-foreground text-sm">{config.metadata.appName}</p>}
          </div>
        </div>
      );
    }

    // 'done' is a terminal marker only — it renders no UI. Each completed flow
    // closes the dialog immediately (see scheduleClose on every onSuccess),
    // matching the connect flow; the dApp surfaces its own confirmation. Keeping
    // the phase (rather than dropping it) preserves the cross-flow reset sentinel
    // and stops selectScreen reopening the modal; returning null avoids a
    // success interstitial flashing during the brief close window.
    if (screen.kind === 'receipt') {
      return null;
    }

    // Show error state
    if (screen.kind === 'failure') {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="max-w-md p-6 text-center">
            <div className="bg-destructive/10 mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full">
              <svg className="text-destructive h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h3 className="text-foreground mb-2 text-xl font-bold">Error</h3>
            <p className="text-muted-foreground mb-4">{error || 'An error occurred'}</p>
            <div className="space-y-2">
              <button
                onClick={() => {
                  setError(null);
                  setPhase('reading-passkeys');
                  checkForPasskeys();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90 w-full rounded-lg px-6 py-2 font-semibold transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => {
                  communicator.sendPopupUnload();
                  communicator.requestClose();
                }}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 w-full rounded-lg px-6 py-2 font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Show passkey creation screen
    if (phase === 'creating-passkey') {
      return (
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-md">
            <SignInScreen
              // The same call the EmbeddedShell overlay tap makes — the SDK rejects the pending
              // request; in a popup it closes the window. The X is a visible twin, not a new path.
              onClose={cancelFlow}
              ensConfig={ensConfig}
              chainId={effectiveChainId}
              apiKey={apiKey}
              chainConfig={pendingRequest?.chain}
              subnameTextRecords={extractSubnameTextRecords(pendingRequest)}
              origin={currentOrigin || undefined}
              preferredCredentialId={hintedCredentialId ?? undefined}
              onCreateNewAccount={createEscapesToPopup ? switchToPopupForCreate : undefined}
              startInCreate={startInCreate}
              onComplete={async (authenticatedAccount: AuthenticatedAccount) => {
                try {
                  // Set the current account from the passed data
                  setCurrentAccount({
                    credentialId: authenticatedAccount.credentialId,
                    username: authenticatedAccount.username,
                    publicKey: authenticatedAccount.publicKey,
                    creationDate: new Date().toISOString(),
                    isImported: false,
                  });
                  // Update session auth state for per-origin isolation
                  if (currentOrigin) {
                    const authState: SessionAuthState = {
                      address: authenticatedAccount.address,
                      credentialId: authenticatedAccount.credentialId,
                      username: authenticatedAccount.username,
                      publicKey: authenticatedAccount.publicKey,
                    };
                    await cryptoHandler.updateAuthState(authState);
                    debugLog('✅ Session auth state updated for origin:', currentOrigin);
                  }

                  await authQuery.refetch();

                  // If there's a pending connect request, show approval screen immediately
                  if (pendingRequest?.type === SDKRequestType.CONNECT) {
                    setPhase('choosing-account');
                  } else if (
                    pendingRequest?.type === SDKRequestType.SIGN_MESSAGE ||
                    pendingRequest?.type === SDKRequestType.SIGN_TYPED_DATA ||
                    pendingRequest?.type === SDKRequestType.SEND_TRANSACTION ||
                    pendingRequest?.type === SDKRequestType.GRANT_PERMISSIONS ||
                    pendingRequest?.type === SDKRequestType.REVOKE_PERMISSIONS
                  ) {
                    // If there's a pending sign message, typed data, transaction, or permission request,
                    // the modal will be shown in the priority logic above since user is now authenticated
                    setPhase('working');
                  } else {
                    // No pending request yet, stay on current screen and wait for it
                    // useEffect will handle transition when handshake arrives
                    // Don't change state - stay on passkey-create to keep UI visible
                  }
                } catch (err) {
                  console.error('❌ Failed after passkey creation:', err);
                  setError(err instanceof Error ? err.message : 'Failed to proceed');
                  setPhase('failed');
                }
              }}
            />
          </div>
        </div>
      );
    }

    // Show passkey authentication screen
    if (phase === 'confirming-account') {
      return (
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-md">
            <SignInScreen
              // The same call the EmbeddedShell overlay tap makes — the SDK rejects the pending
              // request; in a popup it closes the window. The X is a visible twin, not a new path.
              onClose={cancelFlow}
              ensConfig={ensConfig}
              chainId={effectiveChainId}
              apiKey={apiKey}
              chainConfig={pendingRequest?.chain}
              subnameTextRecords={extractSubnameTextRecords(pendingRequest)}
              origin={currentOrigin || undefined}
              preferredCredentialId={hintedCredentialId ?? undefined}
              onCreateNewAccount={createEscapesToPopup ? switchToPopupForCreate : undefined}
              startInCreate={startInCreate}
              onComplete={async (authenticatedAccount: AuthenticatedAccount) => {
                try {
                  // Set the current account from the passed data
                  setCurrentAccount({
                    credentialId: authenticatedAccount.credentialId,
                    username: authenticatedAccount.username,
                    publicKey: authenticatedAccount.publicKey,
                    creationDate: new Date().toISOString(),
                    isImported: false,
                  });

                  // Update session auth state for per-origin isolation
                  if (currentOrigin) {
                    const authState: SessionAuthState = {
                      address: authenticatedAccount.address,
                      credentialId: authenticatedAccount.credentialId,
                      username: authenticatedAccount.username,
                      publicKey: authenticatedAccount.publicKey,
                    };
                    await cryptoHandler.updateAuthState(authState);
                    // Do not log credentialId — it is sensitive (PII)
                    debugLog('✅ Session auth state updated for origin:', currentOrigin);
                  }

                  await authQuery.refetch();

                  // If there's a pending connect request, show approval screen immediately
                  if (pendingRequest?.type === SDKRequestType.CONNECT) {
                    if (
                      isSilentContinueAsConnect({
                        isEmbedded: communicator.isEmbedded(),
                        hintedCredentialId,
                        authenticatedCredentialId: authenticatedAccount.credentialId,
                        params: pendingRequest.params,
                      })
                    ) {
                      // Embedded "Continue as" fast path (see lib/continue-as-connect):
                      // the user already approved this exact origin+account pairing
                      // (the hint only persists post-approval) and just re-confirmed
                      // it via the Continue-as passkey ceremony — approve without
                      // re-showing the Connect screen. Mirrors ConnectModal.onSuccess.
                      setPhase('working');
                      await pendingRequest.onApprove({ accounts: [{ address: authenticatedAccount.address }] });
                      communicator.sendAccountHint({ credentialId: authenticatedAccount.credentialId });
                      setPhase('done');
                      scheduleClose(CLOSE_DELAY_MS);
                    } else {
                      setPhase('choosing-account');
                    }
                  } else if (
                    pendingRequest?.type === SDKRequestType.SIGN_MESSAGE ||
                    pendingRequest?.type === SDKRequestType.SIGN_TYPED_DATA ||
                    pendingRequest?.type === SDKRequestType.SEND_TRANSACTION ||
                    pendingRequest?.type === SDKRequestType.GRANT_PERMISSIONS ||
                    pendingRequest?.type === SDKRequestType.REVOKE_PERMISSIONS
                  ) {
                    // If there's a pending sign message, typed data, transaction, or permission request,
                    // the modal will be shown in the priority logic above since user is now authenticated
                    setPhase('working');
                  } else {
                    // No pending request yet, stay on current screen and wait for it
                    // useEffect will handle transition when handshake arrives
                    // Don't change state - stay on passkey-auth to keep UI visible
                  }
                } catch (err) {
                  console.error('❌ Failed after authentication:', err);
                  setError(err instanceof Error ? err.message : 'Authentication failed');
                  setPhase('confirming-account');
                }
              }}
            />
          </div>
        </div>
      );
    }

    // Show connection approval (account-selection state)
    if (phase === 'choosing-account' && pendingRequest?.type === SDKRequestType.CONNECT) {
      // Extract signInWithEthereum capability from wallet_connect params
      // params structure: [{ capabilities?: { signInWithEthereum?: {...} } }]
      const walletConnectParams = pendingRequest.params as
        | [{ capabilities?: { signInWithEthereum?: SignInWithEthereumCapabilityRequest } }]
        | undefined;
      const signInWithEthereumCapability = walletConnectParams?.[0]?.capabilities?.signInWithEthereum;

      // Rejected by the effect above, not here.
      if (!authQuery.walletAddress) return null;
      const walletAddress = authQuery.walletAddress;

      // If SIWE capability is requested, show SiweModal instead of ConnectModal
      if (signInWithEthereumCapability && pendingRequest.chain) {
        // Build the SIWE message using viem's createSiweMessage
        const buildSiweMessageFromCapability = () => {
          const origin = pendingRequest.origin;
          let defaultDomain: string;
          let defaultUri: string;

          try {
            const url = new URL(origin);
            defaultDomain = url.host;
            defaultUri = origin;
          } catch {
            defaultDomain = origin;
            defaultUri = origin;
          }

          // Convert hex chainId to number
          const chainIdNumber = ensureIntNumber(signInWithEthereumCapability.chainId);

          return createSiweMessage({
            address: walletAddress as `0x${string}`,
            chainId: chainIdNumber,
            domain: signInWithEthereumCapability.domain || defaultDomain,
            nonce: signInWithEthereumCapability.nonce,
            uri: signInWithEthereumCapability.uri || defaultUri,
            version: '1',
            statement: signInWithEthereumCapability.statement,
            issuedAt: signInWithEthereumCapability.issuedAt
              ? new Date(signInWithEthereumCapability.issuedAt)
              : new Date(),
            expirationTime: signInWithEthereumCapability.expirationTime
              ? new Date(signInWithEthereumCapability.expirationTime)
              : undefined,
            notBefore: signInWithEthereumCapability.notBefore
              ? new Date(signInWithEthereumCapability.notBefore)
              : undefined,
            requestId: signInWithEthereumCapability.requestId,
            resources: signInWithEthereumCapability.resources,
          });
        };

        const siweMessage = buildSiweMessageFromCapability();
        const siweWarning = getSiweOriginWarning(pendingRequest.origin, {
          domain: signInWithEthereumCapability.domain,
          uri: signInWithEthereumCapability.uri,
        });

        return (
          // Keyed by request — see TransactionModal above.
          <SiweModal
            key={pendingRequest.requestId}
            origin={pendingRequest.origin}
            message={siweMessage}
            address={walletAddress}
            chain={pendingRequest.chain}
            appName={pendingRequest.metadata?.appName}
            appLogoUrl={pendingRequest.metadata?.appLogoUrl}
            warningMessage={siweWarning}
            isSuccess={signDelivered}
            onSuccess={async (signature: string, message: string) => {
              // Connect owns its own post-delivery continuation below, so — unlike the
              // standalone signing handlers — we intentionally don't switch to 'working'.
              try {
                debugLog('✅ User signed SIWE message');

                // Build response per ERC-7846 format with SIWE capability
                const response = {
                  accounts: [
                    {
                      address: walletAddress,
                      capabilities: {
                        signInWithEthereum: {
                          message,
                          signature: signature as `0x${string}`,
                        },
                      },
                    },
                  ],
                };

                debugLog('✅ SIWE response:', response);
                await pendingRequest.onApprove(response);
                // Delivery confirmed — show the tick (held through the handoff + beat).
                setSignDelivered(true);
                // Nothing to mark for the handoff awaited below: onApprove already
                // dropped the lock, so a request arriving in that gap reads this flow
                // as finished and resets the screen for itself.
                // Only after approval (never on mere authentication, which the
                // user may still cancel): let the SDK persist the account hint
                // dApp-side, so the next embedded visit can show "Continue as"
                // even after Brave/Safari wipe our partitioned storage.
                if (authQuery.authState) {
                  communicator.sendAccountHint(authQuery.authState);
                }
                // Popup only: hand the session to the embedded iframe so the
                // next embedded action skips the second passkey ceremony.
                await handOffSessionToEmbedded(pendingRequest.origin);
                // Response already delivered — hold the "Signed in" tick, then close.
                finishDeliveredFlow();
              } catch (err) {
                console.error('❌ Failed to approve connection with SIWE:', err);
                setError(err instanceof Error ? err.message : 'Failed to approve connection');
                setPhase('failed');
              }
            }}
            onError={async (error, errorCode) => {
              try {
                // Forward error and code directly from modal
                await pendingRequest.onReject(
                  error.message,
                  errorCode ?? standardErrorCodes.provider.userRejectedRequest
                );
                communicator.requestClose();
              } catch (err) {
                console.error('❌ Failed to reject:', err);
                communicator.requestClose();
              }
            }}
          />
        );
      }

      // No SIWE capability - show regular ConnectModal
      return (
        // Keyed by request — see TransactionModal above.
        <ConnectModal
          key={pendingRequest.requestId}
          origin={pendingRequest.origin}
          appName={pendingRequest.metadata?.appName || 'dApp'}
          appLogoUrl={pendingRequest.metadata?.appLogoUrl}
          accountName={authQuery.accountName || currentAccount?.username}
          walletAddress={walletAddress}
          chain={pendingRequest.chain}
          onSuccess={async () => {
            setPhase('working');
            try {
              debugLog('✅ User approved connection');

              // Build response per ERC-7846 format (no capabilities)
              const response = {
                accounts: [
                  {
                    address: walletAddress,
                  },
                ],
              };

              await pendingRequest.onApprove(response);
              // Only after approval (never on mere authentication, which the
              // user may still cancel): let the SDK persist the account hint
              // dApp-side, so the next embedded visit can show "Continue as"
              // even after Brave/Safari wipe our partitioned storage.
              if (authQuery.authState) {
                communicator.sendAccountHint(authQuery.authState);
              }
              // Popup only: hand the session to the embedded iframe so the
              // next embedded action skips the second passkey ceremony.
              await handOffSessionToEmbedded(pendingRequest.origin);
              setPhase('done');
              scheduleClose(CLOSE_DELAY_MS);
            } catch (err) {
              console.error('❌ Failed to approve connection:', err);
              setError(err instanceof Error ? err.message : 'Failed to approve connection');
              setPhase('failed');
            }
          }}
          onError={async (error, errorCode) => {
            try {
              // Forward error and code directly from modal
              await pendingRequest.onReject(
                error.message,
                errorCode ?? standardErrorCodes.provider.userRejectedRequest
              );
              communicator.requestClose();
            } catch (err) {
              console.error('❌ Failed to reject:', err);
              communicator.requestClose();
            }
          }}
        />
      );
    }

    // No pending request yet - should not normally be seen
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="border-primary mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2"></div>
          <p className="text-muted-foreground">Waiting for request...</p>
        </div>
      </div>
    );
  }

  return null;
}
