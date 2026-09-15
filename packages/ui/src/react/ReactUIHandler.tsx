'use client';

import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  UIHandler,
  UIHandlerConfig,
  UIRequest,
  UIResponse,
  UIError,
  UIErrorCode,
  ConnectUIRequest,
  SignatureUIRequest,
  TypedDataUIRequest,
  TransactionUIRequest,
  SendTransactionUIRequest,
  PermissionUIRequest,
  RevokePermissionUIRequest,
  AddFundsUIRequest,
  WalletSignUIRequest,
  Account,
  SUPPORTED_CHAINS,
  JAW_RPC_URL,
  JAW_PAYMASTER_URL,
  SubnameTextRecordCapabilityRequest,
  handleGetCapabilitiesRequest,
  buildGrantPermissionCall,
  buildRevokePermissionCall,
  buildErc20PaymasterContext,
  type Chain,
  type SignInWithEthereumCapabilityRequest,
  type PaymasterConfig,
  type FeeTokenCapability,
  ensureIntNumber,
  standardErrorCodes,
} from '@jaw.id/core';
import { formatUnits, erc20Abi } from 'viem';
import { formatSpendAmount } from '../utils/displayFormat';
import type { Address, Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';

// Import UI components using relative paths (we're inside @jaw.id/ui)
import { OnboardingDialog } from '../components/OnboardingDialog';
import { DefaultDialog, type DefaultDialogProps } from '../components/DefaultDialog';
import { SignatureDialog } from '../components/SignatureDialog';
import { SiweDialog } from '../components/SiweDialog';
import { Eip712Dialog } from '../components/Eip712Dialog';
import { TransactionDialog } from '../components/TransactionDialog';
import { PermissionDialog } from '../components/PermissionDialog';
import { isWildcard } from '../components/PermissionDialog/Sections';
import { ConnectDialog } from '../components/ConnectDialog';
import { AddFundsDialog } from '../components/AddFundsDialog';
import { ResponsiveDialogAnchor } from '../components/DialogPresentation';
import { type FeeTokenOption } from '../components/FeeTokenSelector';
import { type LocalStorageAccount, type CreatedAccountData } from '../components/OnboardingDialog/types';
import {
  getStoredLocalAccounts,
  getLastAuthenticatedCredentialId,
} from '../components/OnboardingDialog/accountHelpers';
import { useChainIconURI } from '../hooks/useChainIconURI';
import { useGasEstimation } from '../hooks/useGasEstimation';
import { useAssetPreview } from '../hooks/useAssetPreview';
import { usePermissionExecution } from '../hooks/usePermissionExecution';
import { usePermissionRevocation } from '../hooks/usePermissionRevocation';
import { useFunctionSignatures } from '../hooks/useFunctionSignatures';
import { fetchTokenBalance, isNativeToken } from '../utils/tokenBalance';
import { resolvePaymaster } from '../utils/resolvePaymaster';
import { getPublicClient } from '../utils/publicClient';
import { getSiweOriginWarning, getSiweOriginWarningFromMessage, isSiweMessage, hexToUtf8 } from '../utils/siwe';
import { PortalContainerContext } from '../lib/utils';
import type { JawTheme } from '@jaw.id/core';
import { resolveTheme } from '../theme/resolve-theme.js';
import { applyThemeToContainer } from '../theme/apply-theme.js';
import { getSystemColorScheme, useColorScheme } from '../theme/use-color-scheme.js';

// How long signing dialogs hold the "Signed ✓" tick after delivery (dApp promise is
// already resolved by then — see handleApprove — so it never delays the dApp).
const SIGNED_TICK_MS = 850;

// ============================================================================
// Chain Utilities
// ============================================================================

/**
 * Get chain name from chain ID
 */
function getChainNameFromId(chainId: number): string {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  return chain?.name || 'Unknown Network';
}

// ============================================================================
// Permission Utilities
// ============================================================================

// Format timestamp to readable date
const formatExpiryDate = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

// Token info cache type
// `decimals: null` means the token's `decimals()` read failed. Kept distinct from a number so a
// failed read can never be mistaken for 18 — see utils/spendAmount.
type TokenInfoMap = Record<string, { decimals: number | null; symbol: string }>;

// Type assertion to fix React types version mismatch
const DefaultDialogComponent: React.ComponentType<DefaultDialogProps> =
  DefaultDialog as React.ComponentType<DefaultDialogProps>;

/**
 * Internal component that watches for system color scheme changes
 * and re-applies theme variables when mode is 'auto'.
 */
function ThemeWatcher({ theme, container }: { theme: JawTheme; container: HTMLElement }): null {
  const systemScheme = useColorScheme();

  useEffect(() => {
    // Only re-apply when mode is 'auto' (or unset, which defaults to auto)
    if (!theme.mode || theme.mode === 'auto') {
      const resolved = resolveTheme(theme, systemScheme);
      applyThemeToContainer(container, resolved);
    }
  }, [systemScheme, theme, container]);

  return null;
}

/**
 * Rejects the pending request when a dialog throws while rendering.
 *
 * Without this, a render throw leaves nothing mounted, `resolve`/`reject` never called,
 * and the container still in the top layer — so the caller waits forever and the host
 * page stays inert. React unmounts the tree on an uncaught error but cannot settle a
 * promise it knows nothing about. Renders nothing: a half-drawn signing screen is worse
 * than none.
 */
// Exported for tests only — deliberately absent from src/index.ts.
export class DialogErrorBoundary extends React.Component<
  { onError: (error: Error) => void; children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ReactUIHandler] Dialog render failed:', error, info.componentStack);
    // Deferred out of the commit phase: onError tears the dialog down, and unmounting a
    // root while React is still rendering warns and postpones the unmount anyway.
    queueMicrotask(() => this.props.onError(error));
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Options for ReactUIHandler constructor.
 */
export interface ReactUIHandlerOptions {
  /** Theme configuration. Takes precedence over theme provided via JAW.create(). */
  readonly theme?: JawTheme;
}

/**
 * React UI handler for app-specific mode
 *
 * This handler is automatically initialized by the SDK with the necessary configuration.
 * Simply pass a new instance to JAW.create() and the SDK will call init() with the config.
 *
 * @example
 * ```typescript
 * import { JAW, Mode } from '@jaw.id/core';
 * import { ReactUIHandler } from '@jaw.id/ui';
 *
 * const jaw = JAW.create({
 *   apiKey: 'your-api-key',
 *   defaultChainId: 1,
 *   preference: {
 *     mode: Mode.AppSpecific,
 *     uiHandler: new ReactUIHandler(),
 *   },
 * });
 *
 * // With theme:
 * const jaw2 = JAW.create({
 *   apiKey: 'your-api-key',
 *   theme: { mode: 'dark', accentColor: '#6366f1' },
 *   preference: {
 *     mode: Mode.AppSpecific,
 *     uiHandler: new ReactUIHandler({
 *       theme: { accentColor: '#7b3fe4', borderRadius: 'lg' },
 *     }),
 *   },
 * });
 * ```
 */
export class ReactUIHandler implements UIHandler {
  private config: UIHandlerConfig = {} as UIHandlerConfig;
  private localTheme?: JawTheme;
  /** Teardown of the request that resolved but is still holding its success tick. */
  private pendingTeardown: (() => void) | null = null;

  constructor(options?: ReactUIHandlerOptions) {
    this.localTheme = options?.theme;
  }

  /**
   * Initialize the handler with SDK configuration
   * Called automatically by the SDK - do not call directly
   */
  init(config: UIHandlerConfig): void {
    this.config = config;
  }

  /**
   * Update the theme without recreating the SDK or disconnecting.
   * Takes effect on the next dialog that opens.
   */
  setTheme(theme: JawTheme): void {
    this.localTheme = theme;
  }

  /** Merged theme: local theme wins over init-provided theme */
  private get effectiveTheme(): JawTheme {
    const initTheme = this.config.theme;
    if (!initTheme && !this.localTheme) return {};
    return { ...initTheme, ...this.localTheme };
  }

  async request<T = unknown>(request: UIRequest): Promise<UIResponse<T>> {
    // The previous request may have resolved and left its teardown on a timer so its
    // success tick could finish showing. Flush it now: left to fire on its own it
    // would land mid-flow and strip the body pointer-events lock and focus scope that
    // Radix sets up for THIS dialog, and briefly stack two modals in the top layer.
    this.pendingTeardown?.();

    return new Promise((resolve, reject) => {
      try {
        const container = document.createElement('dialog');
        container.setAttribute('data-jaw-modal-container', '');
        // Styling scope: every utility this package ships is emitted as `[data-jaw-ui] .foo`, so
        // the attribute is what makes the SDK's CSS apply — and what keeps it off the host page.
        container.setAttribute('data-jaw-ui', '');

        // Style isolation: prevent consumer app CSS from leaking into SDK modals.
        // Inline styles guarantee isolation regardless of CSS load order or specificity.
        Object.assign(container.style, {
          fontSize: '16px',
          fontStyle: 'normal',
          fontWeight: '400',
          fontVariant: 'normal',
          lineHeight: '1.5',
          letterSpacing: 'normal',
          wordSpacing: 'normal',
          textTransform: 'none',
          textIndent: '0',
          textAlign: 'left',
          textDecoration: 'none',
          textShadow: 'none',
          whiteSpace: 'normal',
          wordBreak: 'normal',
          overflowWrap: 'normal',
          direction: 'ltr',
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
          WebkitTapHighlightColor: 'transparent',
          // Reset native <dialog> chrome: the container is an invisible
          // full-viewport top layer; the Radix components inside draw the
          // actual overlay and dialog card exactly as before.
          position: 'fixed',
          inset: '0',
          width: '100vw',
          height: '100vh',
          maxWidth: 'none',
          maxHeight: 'none',
          margin: '0',
          padding: '0',
          border: 'none',
          background: 'transparent',
          pointerEvents: 'auto',
        });

        // Apply theme: resolves --jaw-* CSS variables onto the container.
        // fontFamily and color are set by the theme via --jaw-font-family and --jaw-color-foreground.
        const resolved = resolveTheme(this.effectiveTheme, getSystemColorScheme());
        applyThemeToContainer(container, resolved);

        // Append to body - Radix UI Dialog will handle all positioning
        document.body.appendChild(container);

        // Top-layer modal: the browser makes the rest of the page inert, so a
        // host app's own modal focus trap cannot steal focus from our inputs
        // (same mechanism as the iframe transport's <dialog data-jaw>).
        // Escape must keep flowing through Radix's close logic, not the
        // native dialog's instant close.
        const preventNativeClose = (e: Event) => e.preventDefault();
        if (typeof container.showModal === 'function') {
          container.addEventListener('cancel', preventNativeClose);
          container.showModal();
        }

        const root = createRoot(container);

        let torndown = false;
        let holdTimer: ReturnType<typeof setTimeout> | null = null;
        // The host promise must settle exactly once, and with the TRUE outcome.
        // `settled` makes first-wins explicit; `submissionInFlight` marks the window
        // where a signed transaction is racing the UI, so a render crash must not
        // report "rejected" for a submission that may still land on chain.
        let settled = false;
        let submissionInFlight = false;

        const settle = (response: UIResponse<T>) => {
          if (settled) return;
          settled = true;
          resolve(response);
        };

        const cleanup = () => {
          // Idempotent: a held teardown can be raced by ESC/outside-click during the
          // tick, by the next request flushing it, and by its own timer.
          if (torndown) return;
          torndown = true;
          if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
          }
          if (this.pendingTeardown === cleanup) this.pendingTeardown = null;

          try {
            document.body.style.removeProperty('pointer-events');

            root.unmount();
            container.removeEventListener('cancel', preventNativeClose);
            if (container.open) {
              container.close();
            }
            if (container.parentNode) {
              container.parentNode.removeChild(container);
            }
          } catch (cleanupError) {
            console.error('[ReactUIHandler] Cleanup error:', cleanupError);
          }
        };

        const handleApprove = (data: T, holdMs = 0) => {
          if (holdMs > 0) {
            // Signing dialogs: resolve the dApp first, then defer teardown so the tick
            // shows. Registered on the handler so the next request can flush it instead
            // of letting it fire underneath a newer dialog.
            settle({ id: request.id, approved: true, data });
            this.pendingTeardown = cleanup;
            holdTimer = setTimeout(cleanup, holdMs);
          } else {
            cleanup();
            settle({ id: request.id, approved: true, data });
          }
        };

        const handleReject = (error?: Error) => {
          cleanup();
          settle({
            id: request.id,
            approved: false,
            error: (error as UIError) || UIError.userRejected(),
          });
        };

        // Render appropriate dialog based on request type
        const dialog = this.renderDialog(request, handleApprove, handleReject, (inFlight: boolean) => {
          submissionInFlight = inFlight;
        });
        const effectiveTheme = this.effectiveTheme;
        root.render(
          React.createElement(
            PortalContainerContext.Provider,
            { value: container },
            React.createElement(ThemeWatcher, {
              theme: effectiveTheme,
              container,
            }),
            React.createElement(DialogErrorBoundary, {
              onError: (error: Error) => {
                if (submissionInFlight) {
                  // The UI crashed while a signed submission is racing it. Tear down the
                  // broken dialog but do NOT settle: the in-flight sendCalls closure is
                  // still alive and its own onApprove/onReject delivers the true outcome
                  // (rejecting here could report "rejected" for a tx that lands on chain).
                  console.error('[ReactUIHandler] Dialog crashed mid-submission:', error);
                  cleanup();
                  return;
                }
                handleReject(new Error(`The wallet could not display this request: ${error.message}`));
              },
              // No host shell lays these dialogs out (the iframe transport has
              // EmbeddedShell), so the presentation is chosen from the viewport
              // here: bottom sheet on phones, centered card otherwise. Inside
              // the boundary, so a throw from it is caught like any other
              // render failure.
              children: React.createElement(ResponsiveDialogAnchor, null, dialog),
            })
          )
        );
      } catch (error) {
        console.error('[ReactUIHandler] Error in request:', error);
        reject(error);
      }
    });
  }

  canHandle(request: UIRequest): boolean {
    return [
      'wallet_connect',
      'personal_sign',
      'eth_signTypedData_v4',
      'wallet_sendCalls',
      'eth_sendTransaction',
      'wallet_grantPermissions',
      'wallet_revokePermissions',
      'wallet_sign',
      'wallet_addFunds',
    ].includes(request.type);
  }

  async cleanup(): Promise<void> {
    // Cleanup any remaining modals
    const containers = document.querySelectorAll('[data-jaw-modal-container]');
    containers.forEach((container: Element) => {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    });
  }

  /**
   * Every wrapper below is keyed by `request.id` as belt-and-braces, not because anything is
   * reused today: `request()` mounts a fresh root in a fresh container per request, so each
   * dialog already gets a brand-new component instance.
   *
   * The keys exist for a future refactor that keeps one root mounted across requests. Each
   * wrapper holds request-scoped state — a fetched permission, token metadata, a loading flag —
   * that a prop change would not reset, so in a shared-root world an unkeyed wrapper would render
   * a new request against the previous one's data. The popup's `page.tsx` is that world (one tree
   * mounted across requests) and relies on the same keying for correctness.
   */
  private renderDialog(
    request: UIRequest,
    onApprove: (data: any) => void,
    onReject: (error?: Error) => void,
    onSubmissionInFlight?: (inFlight: boolean) => void
  ): React.ReactElement {
    switch (request.type) {
      case 'wallet_connect':
        return (
          <OnboardingDialogWrapper
            key={request.id}
            request={request as ConnectUIRequest}
            onApprove={onApprove}
            onReject={onReject}
            apiKey={this.config.apiKey}
            defaultChainId={this.config.defaultChainId}
            paymasters={this.config.paymasters}
            ens={this.config.ens}
          />
        );

      case 'personal_sign': {
        const signRequest = request as SignatureUIRequest;
        // Check if this is a SIWE message
        if (isSiweMessage(signRequest.data.message)) {
          return (
            <SiweDialogWrapper
              key={request.id}
              request={signRequest}
              onApprove={onApprove}
              onReject={onReject}
              apiKey={this.config.apiKey}
              defaultChainId={this.config.defaultChainId}
              paymasters={this.config.paymasters}
              appName={this.config.appName}
              appLogoUrl={this.config.appLogoUrl}
            />
          );
        }
        return (
          <SignatureDialogWrapper
            key={request.id}
            request={signRequest}
            onApprove={onApprove}
            onReject={onReject}
            apiKey={this.config.apiKey}
            defaultChainId={this.config.defaultChainId}
            paymasters={this.config.paymasters}
            appName={this.config.appName}
            appLogoUrl={this.config.appLogoUrl}
          />
        );
      }

      case 'wallet_sign': {
        const walletSignRequest = request as WalletSignUIRequest;
        const signType = walletSignRequest.data.request.type;

        if (signType === '0x45') {
          // ERC-7871 PersonalSign - data is { message: string }
          const requestData = walletSignRequest.data.request.data as {
            message: string;
          };
          const message = requestData.message;
          if (isSiweMessage(message)) {
            return (
              <SiweDialogWrapper
                key={request.id}
                request={
                  {
                    ...walletSignRequest,
                    type: 'personal_sign',
                    data: {
                      message,
                      address: walletSignRequest.data.address,
                      chainId: walletSignRequest.data.chainId,
                    },
                  } as SignatureUIRequest
                }
                onApprove={onApprove}
                onReject={onReject}
                apiKey={this.config.apiKey}
                defaultChainId={this.config.defaultChainId}
                paymasters={this.config.paymasters}
                appName={this.config.appName}
                appLogoUrl={this.config.appLogoUrl}
              />
            );
          }
          return (
            <SignatureDialogWrapper
              key={request.id}
              request={
                {
                  ...walletSignRequest,
                  type: 'personal_sign',
                  data: {
                    message,
                    address: walletSignRequest.data.address,
                    chainId: walletSignRequest.data.chainId,
                  },
                } as SignatureUIRequest
              }
              onApprove={onApprove}
              onReject={onReject}
              apiKey={this.config.apiKey}
              defaultChainId={this.config.defaultChainId}
              paymasters={this.config.paymasters}
              appName={this.config.appName}
              appLogoUrl={this.config.appLogoUrl}
            />
          );
        } else if (signType === '0x01') {
          // ERC-7871 TypedData - data can be either a JSON string or an object
          const typedDataRaw = walletSignRequest.data.request.data;
          // If it's already a string, use it directly; otherwise JSON.stringify it
          const typedDataJson = typeof typedDataRaw === 'string' ? typedDataRaw : JSON.stringify(typedDataRaw);
          return (
            <Eip712DialogWrapper
              key={request.id}
              request={
                {
                  ...walletSignRequest,
                  type: 'eth_signTypedData_v4',
                  data: {
                    typedData: typedDataJson,
                    address: walletSignRequest.data.address,
                    chainId: walletSignRequest.data.chainId,
                  },
                } as TypedDataUIRequest
              }
              onApprove={onApprove}
              onReject={onReject}
              apiKey={this.config.apiKey}
              defaultChainId={this.config.defaultChainId}
              paymasters={this.config.paymasters}
              appName={this.config.appName}
              appLogoUrl={this.config.appLogoUrl}
            />
          );
        } else {
          // Unsupported sign type
          return <UnsupportedMethodDialogWrapper method={`wallet_sign (type: ${signType})`} onReject={onReject} />;
        }
      }

      case 'eth_signTypedData_v4':
        return (
          <Eip712DialogWrapper
            key={request.id}
            request={request as TypedDataUIRequest}
            onApprove={onApprove}
            onReject={onReject}
            apiKey={this.config.apiKey}
            defaultChainId={this.config.defaultChainId}
            paymasters={this.config.paymasters}
            appName={this.config.appName}
            appLogoUrl={this.config.appLogoUrl}
          />
        );

      case 'wallet_sendCalls':
        return (
          <TransactionDialogWrapper
            key={request.id}
            request={request as TransactionUIRequest}
            onApprove={onApprove}
            onReject={onReject}
            onSubmissionInFlight={onSubmissionInFlight}
            apiKey={this.config.apiKey}
            defaultChainId={this.config.defaultChainId}
            paymasters={this.config.paymasters}
            appName={this.config.appName}
            appLogoUrl={this.config.appLogoUrl}
          />
        );

      case 'eth_sendTransaction':
        return (
          <SendTransactionDialogWrapper
            key={request.id}
            request={request as SendTransactionUIRequest}
            onApprove={onApprove}
            onReject={onReject}
            onSubmissionInFlight={onSubmissionInFlight}
            apiKey={this.config.apiKey}
            defaultChainId={this.config.defaultChainId}
            paymasters={this.config.paymasters}
            appName={this.config.appName}
            appLogoUrl={this.config.appLogoUrl}
          />
        );

      case 'wallet_grantPermissions':
        return (
          <PermissionDialogWrapper
            key={request.id}
            request={request as PermissionUIRequest}
            onApprove={onApprove}
            onReject={onReject}
            onSubmissionInFlight={onSubmissionInFlight}
            apiKey={this.config.apiKey}
            defaultChainId={this.config.defaultChainId}
            paymasters={this.config.paymasters}
            appName={this.config.appName}
            appLogoUrl={this.config.appLogoUrl}
          />
        );

      case 'wallet_revokePermissions':
        return (
          <RevokePermissionDialogWrapper
            key={request.id}
            request={request as RevokePermissionUIRequest}
            onApprove={onApprove}
            onReject={onReject}
            onSubmissionInFlight={onSubmissionInFlight}
            apiKey={this.config.apiKey}
            defaultChainId={this.config.defaultChainId}
            paymasters={this.config.paymasters}
            appName={this.config.appName}
            appLogoUrl={this.config.appLogoUrl}
          />
        );

      case 'wallet_addFunds':
        return (
          <AddFundsDialogWrapper
            key={request.id}
            request={request as AddFundsUIRequest}
            onApprove={onApprove}
            apiKey={this.config.apiKey}
            appName={this.config.appName}
            appLogoUrl={this.config.appLogoUrl}
          />
        );

      default: {
        // Fallback for unsupported methods
        return <UnsupportedMethodDialogWrapper method={(request as UIRequest).type} onReject={onReject} />;
      }
    }
  }
}

