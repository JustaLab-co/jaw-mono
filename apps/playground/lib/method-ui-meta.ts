import { CATEGORIES, CATEGORY_LABELS, type MethodCategory, type ParameterDefinition } from './rpc-methods';

/**
 * UI-side metadata for the v2 shell's method list. Purely presentational —
 * the registries in rpc-methods.ts / wagmi-methods.ts stay the source of
 * truth for what a method is and how it executes.
 */

/** Common structural shape of RpcMethod and WagmiMethod, as the shell sees it. */
export interface PlaygroundMethod {
  id: string;
  name: string;
  method: string;
  category: MethodCategory;
  description: string;
  requiresConnection: boolean;
}

/** RPC methods that open the JAW dialog (keyed by `method`, not registry id). */
export const DIALOG_METHODS: ReadonlySet<string> = new Set([
  'eth_requestAccounts',
  'wallet_connect',
  'wallet_switchEthereumChain',
  'eth_sendTransaction',
  'wallet_sendCalls',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_sign',
  'wallet_grantPermissions',
  'wallet_revokePermissions',
  'wallet_addFunds',
]);

/** Methods whose dialog only appears while disconnected. */
export const NEEDS_DISCONNECTED: ReadonlySet<string> = new Set(['eth_requestAccounts', 'wallet_connect']);

export function opensDialog(m: PlaygroundMethod): boolean {
  return DIALOG_METHODS.has(m.method);
}

export type TriggerFilter = 'all' | 'dialog' | 'silent';

export function filterMethods<M extends PlaygroundMethod>(methods: M[], query: string, trigger: TriggerFilter): M[] {
  const q = query.trim().toLowerCase();
  return methods.filter((m) => {
    const dialog = opensDialog(m);
    if (trigger === 'dialog' && !dialog) return false;
    if (trigger === 'silent' && dialog) return false;
    return !q || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q);
  });
}

export interface MethodGroup<M extends PlaygroundMethod> {
  category: MethodCategory;
  label: string;
  items: M[];
}

/** Groups methods by category in the canonical order, dropping empty groups. */
export function groupMethods<M extends PlaygroundMethod>(methods: M[]): MethodGroup<M>[] {
  return CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    items: methods.filter((m) => m.category === category),
  })).filter((g) => g.items.length > 0);
}

/**
 * The connection state blocks this method: either it needs a connection and
 * there isn't one, or it only makes sense while disconnected (connect) and the
 * account is already connected.
 */
export function methodBlocked(m: PlaygroundMethod, isConnected: boolean): boolean {
  return (m.requiresConnection && !isConnected) || (NEEDS_DISCONNECTED.has(m.method) && isConnected);
}

/** Amber dot when running the method now would not behave as expected. */
export function methodNeedsAttention(m: PlaygroundMethod, isConnected: boolean): boolean {
  return methodBlocked(m, isConnected);
}

/**
 * The registry's declared defaults for one method, as a parameter form's
 * initial values. A param with no `defaultValue` starts absent rather than
 * empty — the field falls back to its placeholder and `buildParams` sees
 * `undefined`, which is what the registries' `??` fallbacks expect.
 */
export function defaultParams(parameters?: ParameterDefinition[]): Record<string, string> {
  const defaults: Record<string, string> = {};
  parameters?.forEach((param) => {
    if (param.defaultValue) defaults[param.name] = param.defaultValue;
  });
  return defaults;
}

/** Split "wallet_sendCalls" into a dimmed "wallet_" prefix and bold rest. */
export function splitMethodName(name: string): { prefix: string; rest: string } {
  const cut = name.indexOf('_');
  return cut >= 0 ? { prefix: name.slice(0, cut + 1), rest: name.slice(cut + 1) } : { prefix: '', rest: name };
}
