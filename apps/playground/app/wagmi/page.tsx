'use client';

import { useState, useCallback, useEffect, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { Mode, type PaymasterConfig, type JawTheme } from '@jaw.id/core';
import { ShellHeader } from '../../components/shell/header';
import { ShellSidebar, type ShellView } from '../../components/shell/sidebar';
import { ConfigCard } from '../../components/shell/config-card';
import { MethodList } from '../../components/shell/method-list';
import { MethodDetail } from '../../components/shell/method-detail';
import { ResponsePanel, latestResponse, type LogEntry } from '../../components/shell/response-panel';
import { ExecutePanel, useMethodParams } from '../../components/shell/execute-panel';
import { EncodePanel } from '../../components/shell/encode-panel';
import { ThemeStudioControls, DialogPreviews } from '../../components/shell/theme-studio';
import { activePresetLabel } from '../../lib/jaw-theme-presets';
import { derivePlaygroundTheme } from '../../lib/derive-playground-theme';
import { parseEther, formatUnits, type Address } from 'viem';
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useBalance,
  useSendTransaction,
  useSignMessage,
  useSignTypedData,
  useConnect as useWagmiConnect,
  useSendCalls,
  useCallsStatus,
} from 'wagmi';
import {
  useConnect,
  useDisconnect,
  useGrantPermissions,
  useRevokePermissions,
  useAddFunds,
  usePermissions,
  useGetAssets,
  useCapabilities,
  useSign,
  useGetCallsHistory,
  type PersonalSignRequestData,
  type TypedDataRequestData,
} from '@jaw.id/wagmi';

import { WagmiProviders } from './providers';
import { type ModeType, type TransportModeType } from './config';
import { ConfigSnippet, type PaymasterApplyConfig } from '../../components/config-snippet';
import { WAGMI_METHODS, type WagmiMethod } from '../../lib/wagmi-methods';
import { reverseResolveEnsName } from '../../lib/ens-resolver';
import { getAnalyticsClient } from '../../analytics';
import type { ModeName } from '../../analytics/events/types';

// Methods that open the embedded JAW dialog and require the user to sign/approve
// with their passkey. Surfacing this in the activity log keeps the sign step from
// feeling hidden by the see-through embedded UI (builder visibility).
const NEEDS_PASSKEY_APPROVAL: ReadonlySet<WagmiMethod['hookType']> = new Set([
  'jawConnect',
  'useSendTransaction',
  'useSignMessage',
  'useSignTypedData',
  'useSign',
  'useSendCalls',
  'useGrantPermissions',
  'useRevokePermissions',
]);

interface WagmiPageContentProps {
  mode: ModeType;
  transportMode: TransportModeType;
  pmConfig: PaymasterApplyConfig | undefined;
  onPaymasterApply: (config: PaymasterApplyConfig | null) => void;
  theme: JawTheme;
  onThemeChange: (theme: JawTheme) => void;
}