// Helper to build chain config with auto-resolved RPC URL from API key
// Used by OnboardingDialogWrapper which needs lower-level control
function buildChainConfigFromApiKey(chainId: number, apiKey?: string, paymasterUrl?: string): Chain {
  return {
    id: chainId,
    rpcUrl: apiKey ? `${JAW_RPC_URL}?chainId=${chainId}&api-key=${apiKey}` : `${JAW_RPC_URL}?chainId=${chainId}`,
    ...(paymasterUrl && { paymaster: { url: paymasterUrl } }),
  };
}

// Helper to build mainnet RPC URL for JustaName SDK (ENS resolution always uses mainnet)
function getMainnetRpcUrl(apiKey?: string): string {
  return apiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${apiKey}` : `${JAW_RPC_URL}?chainId=1`;
}

// Helper to get Account for signing operations
async function getAccountForSigning(apiKey?: string, chainId?: number, paymasterUrl?: string): Promise<Account> {
  if (!apiKey) {
    throw new Error('API key is required for signing operations');
  }
  const targetChainId = chainId || 1;
  return await Account.get({
    chainId: targetChainId,
    apiKey,
    paymasterUrl,
  });
}

// OnboardingDialogWrapper - handles passkey authentication flow with ConnectDialog confirmation
function OnboardingDialogWrapper({
  request,
  onApprove,
  onReject,
  apiKey,
  defaultChainId,
  paymasters,
  ens,
}: {
  request: ConnectUIRequest;
  onApprove: (data: any) => void;
  onReject: (error?: Error) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  ens?: string;
}) {
  const [open, setOpen] = useState(true);
  const [accounts, setAccounts] = useState<LocalStorageAccount[]>(() => getStoredLocalAccounts(apiKey));
  const [lastAuthenticatedCredentialId, setLastAuthenticatedCredentialId] = useState<string | null>(() =>
    getLastAuthenticatedCredentialId(apiKey)
  );
  // Re-read accounts and auth state from storage. Must run after flows that write them
  // (import, account creation), so cancelling a later dialog returns to a fresh default
  // instead of a stale "Continue as" account.
  const refreshAccounts = () => {
    setAccounts(getStoredLocalAccounts(apiKey));
    setLastAuthenticatedCredentialId(getLastAuthenticatedCredentialId(apiKey));
  };
  const [loggingInAccount, setLoggingInAccount] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // State for ConnectDialog confirmation
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [authenticatedAccountName, setAuthenticatedAccountName] = useState<string | null>(null);
  const [authenticatedWalletAddress, setAuthenticatedWalletAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // State for SIWE signing flow
  const [isSiweSigning, setIsSiweSigning] = useState(false);
  const [siweStatus, setSiweStatus] = useState<string>('');

  // Get rpId from current domain
  const rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const rpName = 'JAW';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'unknown';

  // Get chain info for ConnectDialog
  const targetChainId = request.data.chainId || defaultChainId || 1;
  const chainName = getChainNameFromId(targetChainId);
  const chainIcon = useChainIconURI(targetChainId, apiKey, 24);

  // Silent mode: check for existing auth state and use it directly
  // This mirrors the cross-platform behavior where jaw:passkey:authState is checked
  useEffect(() => {
    if (!request.data.silent) {
      return;
    }

    // Check if there's an existing authenticated session
    const authenticatedAddress = Account.getAuthenticatedAddress(apiKey);

    if (authenticatedAddress) {
      // User is already authenticated - approve immediately without showing any UI
      // Use setTimeout to defer the call and avoid unmounting during render
      setTimeout(() => {
        onApprove({
          accounts: [{ address: authenticatedAddress }],
        });
      }, 0);
    }
    // If not authenticated, fall back to showing OnboardingDialog
    // (the normal UI flow will handle account creation/login)
  }, [request.data.silent, apiKey, onApprove]);

  const handleCancel = () => {
    setOpen(false);
    setShowConnectDialog(false);
    onReject(UIError.userRejected());
  };

  // Handle ConnectDialog confirmation
  const handleConnectConfirm = () => {
    if (authenticatedWalletAddress) {
      setIsConnecting(true);
      onApprove({
        accounts: [{ address: authenticatedWalletAddress }],
      });
    }
  };

  // Handle ConnectDialog cancel
  const handleConnectCancel = () => {
    setShowConnectDialog(false);
    setAuthenticatedAccountName(null);
    setAuthenticatedWalletAddress(null);
    setLoggingInAccount(null);
    // Return to account selection
  };

  // Handle selecting an existing account
  const handleAccountSelect = async (account: LocalStorageAccount) => {
    if (!account.credentialId) {
      console.error('No credential ID for account');
      return;
    }

    try {
      if (!apiKey) {
        throw new Error('API key is required');
      }
      setLoggingInAccount(account.username);

      // Use Account.get which handles WebAuthn authentication and stores auth state
      const accountInstance = await Account.get(
        {
          chainId: targetChainId,
          apiKey,
          paymasterUrl: paymasters?.[targetChainId]?.url,
        },
        account.credentialId
      );

      // If silent mode, skip ConnectDialog and approve immediately
      if (request.data.silent) {
        onApprove({
          accounts: [{ address: accountInstance.address }],
        });
        return;
      }

      // If SIWE is requested, show ConnectDialog for confirmation
      if (signInWithEthereumCapability) {
        setAuthenticatedAccountName(account.username);
        setAuthenticatedWalletAddress(accountInstance.address);
        setShowConnectDialog(true);
        return;
      }

      // No SIWE: skip ConnectDialog and approve immediately in app-specific mode
      onApprove({
        accounts: [{ address: accountInstance.address }],
      });
    } catch (error) {
      console.error('Login failed:', error);
      setLoggingInAccount(null);
    }
  };

  // Handle importing an existing passkey from cloud
  const handleImportAccount = async () => {
    try {
      if (!apiKey) {
        throw new Error('API key is required');
      }
      setIsImporting(true);

      // Use Account.import which handles everything
      const accountInstance = await Account.import({
        chainId: targetChainId,
        apiKey,
        paymasterUrl: paymasters?.[targetChainId]?.url,
      });

      // Import wrote the account + auth state to storage
      refreshAccounts();

      const metadata = accountInstance.getMetadata();

      // If silent mode, skip ConnectDialog and approve immediately
      if (request.data.silent) {
        setIsImporting(false);
        onApprove({
          accounts: [{ address: accountInstance.address }],
        });
        return;
      }

      // If SIWE is requested, show ConnectDialog for confirmation
      if (signInWithEthereumCapability) {
        setAuthenticatedAccountName(metadata?.username || 'Imported Account');
        setAuthenticatedWalletAddress(accountInstance.address);
        setShowConnectDialog(true);
        setIsImporting(false);
        return;
      }

      // No SIWE: skip ConnectDialog and approve immediately in app-specific mode
      setIsImporting(false);
      onApprove({
        accounts: [{ address: accountInstance.address }],
      });
    } catch (error) {
      console.error('Import failed:', error);
      setIsImporting(false);
    }
  };

  // Handle creating a new account
  const handleCreateAccount = async (username: string): Promise<CreatedAccountData> => {
    try {
      if (!apiKey) {
        throw new Error('API key is required');
      }
      setIsCreating(true);

      // Get chainId from request or default
      const createChainId = request.data.chainId || defaultChainId || 1;

      // Construct full subname when ENS is enabled (e.g., "john.example.eth")
      const fullUsername = ensDomain ? `${username.trim()}.${ensDomain}` : username.trim();

      // Use Account.create which handles everything
      const accountInstance = await Account.create(
        {
          chainId: createChainId,
          apiKey,
          paymasterUrl: paymasters?.[createChainId]?.url,
          rpId,
          rpName,
        },
        {
          username: fullUsername,
        }
      );

      // Get full account data including credentialId and publicKey from stored accounts
      const storedAccounts = Account.getStoredAccounts(apiKey);
      const createdAccount = storedAccounts.find((acc) => acc.username === fullUsername);

      if (!createdAccount) {
        throw new Error('Failed to retrieve created account data');
      }

      // Return full account data - OnboardingDialog will pass it to onAccountCreationComplete
      return {
        address: accountInstance.address,
        credentialId: createdAccount.credentialId,
        username: fullUsername,
        publicKey: createdAccount.publicKey,
      };
    } catch (error) {
      console.error('Account creation failed:', error);
      setIsCreating(false);
      throw error;
    }
  };

  // Handle account creation completion (after subname registration if applicable)
  // Account data flows through from onCreateAccount - no intermediate state needed
  const handleAccountCreationComplete = async (accountData: CreatedAccountData) => {
    // Creation wrote the account + auth state to storage
    refreshAccounts();
    // If silent mode, skip ConnectDialog and approve immediately
    if (request.data.silent) {
      setIsCreating(false);
      onApprove({
        accounts: [{ address: accountData.address }],
      });
      return;
    }

    // If SIWE is requested, show ConnectDialog for confirmation
    if (signInWithEthereumCapability) {
      setAuthenticatedAccountName(accountData.username || 'New Account');
      setAuthenticatedWalletAddress(accountData.address);
      setShowConnectDialog(true);
      setIsCreating(false);
      return;
    }

    // No SIWE: skip ConnectDialog and approve immediately in app-specific mode
    setIsCreating(false);
    onApprove({
      accounts: [{ address: accountData.address }],
    });
  };

  // Get config from request - capabilities is Record<string, unknown>
  const ensDomain = ens as string | undefined;
  const chainId = request.data.chainId || defaultChainId || 1;
  const subnameTextRecords = request.data.capabilities?.subnameTextRecords as
    | SubnameTextRecordCapabilityRequest
    | undefined;

  // Extract signInWithEthereum capability if present
  const signInWithEthereumCapability = request.data.capabilities?.signInWithEthereum as
    | SignInWithEthereumCapabilityRequest
    | undefined;

  // Build SIWE message from capability if present
  const siweMessage = useMemo(() => {
    if (!signInWithEthereumCapability || !authenticatedWalletAddress) return null;

    try {
      // Extract domain and URI from origin
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
        address: authenticatedWalletAddress as `0x${string}`,
        chainId: chainIdNumber,
        domain: signInWithEthereumCapability.domain || defaultDomain,
        nonce: signInWithEthereumCapability.nonce,
        uri: signInWithEthereumCapability.uri || defaultUri,
        version: '1',
        statement: signInWithEthereumCapability.statement,
        issuedAt: signInWithEthereumCapability.issuedAt ? new Date(signInWithEthereumCapability.issuedAt) : new Date(),
        expirationTime: signInWithEthereumCapability.expirationTime
          ? new Date(signInWithEthereumCapability.expirationTime)
          : undefined,
        notBefore: signInWithEthereumCapability.notBefore
          ? new Date(signInWithEthereumCapability.notBefore)
          : undefined,
        requestId: signInWithEthereumCapability.requestId,
        resources: signInWithEthereumCapability.resources,
      });
    } catch (error) {
      console.error('Failed to build SIWE message:', error);
      return null;
    }
  }, [signInWithEthereumCapability, authenticatedWalletAddress, origin]);

  const siweWarning = useMemo(
    () =>
      getSiweOriginWarning(origin, {
        domain: signInWithEthereumCapability?.domain,
        uri: signInWithEthereumCapability?.uri,
      }),
    [origin, signInWithEthereumCapability]
  );

  // Handle SIWE sign action
  const handleSiweSign = async () => {
    if (!authenticatedWalletAddress || !siweMessage) return;

    setIsSiweSigning(true);
    setSiweStatus('Signing message...');

    try {
      // Restore account for signing
      const account = await getAccountForSigning(apiKey, targetChainId, paymasters?.[targetChainId]?.url);

      // Sign the SIWE message
      const signature = await account.signMessage(siweMessage);

      setSiweStatus('Sign-in successful!');

      // Build response per ERC-7846 format with SIWE capability
      onApprove({
        accounts: [
          {
            address: authenticatedWalletAddress,
            capabilities: {
              signInWithEthereum: {
                message: siweMessage,
                signature: signature as `0x${string}`,
              },
            },
          },
        ],
      });
    } catch (error) {
      console.error('SIWE signature failed:', error);
      setSiweStatus(`Error: ${(error as Error).message}`);
      setIsSiweSigning(false);
    }
  };

  // Handle SIWE cancel
  const handleSiweCancel = () => {
    if (!isSiweSigning) {
      setShowConnectDialog(false);
      setAuthenticatedAccountName(null);
      setAuthenticatedWalletAddress(null);
      setLoggingInAccount(null);
      setSiweStatus('');
      // Return to account selection
    }
  };

  // If showing confirmation dialog and SIWE capability is present, show SiweDialog
  // Note: We check signInWithEthereumCapability first, then siweMessage will be computed
  if (showConnectDialog && authenticatedWalletAddress && signInWithEthereumCapability) {
    // siweMessage should be available since authenticatedWalletAddress is set
    if (!siweMessage) {
      // This shouldn't happen normally, but if SIWE message couldn't be built, fall through to ConnectDialog
      console.error('SIWE capability present but message could not be built');
    } else {
      return (
        <SiweDialog
          open={true}
          onOpenChange={(newOpen) => {
            if (!newOpen) handleSiweCancel();
          }}
          message={siweMessage}
          origin={origin}
          appName={request.data.appName || 'dApp'}
          appLogoUrl={request.data.appLogoUrl ?? undefined}
          accountAddress={authenticatedWalletAddress}
          chainName={chainName}
          chainId={targetChainId}
          chainIcon={chainIcon}
          mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
          onSign={handleSiweSign}
          onCancel={handleSiweCancel}
          isProcessing={isSiweSigning}
          siweStatus={siweStatus}
          canSign={!isSiweSigning}
          warningMessage={siweWarning}
        />
      );
    }
  }

  // If showing ConnectDialog confirmation (no SIWE), render that instead
  if (showConnectDialog && authenticatedWalletAddress) {
    return (
      <ConnectDialog
        open={true}
        onOpenChange={(newOpen) => {
          if (!newOpen) handleConnectCancel();
        }}
        appName={request.data.appName || 'dApp'}
        appLogoUrl={request.data.appLogoUrl ?? undefined}
        origin={origin}
        accountName={authenticatedAccountName || 'Account'}
        walletAddress={authenticatedWalletAddress}
        chainName={chainName}
        chainId={targetChainId}
        chainIcon={chainIcon}
        mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
        onConnect={async () => handleConnectConfirm()}
        onCancel={handleConnectCancel}
        showPermissions={false}
        isProcessing={isConnecting}
      />
    );
  }

  return (
    <DefaultDialogComponent
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      // OnboardingDialog brings its own DialogShell, which applies the
      // home-bar inset inside its own surface — the sheet must not add a
      // second one (see ShellDialog, which does the same for every other
      // revamped dialog).
      ownsBottomInset
      contentStyle={{
        width: 'fit-content',
        maxWidth: '450px',
        background: 'transparent',
        border: 'none',
        boxShadow: 'none',
      }}
      innerStyle={{ padding: 0, overflow: 'visible' }}
    >
      <OnboardingDialog
        // The SAME handleCancel the outside-click dismiss above already calls — the X is only a
        // visible affordance for the existing decline path, not a second one.
        onClose={handleCancel}
        accounts={accounts}
        onAccountSelect={handleAccountSelect}
        loggingInAccount={loggingInAccount}
        onImportAccount={handleImportAccount}
        isImporting={isImporting}
        onCreateAccount={handleCreateAccount}
        onAccountCreationComplete={handleAccountCreationComplete}
        onAccountCreationError={() => setIsCreating(false)}
        isCreating={isCreating}
        ensDomain={ensDomain}
        chainId={chainId}
        mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
        apiKey={apiKey}
        lastAuthenticatedCredentialId={lastAuthenticatedCredentialId}
        supportedChains={SUPPORTED_CHAINS.map((chain) => ({ id: chain.id }))}
        subnameTextRecords={subnameTextRecords}
      />
    </DefaultDialogComponent>
  );
}

function SignatureDialogWrapper({
  request,
  onApprove,
  onReject,
  apiKey,
  defaultChainId,
  paymasters,
  appName,
  appLogoUrl,
}: {
  request: SignatureUIRequest;
  onApprove: (data: any, holdMs?: number) => void;
  onReject: (error?: Error) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [signatureStatus, setSignatureStatus] = useState<string>('');

  // Use chainId from request (current chain), fallback to defaultChainId
  const chainId = request.data.chainId || defaultChainId || 1;
  const chainName = getChainNameFromId(chainId);
  const chainIcon = useChainIconURI(chainId, apiKey, 24);

  const handleSign = async () => {
    setIsProcessing(true);
    setSignatureStatus('Signing message...');
    try {
      // Restore account for signing
      const account = await getAccountForSigning(apiKey, chainId, paymasters?.[chainId]?.url);

      // Sign the message
      const signature = await account.signMessage(request.data.message, { address: request.data.address });

      setSignatureStatus('Signature successful!');
      // Deliver, then hold the tick (onApprove resolves now, defers teardown — no delay).
      onApprove(signature, SIGNED_TICK_MS);
      setIsSuccess(true);
    } catch (error) {
      console.error('Signature failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      setSignatureStatus(`Error: ${errorObj.message}`);
      // Check if user cancelled passkey prompt (NotAllowedError)
      if (errorObj.name === 'NotAllowedError') {
        onReject(UIError.userRejected('User cancelled the passkey prompt'));
      } else {
        // Internal error
        onReject(new UIError(standardErrorCodes.rpc.internal as UIErrorCode, errorObj.message));
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    onReject(UIError.userRejected());
  };

  return (
    <SignatureDialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      message={request.data.message}
      origin={typeof window !== 'undefined' ? window.location.origin : 'unknown'}
      appName={appName}
      appLogoUrl={appLogoUrl}
      accountAddress={request.data.address}
      chainName={chainName}
      chainId={chainId}
      chainIcon={chainIcon}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      onSign={handleSign}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      isSuccess={isSuccess}
      signatureStatus={signatureStatus}
      canSign={!isProcessing && !!request.data.message}
    />
  );
}

function Eip712DialogWrapper({
  request,
  onApprove,
  onReject,
  apiKey,
  defaultChainId,
  paymasters,
  appName,
  appLogoUrl,
}: {
  request: TypedDataUIRequest;
  onApprove: (data: any, holdMs?: number) => void;
  onReject: (error?: Error) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [signatureStatus, setSignatureStatus] = useState<string>('');

  // Use chainId from request (current chain), fallback to defaultChainId
  const chainId = request.data.chainId || defaultChainId || 1;
  const chainName = getChainNameFromId(chainId);
  const chainIcon = useChainIconURI(chainId, apiKey, 24);

  const handleSign = async () => {
    setIsProcessing(true);
    setSignatureStatus('Signing typed data...');
    try {
      // Restore account for signing
      const account = await getAccountForSigning(apiKey, chainId, paymasters?.[chainId]?.url);

      // Parse typed data if it's a string
      const typedData =
        typeof request.data.typedData === 'string' ? JSON.parse(request.data.typedData) : request.data.typedData;

      // Sign the typed data
      const signature = await account.signTypedData(
        {
          domain: typedData.domain,
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        },
        { address: request.data.address }
      );

      setSignatureStatus('Signature successful!');
      // Deliver to the dApp, then hold the tick (no delay — see handleApprove).
      onApprove(signature, SIGNED_TICK_MS);
      setIsSuccess(true);
    } catch (error) {
      console.error('EIP-712 signature failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      setSignatureStatus(`Error: ${errorObj.message}`);
      // Check if user cancelled passkey prompt (NotAllowedError)
      if (errorObj.name === 'NotAllowedError') {
        onReject(UIError.userRejected('User cancelled the passkey prompt'));
      } else {
        // Internal error
        onReject(new UIError(standardErrorCodes.rpc.internal as UIErrorCode, errorObj.message));
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    onReject(UIError.userRejected());
  };

  return (
    <Eip712Dialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      typedDataJson={request.data.typedData}
      origin={typeof window !== 'undefined' ? window.location.origin : 'unknown'}
      appName={appName}
      appLogoUrl={appLogoUrl}
      accountAddress={request.data.address}
      chainName={chainName}
      chainId={chainId}
      chainIcon={chainIcon}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      onSign={handleSign}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      isSuccess={isSuccess}
      signatureStatus={signatureStatus}
      canSign={!isProcessing && !!request.data.typedData}
    />
  );
}

function TransactionDialogWrapper({
  request,
  onApprove,
  onReject,
  onSubmissionInFlight,
  apiKey,
  defaultChainId,
  paymasters,
  appName,
  appLogoUrl,
}: {
  request: TransactionUIRequest;
  onApprove: (data: any) => void;
  onReject: (error?: Error) => void;
  /** Marks the window where a signed submission is racing the UI (see request()). */
  onSubmissionInFlight?: (inFlight: boolean) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  // Synchronous re-entry guard: isProcessing disables the button only after a
  // re-render, which is too soft a gate for a call that moves funds (permission
  // and EIP-7702 paths sign without a passkey prompt).
  const submittingRef = useRef(false);
  const [account, setAccount] = useState<Account | null>(null);
  // Fee token state for ERC-20 paymaster
  const [feeTokens, setFeeTokens] = useState<FeeTokenOption[]>([]);
  const [feeTokensLoading, setFeeTokensLoading] = useState(false);

  const chainId = request.data.chainId || defaultChainId || 1;
  const viemChain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  const networkName = viemChain?.name || 'Unknown Network';

  // The paymaster of the request, url and context together (EIP-5792
  // paymasterService capability first, then the one configured for the chain).
  // Taking the two halves apart let a capabilities url pick up a context written
  // for a different paymaster.
  const { url: effectivePaymasterUrl, context: effectivePaymasterContext } = useMemo(
    () => resolvePaymaster(request.data.capabilities?.paymasterService, paymasters?.[chainId]),
    [request.data.capabilities?.paymasterService, paymasters, chainId]
  );

  const isSponsored = !!effectivePaymasterUrl;

  // Transform calls to transactions format expected by dialog
  const transactions = useMemo(
    () =>
      request.data.calls.map((call) => ({
        to: call.to,
        data: call.data,
        value: call.value,
        chainId: request.data.chainId,
      })),
    [request.data.calls, request.data.chainId]
  );

  // Convert transactions to call format for Account operations
  const transactionCalls = useMemo(() => {
    return request.data.calls.map((call) => ({
      to: call.to as Address,
      value: call.value ? BigInt(call.value) : undefined, // Convert string wei to bigint
      data: (call.data || '0x') as Hex,
    }));
  }, [request.data.calls]);

  // Permission ID for permission-based execution
  const permissionId = request.data.capabilities?.permissions?.id as Hex | undefined;

  const {
    onBehalfOf,
    loading: onBehalfOfLoading,
    problem: permissionProblem,
  } = usePermissionExecution({
    permissionId,
    apiKey,
    chainId,
    from: request.data.from as Address | undefined,
    calls: transactionCalls,
  });

  const {
    assetsOut,
    assetsIn,
    error: assetPreviewError,
    willRevert: assetPreviewWillRevert,
    revertCause: assetPreviewRevertCause,
  } = useAssetPreview({
    // Under a permission the calls execute as the granter, so the balance changes are theirs.
    // Left undefined until the granter resolves: simulating from the spender would preview the
    // wrong account, and a shortfall there would briefly read as "Insufficient funds".
    account: permissionId ? onBehalfOf : (request.data.from as Address | undefined),
    calls: transactionCalls,
    chainId,
    apiKey,
  });

  // Use gas estimation hook for parallel ETH and ERC-20 estimation
  const {
    gasFee,
    gasFeeLoading,
    gasEstimationError,
    tokenEstimates,
    selectedFeeToken,
    setSelectedFeeToken,
    isPayingWithErc20,
  } = useGasEstimation({
    account,
    transactionCalls,
    chainId,
    apiKey,
    feeTokens,
    isSponsored,
    permissionId,
    address: request.data.from,
    onFeeTokensUpdate: setFeeTokens,
  });

  // Compute paymaster URL based on fee token selection (for ERC-20 paymaster)
  const computedPaymasterUrl = useMemo(() => {
    // If already sponsored via capabilities or config, use that
    if (effectivePaymasterUrl) return effectivePaymasterUrl;

    // If user selected an ERC-20 token (non-native), use ERC-20 paymaster
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      return `${JAW_PAYMASTER_URL}?chainId=${chainId}${apiKey ? `&api-key=${apiKey}` : ''}`;
    }

    // Native ETH - no paymaster needed
    return undefined;
  }, [effectivePaymasterUrl, selectedFeeToken, chainId, apiKey]);

  // Compute paymaster context based on fee token selection
  const computedPaymasterContext = useMemo(() => {
    // If using ERC-20 paymaster, include token address and gas amount in context
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      // Use the actual estimate from tokenEstimates if available
      const estimate = tokenEstimates.find(
        (e) => e.tokenAddress.toLowerCase() === selectedFeeToken.address.toLowerCase()
      );

      if (estimate) {
        return buildErc20PaymasterContext(estimate);
      }

      // No estimate yet: omit `gas` so Account.createErc20ApprovalCall estimates
      // the worst-case ceiling itself, instead of a client-side USD guess that
      // ignores the exchange rate and can under-approve.
      return { token: selectedFeeToken.address };
    }
    return effectivePaymasterContext;
  }, [selectedFeeToken, effectivePaymasterContext, tokenEstimates]);

  // Fetch fee tokens when not sponsored (for ERC-20 paymaster option)
  useEffect(() => {
    // Skip if already sponsored via capabilities or config
    if (effectivePaymasterUrl) return;

    let isMounted = true;

    const fetchFeeTokensData = async () => {
      setFeeTokensLoading(true);
      try {
        // Fetch capabilities from JAW RPC
        const capabilities = await handleGetCapabilitiesRequest(
          { method: 'wallet_getCapabilities', params: [] },
          apiKey || '',
          true // showTestnets
        );

        const chainIdHex = `0x${chainId.toString(16)}` as `0x${string}`;
        const feeTokenCap = capabilities?.[chainIdHex]?.feeToken as FeeTokenCapability | undefined;

        if (!feeTokenCap?.supported || !feeTokenCap?.tokens?.length) {
          if (isMounted) setFeeTokensLoading(false);
          return;
        }

        // Get RPC URL for balance fetching
        const rpcUrl =
          buildChainConfigFromApiKey(chainId, apiKey).rpcUrl ||
          viemChain?.rpcUrls?.default?.http?.[0] ||
          `https://eth.llamarpc.com`;

        // Fetch balances in parallel
        const tokensWithBalances = await Promise.all(
          feeTokenCap.tokens.map(async (token) => {
            try {
              const balance = await fetchTokenBalance(token.address, request.data.from, rpcUrl, chainId);
              const balanceFormatted = formatUnits(balance, token.decimals);
              const isNative = isNativeToken(token.address);
              // For native token (ETH): selectable if any balance (gas estimation will catch insufficient)
              // For ERC-20 tokens: require at least 0.5 units
              const isSelectable = isNative ? balance > 0n : parseFloat(balanceFormatted) >= 0.5;

              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance,
                balanceFormatted,
                isNative,
                isSelectable,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            } catch (error) {
              console.warn(`Failed to fetch balance for ${token.symbol}:`, error);
              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance: 0n,
                balanceFormatted: '0',
                isNative: isNativeToken(token.address),
                isSelectable: false,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            }
          })
        );

        if (isMounted) {
          setFeeTokens(tokensWithBalances);
          // Note: Initial token selection is handled by useGasEstimation hook
        }
      } catch (error) {
        console.warn('[TransactionDialogWrapper] Failed to fetch fee tokens:', error);
      } finally {
        if (isMounted) setFeeTokensLoading(false);
      }
    };

    fetchFeeTokensData();

    return () => {
      isMounted = false;
    };
  }, [chainId, apiKey, request.data.from, effectivePaymasterUrl, viemChain]);

  // Initialize account
  // Note: Use effectivePaymasterUrl (stable) instead of computedPaymasterUrl to avoid
  // re-initializing account when user changes fee token selection (which would cause
  // gas estimation to run multiple times in a dependency cycle)
  useEffect(() => {
    let isMounted = true;

    const initializeAccount = async () => {
      try {
        const restoredAccount = await getAccountForSigning(apiKey, chainId, effectivePaymasterUrl);
        if (isMounted) {
          setAccount(restoredAccount);
        }
      } catch (error) {
        console.error('Error initializing account:', error);
      }
    };

    initializeAccount();

    return () => {
      isMounted = false;
    };
  }, [apiKey, chainId, effectivePaymasterUrl]);

  // Note: Gas estimation is now handled by useGasEstimation hook

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsProcessing(true);
    onSubmissionInFlight?.(true);
    try {
      if (!account) {
        throw new Error('Account not initialized');
      }

      // Check if permissions capability is provided
      const permissionId = request.data.capabilities?.permissions?.id;

      const result = await account.sendCalls(
        transactionCalls,
        { permissionId, from: request.data.from },
        computedPaymasterUrl,
        computedPaymasterContext
      );

      onApprove({
        id: result.id,
        chainId: result.chainId,
      });
    } catch (error) {
      console.error('Transaction failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const errorMessage = errorObj.message;
      // Check if user cancelled passkey prompt (NotAllowedError)
      if (errorObj.name === 'NotAllowedError') {
        onReject(UIError.userRejected('User cancelled the passkey prompt'));
      } else if (
        errorMessage.includes('AA21') ||
        errorMessage.includes("didn't pay prefund") ||
        errorMessage.includes('insufficient') ||
        errorMessage.includes('exceeds balance')
      ) {
        // Transaction rejected due to funds/gas issues
        onReject(new UIError(standardErrorCodes.rpc.transactionRejected as UIErrorCode, errorMessage));
      } else {
        // Internal error
        onReject(new UIError(standardErrorCodes.rpc.internal as UIErrorCode, errorMessage));
      }
    } finally {
      // Order matters: onApprove/onReject settled above, so clearing the in-flight
      // flag here never opens a window where a boundary crash could mis-settle.
      onSubmissionInFlight?.(false);
      submittingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    // The disabled/dismissable gates commit a render late; a same-tick cancel must
    // not settle "rejected" while the signed submission proceeds and lands on chain.
    if (submittingRef.current) return;
    setOpen(false);
    onReject(UIError.userRejected());
  };

  // Determine if fee token selector should be shown (not sponsored and has fee tokens)
  const showFeeTokenSelector = !isSponsored && feeTokens.length > 0;

  return (
    <TransactionDialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      transactions={transactions}
      walletAddress={request.data.from}
      gasFee={gasFee}
      gasFeeLoading={gasFeeLoading}
      gasEstimationError={gasEstimationError}
      sponsored={isSponsored}
      assetsOut={assetsOut}
      assetsIn={assetsIn}
      assetPreviewError={assetPreviewError}
      assetPreviewWillRevert={assetPreviewWillRevert}
      assetPreviewRevertCause={assetPreviewRevertCause}
      onBehalfOf={onBehalfOf}
      onBehalfOfLoading={onBehalfOfLoading}
      permissionProblem={permissionProblem}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      networkName={networkName}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      apiKey={apiKey}
      // Fee token props for ERC-20 paymaster
      feeTokens={feeTokens}
      feeTokensLoading={feeTokensLoading}
      selectedFeeToken={selectedFeeToken}
      onFeeTokenSelect={setSelectedFeeToken}
      showFeeTokenSelector={showFeeTokenSelector}
      isPayingWithErc20={isPayingWithErc20}
      nativeCurrencySymbol={viemChain?.nativeCurrency?.symbol}
      appName={appName}
      appLogoUrl={appLogoUrl}
    />
  );
}

