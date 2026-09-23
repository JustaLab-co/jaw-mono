'use client';

import { useCallback, useState } from 'react';
import type { ParameterDefinition } from '../../lib/rpc-methods';
import { defaultParams, methodBlocked, type PlaygroundMethod } from '../../lib/method-ui-meta';
import { ParameterField } from '../parameter-field';
import { isLikelyEnsName, resolveEnsToAddress, resolveEnsToAddresses } from '../../lib/ens-resolver';

export interface ExecutableMethod extends PlaygroundMethod {
  parameters?: ParameterDefinition[];
}

/**
 * Form state for the selected method, held by the PAGE rather than by the
 * panel below: MethodDetail unmounts the Execute tab when you switch to Code
 * Snippet (which would wipe whatever was typed), and that same tab renders its
 * snippet from these values. Resets to the registry defaults when the method
 * changes — React's "adjust state when a prop changes" pattern, so no effect
 * and no extra commit.
 */
export function useMethodParams(
  method: ExecutableMethod | null
): [Record<string, string>, (name: string, value: string) => void] {
  const [state, setState] = useState(() => ({
    id: method?.id,
    values: defaultParams(method?.parameters),
  }));

  if (method && method.id !== state.id) {
    setState({ id: method.id, values: defaultParams(method.parameters) });
  }

  const setParam = useCallback((name: string, value: string) => {
    setState((prev) => ({ ...prev, values: { ...prev.values, [name]: value } }));
  }, []);

  return [state.values, setParam];
}

export interface ExecutePanelProps {
  method: ExecutableMethod;
  /** Form values from useMethodParams above. */
  params: Record<string, string>;
  onParamChange: (name: string, value: string) => void;
  context: { address?: string; chainId?: string };
  isConnected: boolean;
  /** "Iframe (default) · Cross-Platform" header note. */
  dispatchNote: string;
  /** True while the page-level execution is in flight. */
  running: boolean;
  /** Receives ENS-resolved param values; the page builds params and executes. */
  onRun: (resolvedParams: Record<string, string>) => void | Promise<void>;
  /** Resolution failures (ENS lookup, bad JSON) — surfaced by the page. */
  onError: (message: string) => void;
}

/**
 * Inline parameter form — the MethodModal's execute tab as a main-pane panel.
 * Param defaults, showWhen filtering, and ENS resolution ported verbatim.
 * Controlled by useMethodParams above, so the values survive a tab switch and
 * feed the Code Snippet tab.
 */
export function ExecutePanel({
  method,
  params,
  onParamChange,
  context,
  isConnected,
  dispatchNote,
  running,
  onRun,
  onError,
}: ExecutePanelProps) {
  const [isResolving, setIsResolving] = useState(false);

  const parseChainIdString = (value: string): number => {
    return value.startsWith('0x') ? parseInt(value, 16) : parseInt(value, 10);
  };

  const determineTargetChainId = (): number => {
    const methodChainId = params.chainId;
    if (methodChainId && methodChainId !== 'default') {
      const parsed = parseChainIdString(methodChainId);
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (context.chainId) {
      const parsed = parseChainIdString(context.chainId);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 1;
  };

  const resolveParamsForExecution = async (): Promise<Record<string, string>> => {
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? '';
    const targetChainId = determineTargetChainId();
    const next: Record<string, string> = { ...params };

    for (const param of method.parameters ?? []) {
      if (param.type !== 'address') continue;
      const value = next[param.name];
      if (!value || !isLikelyEnsName(value)) continue;
      next[param.name] = await resolveEnsToAddress(value, targetChainId, rpcUrl);
    }

    if (method.id === 'wallet_sendCalls' && next.calls) {
      const calls = JSON.parse(next.calls) as Array<{ to?: string; [k: string]: unknown }>;
      const ensIndices: number[] = [];
      const ensNames: string[] = [];
      calls.forEach((call, i) => {
        if (typeof call.to === 'string' && isLikelyEnsName(call.to)) {
          ensIndices.push(i);
          ensNames.push(call.to);
        }
      });

      if (ensNames.length > 0) {
        const resolved = await resolveEnsToAddresses(ensNames, targetChainId, rpcUrl);
        ensIndices.forEach((idx, i) => {
          calls[idx].to = resolved[i];
        });
      }
      next.calls = JSON.stringify(calls, null, 2);
    }

    return next;
  };

  const handleRun = async () => {
    let resolvedParams: Record<string, string>;
    setIsResolving(true);
    try {
      resolvedParams = await resolveParamsForExecution();
    } catch (err) {
      onError(err instanceof Error ? err.message : JSON.stringify(err));
      setIsResolving(false);
      return;
    }
    setIsResolving(false);
    await onRun(resolvedParams);
  };

  // Not just "needs a connection": a connect method (eth_requestAccounts /
  // wallet_connect) is only runnable while DISCONNECTED — with an account already
  // connected its dialog never appears, so executing it does nothing visible.
  const canExecute = !methodBlocked(method, isConnected);
  const blockedReason = method.requiresConnection
    ? 'Connect your wallet first to execute this method.'
    : 'Already connected — disconnect first to run this method.';

  // Filter parameters: generic showWhen + method-specific wallet_sign logic
  const filteredParameters = method.parameters?.filter((param) => {
    // Generic showWhen: only show when another param has a specific value
    if (param.showWhen) {
      const showWhen = param.showWhen;
      const currentValue =
        params[showWhen.param] ?? method.parameters?.find((p) => p.name === showWhen.param)?.defaultValue ?? '';
      return currentValue === showWhen.value;
    }
    // For wallet_sign, show message field only for 0x45, and typedData field only for 0x01
    if (method.id === 'wallet_sign') {
      const selectedType = params.type || '0x45';
      if (param.name === 'message' && selectedType !== '0x45') return false;
      if (param.name === 'typedData' && selectedType !== '0x01') return false;
    }
    return true;
  });

  return (
    <div className="border-shell-line bg-shell-raise rounded-2xl border">
      <div className="border-shell-line bg-shell-raise flex flex-wrap items-center justify-between gap-4 rounded-t-2xl border-b px-6 py-4">
        <span className="text-shell-ink-3 text-[13px]">{dispatchNote}</span>
        <div className="flex flex-col items-end gap-1.5 max-md:items-start">
          <button
            type="button"
            onClick={handleRun}
            disabled={!canExecute || running || isResolving}
            className="bg-shell-btn text-shell-btn-ink inline-flex min-h-[46px] cursor-pointer items-center gap-[9px] rounded-full border-0 px-5 text-[15px] font-medium tracking-[-0.005em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isResolving ? 'Resolving…' : running ? 'Executing…' : 'Execute'}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h13" />
              <path d="M13 6l6 6-6 6" />
            </svg>
          </button>
          {!canExecute && <p className="text-shell-warn m-0 text-xs">{blockedReason}</p>}
        </div>
      </div>

      <div className="flex flex-col gap-[26px] p-[26px]">
        {filteredParameters && filteredParameters.length > 0 ? (
          filteredParameters.map((param) => (
            <ParameterField
              key={param.name}
              param={param}
              value={params[param.name] || ''}
              onChange={(value) => onParamChange(param.name, value)}
              context={context}
            />
          ))
        ) : (
          <p className="text-shell-ink-3 m-0 text-sm">This method has no parameters.</p>
        )}
      </div>
    </div>
  );
}