function WagmiPageContent({
  mode,
  transportMode,
  pmConfig,
  onPaymasterApply,
  theme,
  onThemeChange,
}: WagmiPageContentProps) {
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { data: balance } = useBalance({ address });
  const { connectors } = useWagmiConnect();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { sendCallsAsync } = useSendCalls();

  // JAW Wagmi Hooks
  const { mutateAsync: jawConnect } = useConnect();
  const { mutateAsync: jawDisconnect } = useDisconnect();
  // The mutations' own isPending flags are redundant: every call sits inside
  // handleExecute, which runMethod already brackets with runningMethodId.
  const { mutateAsync: grantPermissions } = useGrantPermissions();
  const { mutateAsync: revokePermissions } = useRevokePermissions();
  const { mutateAsync: addFunds } = useAddFunds();
  const { mutateAsync: sign } = useSign();

  // State for query addresses (allows querying for arbitrary addresses)
  const [permissionsAddress, setPermissionsAddress] = useState<string | undefined>();
  const [assetsAddress, setAssetsAddress] = useState<string | undefined>();
  const [capabilitiesAddress, setCapabilitiesAddress] = useState<string | undefined>();
  const [callsHistoryAddress, setCallsHistoryAddress] = useState<string | undefined>();

  const { data: permissions, refetch: refetchPermissions } = usePermissions({
    address: (permissionsAddress || address) as Address | undefined,
  });
  const { data: assets, refetch: refetchAssets } = useGetAssets({
    address: (assetsAddress || address) as Address | undefined,
  });
  const { data: capabilities, refetch: refetchCapabilities } = useCapabilities({
    address: (capabilitiesAddress || address) as Address | undefined,
  });
  const { data: callsHistory, refetch: refetchCallsHistory } = useGetCallsHistory({
    address: (callsHistoryAddress || address) as Address | undefined,
  });

  // Calls status state
  const [lastBatchId, setLastBatchId] = useState<string>('');
  const { refetch: refetchCallsStatus } = useCallsStatus({
    id: lastBatchId as `0x${string}`,
    connector,
    query: { enabled: !!lastBatchId, retry: false },
  });

  const [view, setView] = useState<ShellView>('playground');
  // null falls through to WAGMI_METHODS[0] (jaw_connect / useConnect) below, and
  // the sidebar highlights whatever that resolves to — the natural first step,
  // mirroring /core's wallet_connect.
  const [activeMethodId, setActiveMethodId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // Theme draft: the mock previews follow it live, Save commits via onThemeChange.
  const [draftTheme, setDraftTheme] = useState<JawTheme>(theme);
  const savedTheme = JSON.stringify(theme);
  const themeDirty = JSON.stringify(draftTheme) !== savedTheme;
  useEffect(() => {
    setDraftTheme(JSON.parse(savedTheme) as JawTheme);
  }, [savedTheme]);
  // Which method is mid-flight, so a different method's panel doesn't claim it.
  const [runningMethodId, setRunningMethodId] = useState<string | null>(null);
  const [ensName, setEnsName] = useState<string | null>(null);

  // Theme sync: push theme changes to the live keys dialog via the connector's
  // setTheme (re-themes in place) instead of rebuilding the connector. Calling
  // connector.setTheme never force-creates a provider, so it's safe to run on
  // every theme change — no duplicate prewarmed iframes (incl. under StrictMode).
  useEffect(() => {
    const jaw = connectors.find((c) => c.id === 'jaw') as
      | { setTheme?: (theme: JawTheme | undefined) => void }
      | undefined;
    jaw?.setTheme?.(theme);
  }, [theme, connectors]);

  useEffect(() => {
    if (!address || !chainId) {
      setEnsName(null);
      return;
    }
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? '';
    let cancelled = false;
    reverseResolveEnsName(address, chainId, rpcUrl).then((name) => {
      if (!cancelled) setEnsName(name);
    });
    return () => {
      cancelled = true;
    };
  }, [address, chainId]);

  // Link analytics to the connected wallet. wagmi resolves `address`
  // asynchronously after connect, so identify here rather than in the connect
  // handler.
  useEffect(() => {
    if (isConnected && address) {
      getAnalyticsClient().identify(address);
    }
  }, [isConnected, address]);

  const modeName: ModeName = mode === Mode.AppSpecific ? 'app-specific' : 'cross-platform';

  const addLog = useCallback((type: LogEntry['type'], method: string, data: unknown) => {
    setLogs((prev) => [...prev, { timestamp: new Date(), type, method, data }]);
  }, []);

  const handleExecute = useCallback(
    async (method: WagmiMethod, params: Record<string, unknown>): Promise<unknown> => {
      addLog('request', method.name, params);

      if (NEEDS_PASSKEY_APPROVAL.has(method.hookType)) {
        addLog('approval', method.name, 'Awaiting approval in the JAW dialog — the user signs with their passkey.');
      }

      try {
        let result: unknown;
        const jawConnector = connectors.find((c) => c.id === 'jaw');

        switch (method.hookType) {
          case 'jawConnect': {
            if (jawConnector) {
              const connectParams: Parameters<typeof jawConnect>[0] = { connector: jawConnector };
              if (params.capabilities) {
                connectParams.capabilities = params.capabilities as import('@jaw.id/core').WalletConnectCapabilities;
              }
              result = await jawConnect(connectParams);
            }
            break;
          }

          case 'jawDisconnect':
            result = await jawDisconnect({ connector });
            break;

          case 'useSwitchChain':
            result = await switchChainAsync({
              chainId: params.chainId as number,
            });
            break;

          case 'useSendTransaction':
            result = await sendTransactionAsync({
              to: params.to as Address,
              // Absent for a data-only call, and parseEther(undefined) throws.
              value: params.value === undefined ? undefined : parseEther(params.value as string),
              data: params.data as `0x${string}` | undefined,
            });
            break;

          case 'useSignMessage':
            result = await signMessageAsync({
              message: params.message as string,
            });
            break;

          case 'useSignTypedData':
            result = await signTypedDataAsync({
              domain: (params as { domain?: Record<string, unknown> }).domain || {},
              types: (params as { types?: Record<string, unknown> }).types || {},
              primaryType: (params as { primaryType?: string }).primaryType || '',
              message: (params as { message?: Record<string, unknown> }).message || {},
            });
            break;

          case 'useSign':
            result = await sign({
              chainId: params.chainId as number | undefined,
              request: params.request as PersonalSignRequestData | TypedDataRequestData,
            });
            break;

          case 'useSendCalls': {
            const sendCallsResult = await sendCallsAsync({
              calls: params.calls as Array<{
                to: Address;
                value?: bigint;
                data?: `0x${string}`;
              }>,
            });
            setLastBatchId(sendCallsResult.id);
            result = sendCallsResult;
            break;
          }

          case 'useCallsStatus': {
            const targetId = params.id as string;
            flushSync(() => setLastBatchId(targetId));
            const { data } = await refetchCallsStatus();
            result = data || { status: 'pending' };
            break;
          }

          case 'useCapabilities': {
            const targetAddress = params.address as string | undefined;
            if (targetAddress) {
              flushSync(() => setCapabilitiesAddress(targetAddress));
            }
            const { data } = await refetchCapabilities();
            result = data;
            break;
          }

          case 'useGrantPermissions':
            result = await grantPermissions({
              spender: params.spender as Address,
              expiry: params.expiry as number,
              permissions: params.permissions as Record<string, unknown>,
            });
            break;

          case 'useRevokePermissions':
            result = await revokePermissions({
              id: params.id as `0x${string}`,
            });
            break;

          case 'useAddFunds':
            // Resolves null: the screen closing is the whole outcome.
            result = await addFunds({ chainId: params.chainId as number | undefined });
            break;

          case 'usePermissions': {
            const targetAddress = (params.address as string) || address;
            if (targetAddress) {
              flushSync(() => setPermissionsAddress(targetAddress));
            }
            const { data } = await refetchPermissions();
            result = data;
            break;
          }

          case 'useGetAssets': {
            const targetAddress = (params.address as string) || address;
            if (targetAddress) {
              flushSync(() => setAssetsAddress(targetAddress));
            }
            const { data } = await refetchAssets();
            result = data;
            break;
          }

          case 'useGetCallsHistory': {
            const targetAddress = (params.address as string) || address;
            if (targetAddress) {
              flushSync(() => setCallsHistoryAddress(targetAddress));
            }
            const { data } = await refetchCallsHistory();
            result = data;
            break;
          }

          default:
            throw new Error(`Unknown hook type: ${method.hookType}`);
        }

        addLog('response', method.name, result);

        const analytics = getAnalyticsClient();
        analytics.track('METHOD_EXECUTED', {
          sdk: 'wagmi',
          method: method.method,
          hookType: method.hookType,
          category: method.category,
          mode: modeName,
          status: 'success',
        });
        switch (method.hookType) {
          case 'jawConnect':
            analytics.track('WALLET_CONNECTED', { sdk: 'wagmi', mode: modeName, transportMode, chainId });
            break;
          case 'jawDisconnect':
            analytics.track('WALLET_DISCONNECTED', { sdk: 'wagmi' });
            analytics.reset();
            break;
          case 'useSwitchChain':
            analytics.track('CHAIN_SWITCHED', { sdk: 'wagmi', from: chainId, to: params.chainId as number });
            break;
          case 'useSendTransaction':
            analytics.track('TRANSACTION_SENT', { sdk: 'wagmi', mode: modeName, chainId });
            break;
          case 'useSendCalls':
            analytics.track('CALLS_SENT', {
              sdk: 'wagmi',
              mode: modeName,
              count: Array.isArray(params.calls) ? params.calls.length : 0,
            });
            break;
          case 'useSignMessage':
            analytics.track('MESSAGE_SIGNED', { sdk: 'wagmi', mode: modeName });
            break;
          case 'useSignTypedData':
            analytics.track('TYPED_DATA_SIGNED', { sdk: 'wagmi', mode: modeName });
            break;
          case 'useSign': {
            // wallet_sign is unified: type 0x01 is typed data, otherwise personal.
            const req = params.request as { type?: string } | undefined;
            analytics.track(req?.type === '0x01' ? 'TYPED_DATA_SIGNED' : 'MESSAGE_SIGNED', {
              sdk: 'wagmi',
              mode: modeName,
            });
            break;
          }
          case 'useGrantPermissions':
            analytics.track('PERMISSIONS_GRANTED', { sdk: 'wagmi' });
            break;
          case 'useRevokePermissions':
            analytics.track('PERMISSIONS_REVOKED', { sdk: 'wagmi' });
            break;
        }

        return result;
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === 'object' && error !== null && 'message' in error
              ? (error as { message: string }).message
              : JSON.stringify(error);
        addLog('error', method.name, errorMessage);
        getAnalyticsClient().track('METHOD_EXECUTED', {
          sdk: 'wagmi',
          method: method.method,
          hookType: method.hookType,
          category: method.category,
          mode: modeName,
          status: 'error',
        });
        throw error;
      }
    },
    [
      address,
      connectors,
      jawConnect,
      jawDisconnect,
      connector,
      switchChainAsync,
      sendTransactionAsync,
      signMessageAsync,
      signTypedDataAsync,
      sign,
      sendCallsAsync,
      capabilities,
      grantPermissions,
      revokePermissions,
      setPermissionsAddress,
      refetchPermissions,
      permissions,
      setAssetsAddress,
      refetchAssets,
      assets,
      setCapabilitiesAddress,
      refetchCapabilities,
      refetchCallsStatus,
      setCallsHistoryAddress,
      refetchCallsHistory,
      callsHistory,
      addLog,
      modeName,
      transportMode,
      chainId,
    ]
  );

  // ---- shell wiring (mirrors /core) --------------------------------------
  const themeMeta = activePresetLabel(theme) ?? (theme.colors ? 'Custom' : 'Default');
  const surface = transportMode === 'popup' ? ('popup' as const) : ('iframe' as const);
  const activeMethod = WAGMI_METHODS.find((m) => m.id === activeMethodId) ?? WAGMI_METHODS[0] ?? null;
  const [methodParams, setMethodParam] = useMethodParams(activeMethod);
  const isRunningActive = runningMethodId !== null && runningMethodId === activeMethod?.id;
  const dispatchNote = `${surface === 'popup' ? 'Popup' : 'Iframe (default)'} · ${
    mode === Mode.AppSpecific ? 'App-Specific' : 'Cross-Platform'
  }`;

  // Errors are surfaced through the same log the response panel reads from —
  // handleExecute logs its own; this covers the pre-execution stages.
  const logUiError = useCallback(
    (methodName: string, err: unknown) => {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? (err as { message: string }).message
            : JSON.stringify(err);
      addLog('error', methodName, message);
    },
    [addLog]
  );

  const runMethod = useCallback(
    async (method: WagmiMethod, resolvedParams: Record<string, string>) => {
      let built: Record<string, unknown>;
      try {
        built = method.buildParams(resolvedParams, { address, chainId: chainId || undefined });
      } catch (err) {
        logUiError(method.name, err);
        return;
      }
      setRunningMethodId(method.id);
      try {
        await handleExecute(method, built);
      } catch {
        // Already logged inside handleExecute.
      } finally {
        setRunningMethodId(null);
      }
    },
    [address, chainId, handleExecute, logUiError]
  );

  // Connect/disconnect run through the SAME dispatcher as every other method —
  // no separate path, so the activity log and response panel see them too.
  const toggleConnect = () => {
    const target = WAGMI_METHODS.find((m) => m.hookType === (isConnected ? 'jawDisconnect' : 'jawConnect'));
    if (!target) return;
    setActiveMethodId(target.id);
    void runMethod(target, {});
  };

  return (
    <div className="bg-shell-canvas text-shell-ink grid h-screen grid-rows-[auto_1fr] overflow-hidden">
      <ShellHeader
        sdk="wagmi"
        isConnected={isConnected}
        onToggleConnect={toggleConnect}
        address={address}
        ensName={ensName}
        chainId={chainId}
        balance={
          balance
            ? `${parseFloat(formatUnits(balance.value, balance.decimals)).toFixed(4)} ${balance.symbol}`
            : undefined
        }
      />

      <div className="grid min-h-0 grid-cols-[334px_minmax(0,1fr)]">
        <ShellSidebar view={view} onViewChange={setView} themeMeta={themeMeta} methodCount={WAGMI_METHODS.length}>
          {view === 'playground' ? (
            <>
              <ConfigCard
                sdk="wagmi"
                chainId={chainId}
                mode={mode === Mode.AppSpecific ? 'app-specific' : 'cross-platform'}
                transport={surface}
              />
              <MethodList
                methods={WAGMI_METHODS}
                selectedId={activeMethod?.id ?? null}
                onSelect={(m) => setActiveMethodId(m.id)}
                isConnected={isConnected}
                transport={surface}
              />
            </>
          ) : (
            /* Theme controls: AppSpecific applies via ReactUIHandler, CrossPlatform
               via the connector's setTheme pushing to the keys dialog. */
            <ThemeStudioControls
              theme={draftTheme}
              onThemeChange={setDraftTheme}
              onSave={() => onThemeChange(draftTheme)}
              dirty={themeDirty}
            />
          )}
        </ShellSidebar>

        <main className="flex min-h-0 flex-col overflow-y-auto">
          <div className="flex flex-1 flex-col gap-6 px-6 py-6 md:px-9 md:py-[30px]">
            {view === 'theme' ? (
              <DialogPreviews theme={draftTheme} />
            ) : activeMethod ? (
              <>
                <div className="flex justify-end">
                  <ConfigSnippet type="wagmi" mode={mode} paymasters={pmConfig} onPaymasterApply={onPaymasterApply} />
                </div>
                <MethodDetail
                  key={activeMethod.id}
                  method={activeMethod}
                  transport={surface}
                  isConnected={isConnected}
                  onToggleConnect={toggleConnect}
                  snippet={activeMethod.getCodeSnippet(methodParams)}
                  snippetLabel="@jaw.id/wagmi"
                >
                  {activeMethod.category === 'utility' ? (
                    <EncodePanel dispatchNote="Local · viem" />
                  ) : (
                    <ExecutePanel
                      method={activeMethod}
                      params={methodParams}
                      onParamChange={setMethodParam}
                      context={{ address, chainId: chainId ? String(chainId) : undefined }}
                      isConnected={isConnected}
                      dispatchNote={dispatchNote}
                      running={isRunningActive}
                      onRun={(resolved) => runMethod(activeMethod, resolved)}
                      onError={(message) => addLog('error', activeMethod.name, message)}
                    />
                  )}
                </MethodDetail>
                {activeMethod.category !== 'utility' && (
                  <ResponsePanel response={latestResponse(logs, activeMethod.name)} running={isRunningActive} />
                )}
              </>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function WagmiPageInner() {
  const searchParams = useSearchParams();
  const modeParam = searchParams.get('mode');
  const transportParam = searchParams.get('transport');

  const mode: ModeType = modeParam === 'app-specific' ? Mode.AppSpecific : Mode.CrossPlatform;
  // SDK default is 'auto' (iframe primary); ?transport=popup is the opt-out.
  const transportMode: TransportModeType =
    transportParam === 'popup' ? 'popup' : transportParam === 'iframe' ? 'iframe' : 'auto';

  const [paymasters, setPaymasters] = useState<Record<number, PaymasterConfig> | undefined>();
  const [pmConfig, setPmConfig] = useState<PaymasterApplyConfig | undefined>();
  // null until resolved on the client. We gate the connector mount on this so
  // the JAW provider is constructed (and prewarms the keys iframe with the
  // theme) only once we know the real theme — otherwise the prewarm sends a
  // stale `{mode:'auto'}` that the later update never re-delivers.
  const [theme, setTheme] = useState<JawTheme | null>(null);

  // CrossPlatform only: a manual ThemePicker change pauses the auto-derive
  // below; picking "Default" resumes it.
  const [themeCustomized, setThemeCustomized] = useState(false);

  // CrossPlatform: derive the JAW theme from the playground's OWN design
  // tokens so the embedded keys dialog matches the app automatically (theme
  // sync) — until the user picks a theme manually. AppSpecific is always
  // ThemePicker-driven. We read the mode from the DOM (the `dark` class on
  // <html>) and re-derive whenever it changes, so the dialog always tracks how
  // the playground actually renders.
  useEffect(() => {
    if (mode !== Mode.CrossPlatform || themeCustomized) {
      // ThemePicker-driven: initialise once, then let the picker drive it.
      setTheme((current) => current ?? { mode: 'auto' });
      return;
    }
    const update = () => setTheme(derivePlaygroundTheme());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [mode, themeCustomized]);

  const handleThemeChange = useCallback(
    (next: JawTheme) => {
      if (mode !== Mode.CrossPlatform) {
        setTheme(next);
        return;
      }
      // "Default" (nothing customized) hands control back to the auto-derive.
      const isDefault =
        (next.mode ?? 'auto') === 'auto' &&
        !next.accentColor &&
        !next.colors &&
        !next.cssVariables &&
        !next.borderRadius &&
        !next.fontStack;
      setThemeCustomized(!isDefault);
      setTheme(isDefault ? derivePlaygroundTheme() : next);
    },
    [mode]
  );

  const handlePaymasterApply = (config: PaymasterApplyConfig | null) => {
    if (config) {
      const record: Record<number, PaymasterConfig> = {};
      for (const chain of config.chains) {
        record[chain.chainId] = {
          url: chain.url,
          ...(chain.context && { context: chain.context }),
        };
      }
      setPaymasters(record);
      setPmConfig(config);
    } else {
      setPaymasters(undefined);
      setPmConfig(undefined);
    }
  };

  // Don't build the connector until the theme is resolved (see note above).
  if (!theme) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <div className="border-primary h-10 w-10 animate-spin rounded-full border-b-2" />
      </div>
    );
  }

  return (
    <WagmiProviders mode={mode} paymasters={paymasters} theme={theme} transportMode={transportMode}>
      <WagmiPageContent
        key={`${mode}-${transportMode}`}
        mode={mode}
        transportMode={transportMode}
        pmConfig={pmConfig}
        onPaymasterApply={handlePaymasterApply}
        theme={theme}
        onThemeChange={handleThemeChange}
      />
    </WagmiProviders>
  );
}

export default function WagmiPage() {
  return (
    <Suspense
      fallback={
        <div className="bg-background flex min-h-screen items-center justify-center p-8">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <WagmiPageInner />
    </Suspense>
  );
}