// SendTransactionDialogWrapper - handles eth_sendTransaction (legacy single transaction)
function SendTransactionDialogWrapper({
  request,
  onApprove,
  onReject,
  onSubmissionInFlight,
  apiKey,
  defaultChainId,
  paymasters,
  appName,
  appLogoUrl,
}: {
  request: SendTransactionUIRequest;
  onApprove: (data: any) => void;
  onReject: (error?: Error) => void;
  /** Marks the window where a signed submission is racing the UI (see request()). */
  onSubmissionInFlight?: (inFlight: boolean) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  // Synchronous re-entry guard: isProcessing disables the button only after a
  // re-render, which is too soft a gate for a call that moves funds (permission
  // and EIP-7702 paths sign without a passkey prompt).
  const submittingRef = useRef(false);
  const [account, setAccount] = useState<Account | null>(null);
  // Fee token state for ERC-20 paymaster
  const [feeTokens, setFeeTokens] = useState<FeeTokenOption[]>([]);
  const [feeTokensLoading, setFeeTokensLoading] = useState(false);

  const chainId = request.data.chainId || defaultChainId || 1;
  const viemChain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  const networkName = viemChain?.name || 'Unknown Network';

  // The paymaster of the request, url and context together (EIP-5792
  // paymasterService capability first, then the one configured for the chain).
  // Taking the two halves apart let a capabilities url pick up a context written
  // for a different paymaster.
  const { url: effectivePaymasterUrl, context: effectivePaymasterContext } = useMemo(
    () => resolvePaymaster(request.data.capabilities?.paymasterService, paymasters?.[chainId]),
    [request.data.capabilities?.paymasterService, paymasters, chainId]
  );

  const isSponsored = !!effectivePaymasterUrl;

  // Transform eth_sendTransaction data to transactions format expected by dialog
  const transactions = useMemo(
    () => [
      {
        to: request.data.to,
        data: request.data.data,
        value: request.data.value,
        chainId: request.data.chainId,
      },
    ],
    [request.data]
  );

  // Convert to call format for Account operations
  const transactionCalls = useMemo(
    () => [
      {
        to: request.data.to as Address,
        value: request.data.value ? BigInt(request.data.value) : undefined, // Convert string wei to bigint
        data: (request.data.data || '0x') as Hex,
      },
    ],
    [request.data]
  );

  const {
    assetsOut,
    assetsIn,
    error: assetPreviewError,
    willRevert: assetPreviewWillRevert,
    revertCause: assetPreviewRevertCause,
  } = useAssetPreview({
    account: request.data.from as Address | undefined,
    calls: transactionCalls,
    chainId,
    apiKey,
  });

  // Use gas estimation hook for parallel ETH and ERC-20 estimation
  const {
    gasFee,
    gasFeeLoading,
    gasEstimationError,
    tokenEstimates,
    selectedFeeToken,
    setSelectedFeeToken,
    isPayingWithErc20,
  } = useGasEstimation({
    account,
    transactionCalls,
    chainId,
    apiKey,
    feeTokens,
    isSponsored,
    address: request.data.from,
    onFeeTokensUpdate: setFeeTokens,
  });

  // Compute paymaster URL based on fee token selection (for ERC-20 paymaster)
  const computedPaymasterUrl = useMemo(() => {
    // If already sponsored via capabilities or config, use that
    if (effectivePaymasterUrl) return effectivePaymasterUrl;

    // If user selected an ERC-20 token (non-native), use ERC-20 paymaster
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      return `${JAW_PAYMASTER_URL}?chainId=${chainId}${apiKey ? `&api-key=${apiKey}` : ''}`;
    }

    // Native ETH - no paymaster needed
    return undefined;
  }, [effectivePaymasterUrl, selectedFeeToken, chainId, apiKey]);

  // Compute paymaster context based on fee token selection
  const computedPaymasterContext = useMemo(() => {
    // If using ERC-20 paymaster, include token address and gas amount in context
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      // Use the actual estimate from tokenEstimates if available
      const estimate = tokenEstimates.find(
        (e) => e.tokenAddress.toLowerCase() === selectedFeeToken.address.toLowerCase()
      );

      if (estimate) {
        return buildErc20PaymasterContext(estimate);
      }

      // No estimate yet: omit `gas` so Account.createErc20ApprovalCall estimates
      // the worst-case ceiling itself, instead of a client-side USD guess that
      // ignores the exchange rate and can under-approve.
      return { token: selectedFeeToken.address };
    }
    return effectivePaymasterContext;
  }, [selectedFeeToken, effectivePaymasterContext, tokenEstimates]);

  // Fetch fee tokens when not sponsored (for ERC-20 paymaster option)
  useEffect(() => {
    // Skip if already sponsored via capabilities or config
    if (effectivePaymasterUrl) return;

    let isMounted = true;

    const fetchFeeTokensData = async () => {
      setFeeTokensLoading(true);
      try {
        // Fetch capabilities from JAW RPC
        const capabilities = await handleGetCapabilitiesRequest(
          { method: 'wallet_getCapabilities', params: [] },
          apiKey || '',
          true // showTestnets
        );

        const chainIdHex = `0x${chainId.toString(16)}` as `0x${string}`;
        const feeTokenCap = capabilities?.[chainIdHex]?.feeToken as FeeTokenCapability | undefined;

        if (!feeTokenCap?.supported || !feeTokenCap?.tokens?.length) {
          if (isMounted) setFeeTokensLoading(false);
          return;
        }

        // Get RPC URL for balance fetching
        const rpcUrl =
          buildChainConfigFromApiKey(chainId, apiKey).rpcUrl ||
          viemChain?.rpcUrls?.default?.http?.[0] ||
          `https://eth.llamarpc.com`;

        // Fetch balances in parallel
        const tokensWithBalances = await Promise.all(
          feeTokenCap.tokens.map(async (token) => {
            try {
              const balance = await fetchTokenBalance(token.address, request.data.from, rpcUrl, chainId);
              const balanceFormatted = formatUnits(balance, token.decimals);
              const isNative = isNativeToken(token.address);
              // For native token (ETH): selectable if any balance (gas estimation will catch insufficient)
              // For ERC-20 tokens: require at least 0.5 units
              const isSelectable = isNative ? balance > 0n : parseFloat(balanceFormatted) >= 0.5;

              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance,
                balanceFormatted,
                isNative,
                isSelectable,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            } catch (error) {
              console.warn(`Failed to fetch balance for ${token.symbol}:`, error);
              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance: 0n,
                balanceFormatted: '0',
                isNative: isNativeToken(token.address),
                isSelectable: false,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            }
          })
        );

        if (isMounted) {
          setFeeTokens(tokensWithBalances);
          // Note: Initial token selection is handled by useGasEstimation hook
        }
      } catch (error) {
        console.warn('[SendTransactionDialogWrapper] Failed to fetch fee tokens:', error);
      } finally {
        if (isMounted) setFeeTokensLoading(false);
      }
    };

    fetchFeeTokensData();

    return () => {
      isMounted = false;
    };
  }, [chainId, apiKey, request.data.from, effectivePaymasterUrl, viemChain]);

  // Initialize account
  // Note: Use effectivePaymasterUrl (stable) instead of computedPaymasterUrl to avoid
  // re-initializing account when user changes fee token selection (which would cause
  // gas estimation to run multiple times in a dependency cycle)
  useEffect(() => {
    let isMounted = true;

    const initializeAccount = async () => {
      try {
        const restoredAccount = await getAccountForSigning(apiKey, chainId, effectivePaymasterUrl);
        if (isMounted) {
          setAccount(restoredAccount);
        }
      } catch (error) {
        console.error('Error initializing account:', error);
      }
    };

    initializeAccount();

    return () => {
      isMounted = false;
    };
  }, [apiKey, chainId, effectivePaymasterUrl]);

  // Note: Gas estimation is now handled by useGasEstimation hook

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsProcessing(true);
    onSubmissionInFlight?.(true);
    try {
      if (!account) {
        throw new Error('Account not initialized');
      }

      const txHash = await account.sendTransaction(
        transactionCalls,
        computedPaymasterUrl,
        computedPaymasterContext,
        request.data.from
      );

      onApprove(txHash);
    } catch (error) {
      console.error('Transaction failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const errorMessage = errorObj.message;
      // Check if user cancelled passkey prompt (NotAllowedError)
      if (errorObj.name === 'NotAllowedError') {
        onReject(UIError.userRejected('User cancelled the passkey prompt'));
      } else if (
        errorMessage.includes('AA21') ||
        errorMessage.includes("didn't pay prefund") ||
        errorMessage.includes('insufficient') ||
        errorMessage.includes('exceeds balance')
      ) {
        // Transaction rejected due to funds/gas issues
        onReject(new UIError(standardErrorCodes.rpc.transactionRejected as UIErrorCode, errorMessage));
      } else {
        // Internal error
        onReject(new UIError(standardErrorCodes.rpc.internal as UIErrorCode, errorMessage));
      }
    } finally {
      // Order matters: onApprove/onReject settled above, so clearing the in-flight
      // flag here never opens a window where a boundary crash could mis-settle.
      onSubmissionInFlight?.(false);
      submittingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    // The disabled/dismissable gates commit a render late; a same-tick cancel must
    // not settle "rejected" while the signed submission proceeds and lands on chain.
    if (submittingRef.current) return;
    setOpen(false);
    onReject(UIError.userRejected());
  };

  // Determine if fee token selector should be shown (not sponsored and has fee tokens)
  const showFeeTokenSelector = !isSponsored && feeTokens.length > 0;

  return (
    <TransactionDialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      transactions={transactions}
      walletAddress={request.data.from}
      gasFee={gasFee}
      gasFeeLoading={gasFeeLoading}
      gasEstimationError={gasEstimationError}
      sponsored={isSponsored}
      assetsOut={assetsOut}
      assetsIn={assetsIn}
      assetPreviewError={assetPreviewError}
      assetPreviewWillRevert={assetPreviewWillRevert}
      assetPreviewRevertCause={assetPreviewRevertCause}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      networkName={networkName}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      apiKey={apiKey}
      // Fee token props for ERC-20 paymaster
      feeTokens={feeTokens}
      feeTokensLoading={feeTokensLoading}
      selectedFeeToken={selectedFeeToken}
      onFeeTokenSelect={setSelectedFeeToken}
      showFeeTokenSelector={showFeeTokenSelector}
      isPayingWithErc20={isPayingWithErc20}
      nativeCurrencySymbol={viemChain?.nativeCurrency?.symbol}
      appName={appName}
      appLogoUrl={appLogoUrl}
    />
  );
}

