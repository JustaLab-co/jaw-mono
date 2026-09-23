'use client';

import { useState, useCallback, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { JAW, Mode } from '@jaw.id/core';
import type { JawTheme } from '@jaw.id/core';
import { ReactUIHandler } from '@jaw.id/ui';
import { ThemeStudioControls, DialogPreviews } from '../../components/shell/theme-studio';
import { ShellHeader } from '../../components/shell/header';
import { ShellSidebar, type ShellView } from '../../components/shell/sidebar';
import { useMobileDetail, MobileBackButton } from '../../components/shell/mobile-detail';
import { ConfigCard } from '../../components/shell/config-card';
import { MethodList } from '../../components/shell/method-list';

import { MethodDetail } from '../../components/shell/method-detail';
import { ResponsePanel, latestResponse, type LogEntry } from '../../components/shell/response-panel';
import { ExecutePanel, useMethodParams } from '../../components/shell/execute-panel';
import { EncodePanel } from '../../components/shell/encode-panel';
import { ConfigSnippet, type PaymasterApplyConfig } from '../../components/config-snippet';
import { RPC_METHODS, type RpcMethod } from '../../lib/rpc-methods';
import { activePresetLabel } from '../../lib/jaw-theme-presets';
import { reverseResolveEnsName } from '../../lib/ens-resolver';
import { resolveKeysUrl } from '../../lib/keys-url';
import { getAnalyticsClient } from '../../analytics';
import type { ModeName } from '../../analytics/events/types';

// Chain IDs arrive as hex (`0x...`) or decimal strings depending on the RPC.
const parseChainId = (c: string): number => (c.startsWith('0x') ? parseInt(c, 16) : parseInt(c, 10));

type ModeType = (typeof Mode)[keyof typeof Mode];
type TransportModeType = 'popup' | 'iframe' | 'auto';

const DEFAULT_CHAIN_ID_NUM = process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID
  ? Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID)
  : 84532;

function buildSdk(
  mode: ModeType,
  uiHandler?: ReactUIHandler,
  paymasters?: Record<number, { url: string; context?: Record<string, unknown> }>,
  theme?: JawTheme,
  transportMode?: TransportModeType
) {
  const keysUrl = resolveKeysUrl();

  return JAW.create({
    appName: 'JAW Playground',
    appLogoUrl: 'https://avatars.githubusercontent.com/u/159771991?s=200&v=4',
    defaultChainId: DEFAULT_CHAIN_ID_NUM,
    preference: {
      ...(keysUrl && { keysUrl }),
      showTestnets: true,
      mode,
      ...(transportMode && { transportMode }),
      uiHandler: mode === Mode.AppSpecific ? uiHandler : undefined,
    },
    apiKey: process.env.NEXT_PUBLIC_API_KEY || '',
    ens: process.env.NEXT_PUBLIC_ENS_NAME,
    paymasters,
    theme,
  });
}

