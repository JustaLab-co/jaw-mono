/** The relay's own cap on a frame. Nothing a real client sends through it is larger. */
export const MAX_FRAME_BYTES = 1_048_576;

export type BridgeInit = {
  chainId: number;
  ens?: string;
  appName?: string;
  apiKey?: string;
  paymaster?: { url: string; context?: Record<string, unknown> };
};

export type BridgeRequest = { id: string; method: string; params: unknown[] };

/** Why a frame was refused. A request refusal also carries the id and JSON-RPC code to answer with. */
export type Refused = { refused: string; id?: string; code?: number };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPaymasterUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === 'https:' || (protocol === 'http:' && LOCAL_HOSTS.has(hostname));
  } catch {
    return false;
  }
}

/** The init a client sent, or why it was refused. Absent optional fields, null included, stay absent. */
export function parseInit(inner: Record<string, unknown>, chains: readonly number[]): BridgeInit | Refused {
  const { chainId } = inner;
  const ens = inner.ens ?? undefined;
  const appName = inner.appName ?? undefined;
  const apiKey = inner.apiKey ?? undefined;
  const paymasterUrl = inner.paymasterUrl ?? undefined;
  const paymasterContext = inner.paymasterContext ?? undefined;

  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || !chains.includes(chainId)) {
    return { refused: `Unsupported chainId: ${String(chainId)}` };
  }
  for (const [field, value] of Object.entries({ ens, appName, apiKey })) {
    if (value !== undefined && typeof value !== 'string') return { refused: `Invalid ${field}: expected a string` };
  }

  const init: BridgeInit = { chainId };
  if (ens !== undefined) init.ens = ens as string;
  if (appName !== undefined) init.appName = appName as string;
  if (apiKey !== undefined) init.apiKey = apiKey as string;

  if (paymasterUrl === undefined) {
    if (paymasterContext !== undefined) return { refused: 'paymasterContext needs a paymasterUrl' };
    return init;
  }
  if (typeof paymasterUrl !== 'string' || !isPaymasterUrl(paymasterUrl)) {
    return { refused: 'Invalid paymasterUrl: expected an https URL' };
  }
  if (paymasterContext === undefined) {
    init.paymaster = { url: paymasterUrl };
    return init;
  }
  if (!isPlainObject(paymasterContext)) return { refused: 'Invalid paymasterContext: expected an object' };
  init.paymaster = { url: paymasterUrl, context: paymasterContext };
  return init;
}

/** The request a client sent, `'no-id'` when it cannot be answered at all, or why it was refused. */
export function parseRequest(inner: Record<string, unknown>): BridgeRequest | Refused | 'no-id' {
  const { id, method, params } = inner;
  if (typeof id !== 'string' || !id) return 'no-id';
  if (typeof method !== 'string' || !method) {
    return { refused: 'Invalid request: method must be a non-empty string', id, code: -32600 };
  }
  // `jaw rpc` and the `jaw_rpc` tool send one params value as given, so a lone value is the first param.
  const list = Array.isArray(params) ? params : params === undefined || params === null ? [] : [params];
  return { id, method, params: list };
}