// Known function selectors mapping
function PermissionDialogWrapper({
  request,
  onApprove,
  onReject,
  onSubmissionInFlight,
  apiKey,
  defaultChainId,
  paymasters,
  appName,
  appLogoUrl,
}: {
  request: PermissionUIRequest;
  onApprove: (data: any) => void;
  onReject: (error?: Error) => void;
  onSubmissionInFlight?: (inFlight: boolean) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [tokenInfoMap, setTokenInfoMap] = useState<TokenInfoMap>({});
  const [isLoadingTokenInfo, setIsLoadingTokenInfo] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [feeTokens, setFeeTokens] = useState<FeeTokenOption[]>([]);
  const [feeTokensLoading, setFeeTokensLoading] = useState(true);
  // Synchronous re-entry guard: isProcessing disables the buttons only after a
  // re-render, which is too soft a gate for a grant that delegates authority on-chain.
  const submittingRef = useRef(false);

  // chainId can be number or hex string (like '0x1')
  const requestChainId = request.data.chainId;
  const chainId =
    typeof requestChainId === 'string'
      ? parseInt(requestChainId, requestChainId.startsWith('0x') ? 16 : 10)
      : requestChainId || defaultChainId || 1;
  const viemChain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  const networkName = viemChain?.name || 'Unknown Network';

  // Get native token symbol from feeTokens, falling back to chain's native currency
  const nativeToken = feeTokens?.find((t) => t.isNative);
  const nativeSymbol = nativeToken?.symbol || viemChain?.nativeCurrency?.symbol || 'ETH';

  // The paymaster of the request, url and context together (EIP-5792
  // paymasterService capability first, then the one configured for the chain).
  // Taking the two halves apart let a capabilities url pick up a context written
  // for a different paymaster.
  const { url: effectivePaymasterUrl, context: effectivePaymasterContext } = useMemo(
    () => resolvePaymaster(request.data.capabilities?.paymasterService, paymasters?.[chainId]),
    [request.data.capabilities?.paymasterService, paymasters, chainId]
  );

  // Check if this is a sponsored transaction (paymaster provided)
  const isSponsored = !!effectivePaymasterUrl;

  // Build the actual permission grant call for gas estimation
  // This uses the real approve() call data to PERMISSIONS_MANAGER_ADDRESS
  const transactionCalls = useMemo(() => {
    // Need account address to build the call - will be empty until account is initialized
    if (!request.data.address) return [];

    try {
      const permissionCall = buildGrantPermissionCall(
        request.data.address as Address,
        request.data.spender as Address,
        request.data.expiry,
        request.data.permissions
      );
      return [permissionCall];
    } catch (error) {
      console.warn('[PermissionDialogWrapper] Failed to build permission grant call:', error);
      return [];
    }
  }, [request.data.address, request.data.spender, request.data.expiry, request.data.permissions]);

  // Use the gas estimation hook for both ETH and ERC-20 cost estimation
  const {
    gasFee,
    gasFeeLoading,
    gasEstimationError,
    tokenEstimates,
    selectedFeeToken,
    setSelectedFeeToken,
    isPayingWithErc20,
  } = useGasEstimation({
    account,
    transactionCalls,
    chainId,
    apiKey,
    feeTokens,
    isSponsored,
    address: request.data.address,
    onFeeTokensUpdate: setFeeTokens,
  });

  // Compute paymaster URL based on fee token selection (for ERC-20 paymaster)
  const computedPaymasterUrl = useMemo(() => {
    // If already sponsored via capabilities or config, use that
    if (effectivePaymasterUrl) return effectivePaymasterUrl;

    // If user selected an ERC-20 token (non-native), use ERC-20 paymaster
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      return `${JAW_PAYMASTER_URL}?chainId=${chainId}${apiKey ? `&api-key=${apiKey}` : ''}`;
    }

    // Native ETH - no paymaster needed
    return undefined;
  }, [effectivePaymasterUrl, selectedFeeToken, chainId, apiKey]);

  // Compute paymaster context based on fee token selection
  const computedPaymasterContext = useMemo(() => {
    // If using ERC-20 paymaster, include token address and gas amount in context
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      // Use the actual estimate from tokenEstimates if available
      const estimate = tokenEstimates.find(
        (e) => e.tokenAddress.toLowerCase() === selectedFeeToken.address.toLowerCase()
      );

      if (estimate) {
        return buildErc20PaymasterContext(estimate);
      }

      // No estimate yet: omit `gas` so Account.createErc20ApprovalCall estimates
      // the worst-case ceiling itself, instead of a client-side USD guess that
      // ignores the exchange rate and can under-approve.
      return { token: selectedFeeToken.address };
    }
    return effectivePaymasterContext;
  }, [selectedFeeToken, effectivePaymasterContext, tokenEstimates]);

  const chain = useMemo(
    () => buildChainConfigFromApiKey(chainId, apiKey, computedPaymasterUrl),
    [chainId, apiKey, computedPaymasterUrl]
  );

  // Get spends array from request (now using spends plural)
  // Memoized because both keys are optional: `?? []` on an absent key returns a new array every
  // render, and these feed effect dependency arrays. A calls-only grant otherwise re-triggered the
  // token-info effect from its own setState, forever.
  const spendsData = useMemo(() => request.data.permissions.spends ?? [], [request.data.permissions.spends]);

  // Get calls array from request
  const callsData = useMemo(() => request.data.permissions.calls ?? [], [request.data.permissions.calls]);

  // Fetch token info for all unique tokens in spends
  useEffect(() => {
    // Bail rather than passing an empty URL down: getPublicClient attaches the chain
    // definition, so an empty URL would resolve to the chain's public RPC instead of
    // the proxy. Nothing to read without a configured endpoint.
    const rpcUrl = chain.rpcUrl;
    if ((spendsData.length === 0 && callsData.length === 0) || !rpcUrl) {
      setIsLoadingTokenInfo(false);
      return;
    }

    let isMounted = true;
    setIsLoadingTokenInfo(true);

    const fetchAllTokenInfo = async () => {
      const newTokenInfoMap: TokenInfoMap = {};

      // Get unique token addresses
      // Call targets are looked up too: a target that is a token should read as "USDC", not as a
      // raw address. A non-token contract simply fails the reads and falls back to its address.
      const uniqueTokens = Array.from(
        new Set([
          ...spendsData.map((spend) => spend.token),
          ...callsData.map((call) => call.target).filter((t) => t && !isWildcard(t)),
        ])
      ) as string[];

      // Resolved in one pass rather than token-by-token: the shared client folds every
      // decimals/symbol read issued in this tick into a single Multicall3 request, so N
      // tokens cost one round-trip instead of 2N sequential ones.
      const publicClient = getPublicClient(chainId, rpcUrl);

      const pending: string[] = [];
      for (const tokenAddress of uniqueTokens) {
        if (tokenInfoMap[tokenAddress]) {
          newTokenInfoMap[tokenAddress] = tokenInfoMap[tokenAddress];
        } else if (isNativeToken(tokenAddress)) {
          newTokenInfoMap[tokenAddress] = {
            decimals: viemChain?.nativeCurrency?.decimals ?? 18,
            symbol: viemChain?.nativeCurrency?.symbol || 'ETH',
          };
        } else {
          pending.push(tokenAddress);
        }
      }

      await Promise.all(
        pending.map(async (tokenAddress) => {
          try {
            const [decimals, symbol] = await Promise.all([
              publicClient.readContract({ address: tokenAddress as Address, abi: erc20Abi, functionName: 'decimals' }),
              publicClient.readContract({ address: tokenAddress as Address, abi: erc20Abi, functionName: 'symbol' }),
            ]);
            newTokenInfoMap[tokenAddress] = { decimals, symbol };
          } catch {
            // Not an ERC-20 (or unreachable): unnamed, and decimals unknown, so the UI shows the
            // address and the raw allowance rather than a figure scaled by a guessed 18.
            newTokenInfoMap[tokenAddress] = { decimals: null, symbol: '' };
          }
        })
      );

      if (isMounted) {
        setTokenInfoMap((prev) => ({ ...prev, ...newTokenInfoMap }));
        setIsLoadingTokenInfo(false);
      }
    };

    fetchAllTokenInfo();

    return () => {
      isMounted = false;
    };
  }, [chainId, spendsData, callsData, chain.rpcUrl, viemChain]);

  // Fetch fee tokens from capabilities (same pattern as TransactionDialogWrapper)
  useEffect(() => {
    let isMounted = true;

    const fetchFeeTokensData = async () => {
      if (!viemChain || !apiKey) {
        setFeeTokensLoading(false);
        return;
      }

      // If sponsored, no need to fetch fee tokens
      if (effectivePaymasterUrl) {
        setFeeTokensLoading(false);
        return;
      }

      try {
        setFeeTokensLoading(true);

        // Fetch capabilities from JAW RPC
        const capabilities = await handleGetCapabilitiesRequest(
          { method: 'wallet_getCapabilities', params: [] },
          apiKey || '',
          true // showTestnets
        );

        const chainIdHex = `0x${chainId.toString(16)}` as `0x${string}`;
        const feeTokenCap = capabilities?.[chainIdHex]?.feeToken as FeeTokenCapability | undefined;

        if (!feeTokenCap?.supported || !feeTokenCap?.tokens?.length) {
          if (isMounted) setFeeTokensLoading(false);
          return;
        }

        // Get RPC URL for balance fetching
        const rpcUrl =
          buildChainConfigFromApiKey(chainId, apiKey).rpcUrl ||
          viemChain?.rpcUrls?.default?.http?.[0] ||
          `https://eth.llamarpc.com`;

        // Fetch balances in parallel
        const tokensWithBalances = await Promise.all(
          feeTokenCap.tokens.map(async (token) => {
            try {
              const balance = await fetchTokenBalance(token.address, request.data.address, rpcUrl, chainId);
              const balanceFormatted = formatUnits(balance, token.decimals);
              const tokenIsNative = isNativeToken(token.address);
              // For native token (ETH): selectable if any balance (gas estimation will catch insufficient)
              // For ERC-20 tokens: require at least 0.5 units
              const isSelectable = tokenIsNative ? balance > 0n : parseFloat(balanceFormatted) >= 0.5;

              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance,
                balanceFormatted,
                isNative: tokenIsNative,
                isSelectable,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            } catch (error) {
              console.warn(`Failed to fetch balance for ${token.symbol}:`, error);
              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance: 0n,
                balanceFormatted: '0',
                isNative: isNativeToken(token.address),
                isSelectable: false,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            }
          })
        );

        if (isMounted) {
          setFeeTokens(tokensWithBalances);
          // Note: Initial token selection is handled by useGasEstimation hook
        }
      } catch (error) {
        console.warn('[PermissionDialogWrapper] Failed to fetch fee tokens:', error);
      } finally {
        if (isMounted) setFeeTokensLoading(false);
      }
    };

    fetchFeeTokensData();

    return () => {
      isMounted = false;
    };
  }, [chainId, apiKey, request.data.address, effectivePaymasterUrl, viemChain]);

  // Initialize account
  // Note: Use effectivePaymasterUrl (stable) instead of computedPaymasterUrl to avoid
  // re-initializing account when user changes fee token selection (which would cause
  // gas estimation to run multiple times in a dependency cycle)
  useEffect(() => {
    let isMounted = true;

    const initializeAccount = async () => {
      try {
        const restoredAccount = await getAccountForSigning(apiKey, chainId, effectivePaymasterUrl);
        if (isMounted) {
          setAccount(restoredAccount);
        }
      } catch (error) {
        console.error('[PermissionDialogWrapper] Error initializing account:', error);
      }
    };

    initializeAccount();

    return () => {
      isMounted = false;
    };
  }, [apiKey, chainId, effectivePaymasterUrl]);

  // Note: Gas estimation is now handled by useGasEstimation hook

  // Convert to SpendPermission array format expected by PermissionDialog
  const spends = useMemo(
    () =>
      spendsData.map((spend) => {
        const tokenInfo =
          tokenInfoMap[spend.token] ||
          (isNativeToken(spend.token)
            ? {
                decimals: viemChain?.nativeCurrency?.decimals ?? 18,
                symbol: nativeSymbol,
              }
            : { decimals: null, symbol: '' });

        const allowance = BigInt(spend.allowance);
        const { amount, decimalsUnknown } = formatSpendAmount(allowance, tokenInfo.decimals);
        const limit = decimalsUnknown ? `${amount} base units` : `${amount} ${tokenInfo.symbol}`;

        // Format duration with multiplier (defaults to 1 if not provided)
        const multiplier = spend.multiplier ?? 1;
        const duration = `${multiplier} ${spend.unit}${multiplier > 1 ? 's' : ''}`;

        return {
          amount,
          decimalsUnknown,
          token: isNativeToken(spend.token) ? `Native (${nativeSymbol})` : tokenInfo.symbol,
          tokenAddress: spend.token,
          duration,
          limit,
        };
      }),
    [spendsData, tokenInfoMap, viemChain, nativeSymbol]
  );

  // Format call permissions. Signatures resolve asynchronously — a selector with no signature yet
  // renders as its raw hex and upgrades in place.
  const callSignatures = useFunctionSignatures(callsData.map((call) => call.selector));
  const calls = useMemo(
    () =>
      callsData.map((call) => ({
        target: call.target,
        selector: call.selector,
        functionSignature:
          call.functionSignature ||
          (call.selector ? (callSignatures[call.selector.toLowerCase()] ?? call.selector) : 'Unknown Function'),
      })),
    [callsData, callSignatures]
  );

  // Format expiry date
  const expiryDate = useMemo(() => {
    return formatExpiryDate(request.data.expiry);
  }, [request.data.expiry]);

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    if (!account) {
      console.error('[PermissionDialogWrapper] Account not initialized');
      return;
    }

    submittingRef.current = true;
    setIsProcessing(true);
    onSubmissionInFlight?.(true);
    setStatus('Granting permissions...');
    try {
      // Use the spends array directly from the request (already in correct format)
      const permissionsDetail = {
        spends: request.data.permissions.spends || [],
        calls: request.data.permissions.calls,
      };

      // Grant permissions using Account class with paymaster context.
      // The last argument needs a core that carries the prefund; without it the
      // spender is granted the permission and holds nothing to pay its first op.
      const result = await account.grantPermissions(
        request.data.expiry,
        request.data.spender as Address,
        permissionsDetail,
        computedPaymasterUrl,
        computedPaymasterContext,
        request.data.address,
        { prefundSpender: request.data.capabilities?.prefundSpender === true }
      );

      setStatus('Permissions granted successfully!');
      onApprove(result);
    } catch (error) {
      console.error('Permission grant failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      setStatus(`Error: ${errorObj.message}`);
      // Check if user cancelled passkey prompt (NotAllowedError)
      if (errorObj.name === 'NotAllowedError') {
        onReject(UIError.userRejected('User cancelled the passkey prompt'));
      } else {
        // Internal error
        onReject(new UIError(standardErrorCodes.rpc.internal as UIErrorCode, errorObj.message));
      }
    } finally {
      // Order matters: onApprove/onReject settled above, so clearing the in-flight
      // flag here never opens a window where a boundary crash could mis-settle.
      onSubmissionInFlight?.(false);
      submittingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    // The disabled/dismissable gates commit a render late; a same-tick cancel must
    // not settle "rejected" while the signed grant proceeds and lands on chain.
    if (submittingRef.current) return;
    setOpen(false);
    onReject(UIError.userRejected());
  };

  return (
    <PermissionDialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      mode="grant"
      spenderAddress={request.data.spender}
      accountAddress={request.data.address}
      origin={typeof window !== 'undefined' ? window.location.origin : 'unknown'}
      spends={spends}
      calls={calls}
      tokenMeta={tokenInfoMap}
      expiryDate={expiryDate}
      networkName={networkName}
      chainId={chainId}
      apiKey={apiKey}
      appName={appName}
      appLogoUrl={appLogoUrl}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      status={status}
      isLoadingTokenInfo={isLoadingTokenInfo}
      gasFee={gasFee}
      gasFeeLoading={gasFeeLoading}
      gasEstimationError={gasEstimationError}
      sponsored={isSponsored}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      // Fee token props for ERC-20 paymaster
      feeTokens={feeTokens}
      feeTokensLoading={feeTokensLoading}
      selectedFeeToken={selectedFeeToken}
      onFeeTokenSelect={setSelectedFeeToken}
      showFeeTokenSelector={!isSponsored && feeTokens.length > 0}
      isPayingWithErc20={isPayingWithErc20}
      nativeCurrencySymbol={viemChain?.nativeCurrency?.symbol}
    />
  );
}