function CorePageContent({ mode, transportMode }: { mode: ModeType; transportMode: TransportModeType }) {
  const [isConnected, setIsConnected] = useState(false);
  const [accounts, setAccounts] = useState<string[]>([]);
  const defaultChainId = String(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || 84532);
  const [chainId, setChainId] = useState<string>(defaultChainId);
  const [ensName, setEnsName] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // Which method is mid-flight, so a different method's panel doesn't claim it.
  const [runningMethodId, setRunningMethodId] = useState<string | null>(null);
  // v2 shell UI state: sidebar view and highlighted method.
  const [view, setView] = useState<ShellView>('playground');
  // Below md: method list and method detail take turns; the theme view stacks both.
  const { showDetail, openDetail, closeDetail } = useMobileDetail();
  const mobileSidebarHidden = view === 'playground' && showDetail;
  const mobileMainHidden = view === 'playground' && !showDetail;
  // wallet_connect is the default selection — the natural first step of a session.
  const [activeMethodId, setActiveMethodId] = useState<string | null>('wallet_connect');

  const [theme, setTheme] = useState<JawTheme>({ mode: 'auto' });
  // Draft the studio edits. The mock previews read this immediately; only Save
  // pushes it into the SDK (handleThemeChange), so the live dialogs below keep
  // the last saved theme while you experiment.
  const [draftTheme, setDraftTheme] = useState<JawTheme>({ mode: 'auto' });
  const themeDirty = JSON.stringify(draftTheme) !== JSON.stringify(theme);
  const uiHandlerRef = useRef<ReactUIHandler>(new ReactUIHandler({ theme }));
  const [sdk, setSdk] = useState(() => buildSdk(mode, uiHandlerRef.current, undefined, theme, transportMode));
  const [pmConfig, setPmConfig] = useState<PaymasterApplyConfig | undefined>();

  // Theme changes update the handler and provider in-place — no SDK
  // recreation, no disconnect. provider.setTheme covers both modes: it pushes
  // to the live keys dialog (CrossPlatform) and stores the theme for
  // AppSpecific's next request.
  const handleThemeChange = useCallback(
    (newTheme: JawTheme) => {
      setTheme(newTheme);
      uiHandlerRef.current.setTheme(newTheme);
      sdk.provider.setTheme(newTheme);
    },
    [sdk]
  );

  const handlePaymasterApply = useCallback(
    (config: PaymasterApplyConfig | null) => {
      if (config) {
        const paymasters: Record<number, { url: string; context?: Record<string, unknown> }> = {};
        for (const chain of config.chains) {
          paymasters[chain.chainId] = {
            url: chain.url,
            ...(chain.context && { context: chain.context }),
          };
        }
        setSdk(buildSdk(mode, uiHandlerRef.current, paymasters, theme, transportMode));
        setPmConfig(config);
      } else {
        setSdk(buildSdk(mode, uiHandlerRef.current, undefined, theme, transportMode));
        setPmConfig(undefined);
      }
    },
    [theme, mode, transportMode]
  );

  useEffect(() => {
    const address = accounts[0];
    if (!address || !chainId) {
      setEnsName(null);
      return;
    }
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? '';
    const chainIdNum = chainId.startsWith('0x') ? parseInt(chainId, 16) : parseInt(chainId, 10);
    if (Number.isNaN(chainIdNum)) {
      setEnsName(null);
      return;
    }
    let cancelled = false;
    reverseResolveEnsName(address, chainIdNum, rpcUrl).then((name) => {
      if (!cancelled) setEnsName(name);
    });
    return () => {
      cancelled = true;
    };
  }, [accounts, chainId]);

  const addLog = useCallback((type: LogEntry['type'], method: string, data: unknown) => {
    setLogs((prev) => [...prev, { timestamp: new Date(), type, method, data }]);
  }, []);

  const handleExecute = useCallback(
    async (method: string, params: unknown[]): Promise<unknown> => {
      addLog('request', method, params);

      const modeName: ModeName = mode === Mode.AppSpecific ? 'app-specific' : 'cross-platform';
      const analytics = getAnalyticsClient();

      try {
        const result = await sdk.provider.request({ method, params });

        addLog('response', method, result);

        if (method === 'eth_requestAccounts' || method === 'wallet_connect') {
          let connectedAccounts: string[] = [];
          if (Array.isArray(result)) {
            connectedAccounts = result as string[];
          } else if (result && typeof result === 'object' && 'accounts' in result) {
            const walletConnectResponse = result as {
              accounts: { address: string }[];
            };
            connectedAccounts = walletConnectResponse.accounts.map((acc) => acc.address);
          }
          if (connectedAccounts.length > 0) {
            setAccounts(connectedAccounts);
            setIsConnected(true);
            const chainIdResult = await sdk.provider.request({
              method: 'eth_chainId',
              params: [],
            });
            setChainId(chainIdResult as string);
            if (connectedAccounts[0]) analytics.identify(connectedAccounts[0]);
            analytics.track('WALLET_CONNECTED', {
              sdk: 'core',
              mode: modeName,
              transportMode,
              chainId: parseChainId(chainIdResult as string),
            });
          }
        } else if (method === 'wallet_disconnect') {
          setIsConnected(false);
          setAccounts([]);
          setChainId(defaultChainId);
          analytics.track('WALLET_DISCONNECTED', { sdk: 'core' });
          analytics.reset();
        } else if (method === 'wallet_switchEthereumChain') {
          const chainIdResult = await sdk.provider.request({
            method: 'eth_chainId',
            params: [],
          });
          const previousChainId = chainId;
          setChainId(chainIdResult as string);
          analytics.track('CHAIN_SWITCHED', {
            sdk: 'core',
            from: parseChainId(previousChainId),
            to: parseChainId(chainIdResult as string),
          });
        } else if (method === 'personal_sign') {
          analytics.track('MESSAGE_SIGNED', { sdk: 'core', mode: modeName });
        } else if (method === 'eth_signTypedData_v4') {
          analytics.track('TYPED_DATA_SIGNED', { sdk: 'core', mode: modeName });
        } else if (method === 'wallet_sign') {
          // wallet_sign is unified: type 0x01 is typed data, otherwise personal.

          const req = (params[0] as { type?: string }) ?? undefined;
          analytics.track(req?.type === '0x01' ? 'TYPED_DATA_SIGNED' : 'MESSAGE_SIGNED', {
            sdk: 'core',
            mode: modeName,
          });
        } else if (method === 'eth_sendTransaction') {
          analytics.track('TRANSACTION_SENT', { sdk: 'core', mode: modeName, chainId: parseChainId(chainId) });
        } else if (method === 'wallet_sendCalls') {
          const calls = (params[0] as { calls?: unknown[] })?.calls;
          analytics.track('CALLS_SENT', {
            sdk: 'core',
            mode: modeName,
            count: Array.isArray(calls) ? calls.length : 0,
          });
        } else if (method === 'wallet_grantPermissions') {
          analytics.track('PERMISSIONS_GRANTED', { sdk: 'core' });
        } else if (method === 'wallet_revokePermissions') {
          analytics.track('PERMISSIONS_REVOKED', { sdk: 'core' });
        }

        analytics.track('METHOD_EXECUTED', { sdk: 'core', method, mode: modeName, status: 'success' });

        return result;
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === 'object' && error !== null && 'message' in error
              ? (error as { message: string }).message
              : JSON.stringify(error);
        addLog('error', method, errorMessage);
        analytics.track('METHOD_EXECUTED', { sdk: 'core', method, mode: modeName, status: 'error' });
        throw error;
      }
    },
    [sdk, addLog, defaultChainId, mode, transportMode, chainId]
  );

  const themeMeta = activePresetLabel(theme) ?? (theme.colors ? 'Custom' : 'Default');
  const surface = transportMode === 'popup' ? ('popup' as const) : ('iframe' as const);
  const activeMethod = RPC_METHODS.find((m) => m.id === activeMethodId) ?? RPC_METHODS[0] ?? null;
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
    async (method: RpcMethod, resolvedParams: Record<string, string>) => {
      let built: unknown[];
      try {
        built = method.buildParams(resolvedParams, { address: accounts[0], chainId: chainId || undefined });
      } catch (err) {
        logUiError(method.method, err);
        return;
      }
      setRunningMethodId(method.id);
      try {
        await handleExecute(method.method, built);
      } catch {
        // Already logged inside handleExecute.
      } finally {
        setRunningMethodId(null);
      }
    },
    [accounts, chainId, handleExecute, logUiError]
  );

  // Straight to the keys dialog: plain passkey auth, no SIWE capabilities (Leo's call).
  const toggleConnect = () => {
    // Registry id and RPC method name coincide for both of these entries.
    const methodName = isConnected ? 'wallet_disconnect' : 'eth_requestAccounts';
    setRunningMethodId(methodName);
    setActiveMethodId(methodName);
    void handleExecute(methodName, [])
      .catch(() => {
        // Already logged inside handleExecute.
      })
      .finally(() => setRunningMethodId(null));
  };

  return (
    <div className="bg-shell-canvas text-shell-ink flex min-h-dvh flex-col md:grid md:h-screen md:min-h-0 md:grid-rows-[auto_1fr] md:overflow-hidden">
      <ShellHeader
        sdk="core"
        isConnected={isConnected}
        onToggleConnect={toggleConnect}
        address={accounts[0]}
        ensName={ensName}
        chainId={chainId}
      />

      <div className="flex flex-1 flex-col md:grid md:min-h-0 md:grid-cols-[334px_minmax(0,1fr)]">
        <ShellSidebar
          view={view}
          onViewChange={setView}
          themeMeta={themeMeta}
          mobileHidden={mobileSidebarHidden}
          methodCount={RPC_METHODS.length}
        >
          {view === 'playground' ? (
            <>
              <ConfigCard
                sdk="core"
                chainId={chainId}
                mode={mode === Mode.AppSpecific ? 'app-specific' : 'cross-platform'}
                transport={surface}
              />
              <MethodList
                methods={RPC_METHODS}
                selectedId={activeMethod?.id ?? null}
                onSelect={(m) => {
                  setActiveMethodId(m.id);
                  openDetail();
                }}
                isConnected={isConnected}
                transport={surface}
              />
            </>
          ) : (
            /* Theme controls: AppSpecific applies via ReactUIHandler, CrossPlatform
               via provider.setTheme pushing to the keys dialog. */
            <ThemeStudioControls
              theme={draftTheme}
              onThemeChange={setDraftTheme}
              onSave={() => handleThemeChange(draftTheme)}
              dirty={themeDirty}
            />
          )}
        </ShellSidebar>

        <main
          className={`flex min-h-0 flex-col overflow-y-auto max-md:flex-1 ${mobileMainHidden ? 'max-md:hidden' : ''}`}
        >
          <div className="flex flex-1 flex-col gap-6 px-6 py-6 md:px-9 md:py-[30px]">
            {view === 'theme' ? (
              <DialogPreviews theme={draftTheme} />
            ) : activeMethod ? (
              <>
                {/* Interim: ConfigSnippet moves to its shell home in a later step. */}
                <div className="flex items-center justify-end gap-3">
                  <MobileBackButton onClick={closeDetail} />
                  <ConfigSnippet
                    type="core"
                    mode={mode}
                    paymasters={pmConfig}
                    onPaymasterApply={handlePaymasterApply}
                  />
                </div>
                <MethodDetail
                  key={activeMethod.id}
                  method={activeMethod}
                  transport={surface}
                  isConnected={isConnected}
                  onToggleConnect={toggleConnect}
                  snippet={activeMethod.getCodeSnippet(methodParams)}
                  snippetLabel="@jaw.id/core"
                >
                  {activeMethod.category === 'utility' ? (
                    <EncodePanel dispatchNote="Local · viem" />
                  ) : (
                    <ExecutePanel
                      method={activeMethod}
                      params={methodParams}
                      onParamChange={setMethodParam}
                      context={{ address: accounts[0], chainId: chainId || undefined }}
                      isConnected={isConnected}
                      dispatchNote={dispatchNote}
                      running={isRunningActive}
                      onRun={(resolved) => runMethod(activeMethod, resolved)}
                      onError={(message) => addLog('error', activeMethod.method, message)}
                    />
                  )}
                </MethodDetail>
                {activeMethod.category !== 'utility' && (
                  <ResponsePanel response={latestResponse(logs, activeMethod.method)} running={isRunningActive} />
                )}
              </>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function CorePageInner() {
  const searchParams = useSearchParams();
  const modeParam = searchParams.get('mode');
  const transportParam = searchParams.get('transport');

  const mode: ModeType = modeParam === 'app-specific' ? Mode.AppSpecific : Mode.CrossPlatform;
  // SDK default is 'auto' (iframe primary); ?transport=popup is the opt-out.
  const transportMode: TransportModeType =
    transportParam === 'popup' ? 'popup' : transportParam === 'iframe' ? 'iframe' : 'auto';

  return <CorePageContent key={`${mode}-${transportMode}`} mode={mode} transportMode={transportMode} />;
}

export default function CorePage() {
  return (
    <Suspense
      fallback={
        <div className="bg-background flex min-h-screen items-center justify-center p-8">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <CorePageInner />
    </Suspense>
  );
}