// SiweDialogWrapper - handles Sign-In with Ethereum messages
function SiweDialogWrapper({
  request,
  onApprove,
  onReject,
  apiKey,
  defaultChainId,
  paymasters,
  appName,
  appLogoUrl,
}: {
  request: SignatureUIRequest;
  onApprove: (data: any, holdMs?: number) => void;
  onReject: (error?: Error) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [siweStatus, setSiweStatus] = useState<string>('');

  // Use chainId from request (current chain), fallback to defaultChainId
  const chainId = request.data.chainId || defaultChainId || 1;
  const chainName = getChainNameFromId(chainId);
  const chainIcon = useChainIconURI(chainId, apiKey, 24);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'unknown';

  // Decode message if it's hex encoded
  const decodedMessage = useMemo(() => {
    const msg = request.data.message;
    if (msg.startsWith('0x')) {
      try {
        return hexToUtf8(msg);
      } catch {
        return msg;
      }
    }
    return msg;
  }, [request.data.message]);

  // Fallback app name from the SIWE domain line, used only when config supplies none.
  const messageAppName = useMemo(() => {
    const match = decodedMessage.match(/^([^\n]+)\s+wants you to sign in/);
    return match ? match[1] : 'dApp';
  }, [decodedMessage]);

  // NOT gated on a successful parse. The parse is strict on purpose, but this warning carries
  // the mandatory acknowledgement checkbox, so gating it let a dapp drop the hard block by
  // writing a message that detects as SIWE and then fails to parse (a tab after `URI:` is
  // enough). The helper falls back to a best-effort domain/URI read.
  const warningMessage = useMemo(
    () => getSiweOriginWarningFromMessage(origin, decodedMessage),
    [decodedMessage, origin]
  );

  const handleSign = async () => {
    setIsProcessing(true);
    setSiweStatus('Signing message...');
    try {
      // Restore account for signing
      const account = await getAccountForSigning(apiKey, chainId, paymasters?.[chainId]?.url);

      // Sign the message
      const signature = await account.signMessage(request.data.message);

      setSiweStatus('Sign-in successful!');
      // Deliver, then hold the tick (onApprove resolves now, defers teardown — no delay).
      onApprove(signature, SIGNED_TICK_MS);
      setIsSuccess(true);
    } catch (error) {
      console.error('SIWE signature failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      setSiweStatus(`Error: ${errorObj.message}`);
      // Check if user cancelled passkey prompt (NotAllowedError)
      if (errorObj.name === 'NotAllowedError') {
        onReject(UIError.userRejected('User cancelled the passkey prompt'));
      } else {
        // Internal error
        onReject(new UIError(standardErrorCodes.rpc.internal as UIErrorCode, errorObj.message));
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    onReject(UIError.userRejected());
  };

  return (
    <SiweDialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      message={decodedMessage}
      origin={origin}
      appName={appName ?? messageAppName}
      appLogoUrl={appLogoUrl ?? undefined}
      accountAddress={request.data.address}
      chainName={chainName}
      chainId={chainId}
      chainIcon={chainIcon}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      onSign={handleSign}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      isSuccess={isSuccess}
      siweStatus={siweStatus}
      canSign={!isProcessing}
      warningMessage={warningMessage}
    />
  );
}

// AddFundsDialogWrapper - handles wallet_addFunds
//
// The thinnest wrapper of the set: the screen shows an address and closes. It
// takes no onReject, because there is nothing to reject — deposits land off-app,
// so the user closing is the normal finish and the request resolves null.
function AddFundsDialogWrapper({
  request,
  onApprove,
  apiKey,
  appName,
  appLogoUrl,
}: {
  request: AddFundsUIRequest;
  onApprove: (data: unknown) => void;
  apiKey?: string;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);

  const finish = () => {
    setOpen(false);
    onApprove(null);
  };

  return (
    <AddFundsDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) finish();
      }}
      address={request.data.address}
      chainId={request.data.chainId}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      apiKey={apiKey}
      appName={appName}
      appLogoUrl={appLogoUrl}
      origin={typeof window !== 'undefined' ? window.location.origin : ''}
      onDone={finish}
    />
  );
}

// RevokePermissionDialogWrapper - handles wallet_revokePermissions
function RevokePermissionDialogWrapper({
  request,
  onApprove,
  onReject,
  onSubmissionInFlight,
  apiKey,
  defaultChainId,
  paymasters,
  appName,
  appLogoUrl,
}: {
  request: RevokePermissionUIRequest;
  onApprove: (data: any) => void;
  onReject: (error?: Error) => void;
  onSubmissionInFlight?: (inFlight: boolean) => void;
  apiKey?: string;
  defaultChainId?: number;
  paymasters?: Record<number, PaymasterConfig>;
  appName?: string;
  appLogoUrl?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>('');
  // Covers ONLY the token metadata; whether the permission itself is in flight comes from the hook.
  // Kept apart deliberately: one flag covering both is never re-armed when the request changes, so a
  // second revoke arriving without a remount left the gate open on an empty permission.
  const [isLoadingTokenMetadata, setIsLoadingTokenMetadata] = useState(true);
  const [tokenInfoMap, setTokenInfoMap] = useState<TokenInfoMap>({});
  const [account, setAccount] = useState<Account | null>(null);
  const [feeTokens, setFeeTokens] = useState<FeeTokenOption[]>([]);
  const [feeTokensLoading, setFeeTokensLoading] = useState(true);
  // Synchronous re-entry guard: isProcessing disables the buttons only after a
  // re-render, which is too soft a gate for an on-chain revocation.
  const submittingRef = useRef(false);

  const chainId = request.data.chainId || defaultChainId || 1;

  // Owns the relay fetch, the 404-vs-transport split and the validation. Shared with the keys popup
  // so both revoke screens read the same `from` — they drifted apart when this lived twice.
  const {
    permission: fetchedPermissionData,
    loading: isLoadingPermission,
    problem: revocationProblem,
  } = usePermissionRevocation({
    permissionId: request.data.permissionId as `0x${string}` | undefined,
    apiKey,
    chainId,
    from: request.data.address,
  });
  const viemChain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  const networkName = viemChain?.name || 'Unknown Network';

  // Get native token symbol from feeTokens, falling back to chain's native currency
  const nativeToken = feeTokens?.find((t) => t.isNative);
  const nativeSymbol = nativeToken?.symbol || viemChain?.nativeCurrency?.symbol || 'ETH';

  // The paymaster of the request, url and context together (EIP-5792
  // paymasterService capability first, then the one configured for the chain).
  // Taking the two halves apart let a capabilities url pick up a context written
  // for a different paymaster.
  const { url: effectivePaymasterUrl, context: effectivePaymasterContext } = useMemo(
    () => resolvePaymaster(request.data.capabilities?.paymasterService, paymasters?.[chainId]),
    [request.data.capabilities?.paymasterService, paymasters, chainId]
  );

  // Check if this is a sponsored transaction (paymaster provided)
  const isSponsored = !!effectivePaymasterUrl;

  // Build the actual permission revoke call for gas estimation
  const transactionCalls = useMemo(() => {
    if (!fetchedPermissionData) return [];

    try {
      const revokeCall = buildRevokePermissionCall(fetchedPermissionData);
      return [revokeCall];
    } catch (error) {
      console.warn('[RevokePermissionDialogWrapper] Failed to build permission revoke call:', error);
      return [];
    }
  }, [fetchedPermissionData]);

  // Use the gas estimation hook for both ETH and ERC-20 cost estimation
  const {
    gasFee,
    gasFeeLoading,
    gasEstimationError,
    tokenEstimates,
    selectedFeeToken,
    setSelectedFeeToken,
    isPayingWithErc20,
  } = useGasEstimation({
    account,
    transactionCalls,
    chainId,
    apiKey,
    feeTokens,
    isSponsored,
    address: request.data.address,
    onFeeTokensUpdate: setFeeTokens,
  });

  // Compute paymaster URL based on fee token selection (for ERC-20 paymaster)
  const computedPaymasterUrl = useMemo(() => {
    // If already sponsored via capabilities or config, use that
    if (effectivePaymasterUrl) return effectivePaymasterUrl;

    // If user selected an ERC-20 token (non-native), use ERC-20 paymaster
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      return `${JAW_PAYMASTER_URL}?chainId=${chainId}${apiKey ? `&api-key=${apiKey}` : ''}`;
    }

    // Native ETH - no paymaster needed
    return undefined;
  }, [effectivePaymasterUrl, selectedFeeToken, chainId, apiKey]);

  // Compute paymaster context based on fee token selection
  const computedPaymasterContext = useMemo(() => {
    // If using ERC-20 paymaster, include token address and gas amount in context
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      // Use the actual estimate from tokenEstimates if available
      const estimate = tokenEstimates.find(
        (e) => e.tokenAddress.toLowerCase() === selectedFeeToken.address.toLowerCase()
      );

      if (estimate) {
        return buildErc20PaymasterContext(estimate);
      }

      // No estimate yet: omit `gas` so Account.createErc20ApprovalCall estimates
      // the worst-case ceiling itself, instead of a client-side USD guess that
      // ignores the exchange rate and can under-approve.
      return { token: selectedFeeToken.address };
    }
    return effectivePaymasterContext;
  }, [selectedFeeToken, effectivePaymasterContext, tokenEstimates]);

  const chain = useMemo(
    () => buildChainConfigFromApiKey(chainId, apiKey, computedPaymasterUrl),
    [chainId, apiKey, computedPaymasterUrl]
  );

  // Token metadata for the spend tokens and any call target that turns out to be a token, keyed on
  // the permission `usePermissionRevocation` resolved. `isLoadingTokenMetadata` stays true until
  // this lands as well, because the Confirm gate reads it and a spend amount must never render
  // scaled by a guessed decimals.
  useEffect(() => {
    const permData = fetchedPermissionData;
    if (!permData) {
      // The hook reached a terminal problem, so no permission is coming and nothing gates on it.
      if (revocationProblem) setIsLoadingTokenMetadata(false);
      return;
    }

    let cancelled = false;
    setIsLoadingTokenMetadata(true);
    const fetchTokenInfo = async () => {
      try {
        // Token info for spend tokens and for any call target that turns out to be a token.
        const lookupAddresses = Array.from(
          new Set([
            ...(permData.spends ?? []).map((spend) => spend.token),
            ...(permData.calls ?? []).map((call) => call.target).filter((t) => t && !isWildcard(t)),
          ])
        );
        if (lookupAddresses.length > 0) {
          const newTokenInfoMap: TokenInfoMap = {};
          // One pass over the lookup set so the shared client can fold every decimals/symbol
          // read into a single Multicall3 request. Left null when no endpoint is configured —
          // getPublicClient attaches the chain definition, so an empty URL would resolve to
          // the chain's public RPC rather than the proxy.
          const publicClient = chain.rpcUrl ? getPublicClient(chainId, chain.rpcUrl) : null;

          const pending: string[] = [];
          for (const tokenAddress of lookupAddresses) {
            if (isNativeToken(tokenAddress)) {
              newTokenInfoMap[tokenAddress] = {
                decimals: viemChain?.nativeCurrency?.decimals ?? 18,
                symbol: viemChain?.nativeCurrency?.symbol || 'ETH',
              };
            } else {
              pending.push(tokenAddress);
            }
          }

          await Promise.all(
            pending.map(async (tokenAddress) => {
              try {
                if (!publicClient) throw new Error(`No RPC URL configured for chain ${chainId}`);
                const [decimals, symbol] = await Promise.all([
                  publicClient.readContract({
                    address: tokenAddress as Address,
                    abi: erc20Abi,
                    functionName: 'decimals',
                  }),
                  publicClient.readContract({
                    address: tokenAddress as Address,
                    abi: erc20Abi,
                    functionName: 'symbol',
                  }),
                ]);
                newTokenInfoMap[tokenAddress] = { decimals, symbol };
              } catch {
                // Not an ERC-20 (or unreachable): unnamed, and decimals unknown, so the UI shows
                // the address and the raw allowance rather than a figure scaled by a guessed 18.
                newTokenInfoMap[tokenAddress] = { decimals: null, symbol: '' };
              }
            })
          );
          setTokenInfoMap(newTokenInfoMap);
        }
      } catch (error) {
        // Token metadata is enrichment: a failed read renders the raw allowance rather than
        // blocking, so it must not become a revocation problem.
        console.error('❌ Failed to fetch token info for permission:', error);
      } finally {
        if (!cancelled) setIsLoadingTokenMetadata(false);
      }
    };

    fetchTokenInfo();
    return () => {
      cancelled = true;
    };
  }, [fetchedPermissionData, revocationProblem, chainId, chain.rpcUrl, viemChain]);

  // Fetch fee tokens for ERC-20 paymaster support
  useEffect(() => {
    // Skip if already sponsored via capabilities/config
    if (effectivePaymasterUrl) {
      setFeeTokensLoading(false);
      return;
    }

    let isMounted = true;

    const fetchFeeTokensData = async () => {
      try {
        // Fetch capabilities to get available fee tokens
        const capabilities = await handleGetCapabilitiesRequest(
          { method: 'wallet_getCapabilities', params: [] },
          apiKey || '',
          true // showTestnets
        );

        const chainIdHex = `0x${chainId.toString(16)}` as `0x${string}`;
        const feeTokenCap = capabilities?.[chainIdHex]?.feeToken as FeeTokenCapability | undefined;

        if (!feeTokenCap?.supported || !feeTokenCap?.tokens?.length) {
          if (isMounted) setFeeTokensLoading(false);
          return;
        }

        // Get RPC URL for balance fetching
        const rpcUrl =
          buildChainConfigFromApiKey(chainId, apiKey).rpcUrl ||
          viemChain?.rpcUrls?.default?.http?.[0] ||
          `https://eth.llamarpc.com`;

        // Fetch balances in parallel
        const tokensWithBalances = await Promise.all(
          feeTokenCap.tokens.map(async (token) => {
            try {
              const balance = await fetchTokenBalance(token.address, request.data.address as Address, rpcUrl, chainId);
              const balanceFormatted = formatUnits(balance, token.decimals);
              const tokenIsNative = isNativeToken(token.address);
              // For native token (ETH): selectable if any balance (gas estimation will catch insufficient)
              // For ERC-20 tokens: require at least 0.5 units
              const isSelectable = tokenIsNative ? balance > 0n : parseFloat(balanceFormatted) >= 0.5;

              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance,
                balanceFormatted,
                isNative: tokenIsNative,
                isSelectable,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            } catch (error) {
              console.warn(`Failed to fetch balance for ${token.symbol}:`, error);
              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance: 0n,
                balanceFormatted: '0',
                isNative: isNativeToken(token.address),
                isSelectable: false,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            }
          })
        );

        if (isMounted) {
          setFeeTokens(tokensWithBalances);
          // Note: Initial token selection is handled by useGasEstimation hook
        }
      } catch (error) {
        console.warn('[RevokePermissionDialogWrapper] Failed to fetch fee tokens:', error);
      } finally {
        if (isMounted) setFeeTokensLoading(false);
      }
    };

    fetchFeeTokensData();

    return () => {
      isMounted = false;
    };
  }, [chainId, apiKey, request.data.address, effectivePaymasterUrl, viemChain]);

  // Initialize account
  // Note: Use effectivePaymasterUrl (stable) instead of computedPaymasterUrl to avoid
  // re-initializing account when user changes fee token selection (which would cause
  // gas estimation to run multiple times in a dependency cycle)
  useEffect(() => {
    let isMounted = true;

    const initializeAccount = async () => {
      try {
        const restoredAccount = await getAccountForSigning(apiKey, chainId, effectivePaymasterUrl);
        if (isMounted) {
          setAccount(restoredAccount);
        }
      } catch (error) {
        console.error('[RevokePermissionDialogWrapper] Error initializing account:', error);
      }
    };

    initializeAccount();

    return () => {
      isMounted = false;
    };
  }, [apiKey, chainId, effectivePaymasterUrl]);

  // Format spends for display
  const formattedSpends = useMemo(() => {
    if (!fetchedPermissionData?.spends) return [];

    return fetchedPermissionData.spends.map((spend: any) => {
      const tokenAddress = spend.token;
      // Only a native token may borrow the chain symbol; anything else stays unnamed until
      // its own symbol resolves, or every token would render as the native currency.
      const tokenInfo = tokenInfoMap[tokenAddress] || {
        // Only a native token has decimals knowable without a read.
        decimals: isNativeToken(tokenAddress) ? (viemChain?.nativeCurrency?.decimals ?? 18) : null,
        symbol: isNativeToken(tokenAddress) ? nativeSymbol : '',
      };
      const allowance = BigInt(spend.allowance);
      const { amount, decimalsUnknown } = formatSpendAmount(allowance, tokenInfo.decimals);
      const limit = decimalsUnknown ? `${amount} base units` : `${amount} ${tokenInfo.symbol}`;
      // Format duration with multiplier (unit is period string like 'day', 'week', etc.)
      const multiplier = spend.multiplier ?? 1;
      const duration = `${multiplier} ${spend.unit}${multiplier > 1 ? 's' : ''}`;

      return {
        amount,
        decimalsUnknown,
        token: isNativeToken(tokenAddress) ? `Native (${nativeSymbol})` : tokenInfo.symbol,
        tokenAddress,
        duration,
        limit,
      };
    });
  }, [fetchedPermissionData, tokenInfoMap, viemChain, nativeSymbol]);

  // Format call permissions from fetched data. Signatures resolve asynchronously.
  const revokeCallSignatures = useFunctionSignatures(
    (fetchedPermissionData?.calls ?? []).map((call: any) => call.selector)
  );
  const formattedCalls = useMemo(() => {
    if (!fetchedPermissionData?.calls) return [];

    return fetchedPermissionData.calls.map((call: any) => ({
      target: call.target,
      selector: call.selector,
      functionSignature:
        call.functionSignature ||
        (call.selector ? (revokeCallSignatures[call.selector.toLowerCase()] ?? call.selector) : 'Unknown Function'),
    }));
  }, [fetchedPermissionData, revokeCallSignatures]);

  // Expiry date from fetched permission
  const expiryDate = useMemo(() => {
    if (!fetchedPermissionData) return '';
    // `Number`, not `parseInt`: the hook returns the relay's own typed record, where `end` may
    // already be a number.
    const endTimestamp = Number(fetchedPermissionData.end);
    return formatExpiryDate(endTimestamp);
  }, [fetchedPermissionData]);

  // Spender address from fetched permission
  // Empty until the relay responds — the dialog shows a placeholder row rather than a fake address.
  const spenderAddress = fetchedPermissionData?.spender ?? '';

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    if (!account) {
      console.error('[RevokePermissionDialogWrapper] Account not initialized');
      return;
    }

    submittingRef.current = true;
    setIsProcessing(true);
    onSubmissionInFlight?.(true);
    setStatus('Revoking permission...');
    try {
      // Revoke permission using Account class with paymaster context
      await account.revokePermission(
        request.data.permissionId as `0x${string}`,
        computedPaymasterUrl,
        computedPaymasterContext,
        request.data.address
      );

      setStatus('Permission revoked successfully!');
      onApprove({ success: true });
    } catch (error) {
      console.error('Permission revoke failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      setStatus(`Error: ${errorObj.message}`);
      // Check if user cancelled passkey prompt (NotAllowedError)
      if (errorObj.name === 'NotAllowedError') {
        onReject(UIError.userRejected('User cancelled the passkey prompt'));
      } else {
        // Internal error
        onReject(new UIError(standardErrorCodes.rpc.internal as UIErrorCode, errorObj.message));
      }
    } finally {
      // Order matters: onApprove/onReject settled above, so clearing the in-flight
      // flag here never opens a window where a boundary crash could mis-settle.
      onSubmissionInFlight?.(false);
      submittingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    // The disabled/dismissable gates commit a render late; a same-tick cancel must
    // not settle "rejected" while the signed revocation proceeds and lands on chain.
    if (submittingRef.current) return;
    setOpen(false);
    onReject(UIError.userRejected());
  };

  return (
    <PermissionDialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleCancel();
        else setOpen(newOpen);
      }}
      mode="revoke"
      permissionId={request.data.permissionId}
      revocationProblem={revocationProblem}
      spenderAddress={spenderAddress}
      accountAddress={request.data.address}
      origin={typeof window !== 'undefined' ? window.location.origin : 'unknown'}
      spends={formattedSpends}
      calls={formattedCalls}
      tokenMeta={tokenInfoMap}
      expiryDate={expiryDate}
      networkName={networkName}
      chainId={chainId}
      apiKey={apiKey}
      appName={appName}
      appLogoUrl={appLogoUrl}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      status={status}
      // Either half closes the gate: no Confirm until the permission AND its metadata land.
      isLoadingTokenInfo={isLoadingPermission || isLoadingTokenMetadata}
      mainnetRpcUrl={getMainnetRpcUrl(apiKey)}
      // Gas estimation props
      gasFee={gasFee}
      gasFeeLoading={gasFeeLoading}
      gasEstimationError={gasEstimationError}
      sponsored={isSponsored}
      // Fee token props for ERC-20 paymaster
      feeTokens={feeTokens}
      feeTokensLoading={feeTokensLoading}
      selectedFeeToken={selectedFeeToken}
      onFeeTokenSelect={setSelectedFeeToken}
      showFeeTokenSelector={!isSponsored && feeTokens.length > 0}
      isPayingWithErc20={isPayingWithErc20}
      nativeCurrencySymbol={viemChain?.nativeCurrency?.symbol}
    />
  );
}

// UnsupportedMethodDialogWrapper - handles unknown/unsupported methods
function UnsupportedMethodDialogWrapper({ method, onReject }: { method: string; onReject: (error?: Error) => void }) {
  const [open, setOpen] = useState(true);
  const [isClosing, setIsClosing] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'unknown';

  const handleClose = () => {
    if (!isClosing) {
      setIsClosing(true);
      setOpen(false);
      // Use UIError.unsupportedRequest which has proper error code
      onReject(UIError.unsupportedRequest(method));
    }
  };

  return (
    <DefaultDialogComponent
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) handleClose();
        else setOpen(newOpen);
      }}
      contentStyle={{
        width: 'fit-content',
        maxWidth: '450px',
      }}
    >
      <div className="flex flex-col gap-6 p-6">
        {/* Error Icon */}
        <div className="flex justify-center">
          <div className="bg-warning/10 flex h-16 w-16 items-center justify-center rounded-full">
            <svg className="text-warning h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
        </div>

        {/* Content */}
        <div className="text-center">
          <h3 className="text-foreground mb-2 text-xl font-bold">Unsupported Method</h3>
          <p className="text-muted-foreground mb-4 text-sm">This wallet does not support the following method:</p>
          <div className="bg-muted rounded-lg p-4">
            <code className="text-foreground break-all font-mono text-sm">{method}</code>
          </div>
        </div>

        {/* Origin */}
        <p className="text-muted-foreground text-center text-xs">Origin: {origin}</p>

        {/* Close Button */}
        <button
          onClick={handleClose}
          disabled={isClosing}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground w-full rounded-lg px-6 py-3 font-semibold transition-colors"
        >
          {isClosing ? 'Closing...' : 'Close'}
        </button>
      </div>
    </DefaultDialogComponent>
  );
}
