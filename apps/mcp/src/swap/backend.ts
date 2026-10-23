import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { config } from '@/connections/config';
import { errorLabel, log } from '@/lib/edge';
import { safeFetch } from '@/lib/safe-fetch';

const swapState = {
  PENDING_DEPOSIT: 'pending_deposit',
  KNOWN_DEPOSIT_TX: 'submitted',
  PROCESSING: 'submitted',
  INCOMPLETE_DEPOSIT: 'submitted',
  SUCCESS: 'completed',
  REFUNDED: 'refunded',
  FAILED: 'failed',
} as const;

export type BackendState = keyof typeof swapState;
export type DepositState = (typeof swapState)[BackendState];

export type DepositStatus = { txHash?: Hex; untrustedRawState?: string } & (
  | { state: DepositState; backendState: BackendState }
  | { state: 'unknown'; untrustedState: string }
);

export type KnownStatus = Extract<DepositStatus, { backendState: BackendState }>;

export type BackendAnswer =
  | { ok: true; status: DepositStatus }
  | { ok: false; code: 'unreachable' | 'invalid_response' }
  | { ok: false; code: 'http_error'; httpStatus: number; untrustedError?: string };

export type TrackKey =
  | { provider: 'aurora'; depositAddress: Address }
  | { provider: 'relay'; requestId: Hex }
  | { provider: 'across'; originChainId: number; depositId: string };

export type BackendDeps = { fetch: typeof fetch; baseUrl: string; timeoutMs: number };

const liveDeps = (): BackendDeps => ({
  fetch: safeFetch(config().insecureFetchHosts),
  baseUrl: config().swapUrl,
  timeoutMs: 10_000,
});

const isBackendState = (state: string): state is BackendState => Object.hasOwn(swapState, state);

const echoedInteger = z
  .union([z.int(), z.string().regex(/^\d{1,78}$/)])
  .transform(BigInt)
  .optional()
  .catch(undefined);

const statusBody = z.object({
  result: z.object({
    data: z.object({
      provider: z.string(),
      depositAddress: z.string().optional(),
      requestId: z.string().optional(),
      originChainId: echoedInteger,
      depositId: echoedInteger,
      state: z.string().max(256),
      txHash: z
        .custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v))
        .optional()
        .catch(undefined),
      rawState: z.string().max(256).optional().catch(undefined),
    }),
  }),
});

const errorBody = z.object({ result: z.object({ error: z.string().max(256) }) });

type StatusData = z.infer<typeof statusBody>['result']['data'];

function echoes(key: TrackKey, data: StatusData): boolean {
  if (data.provider !== key.provider) return false;
  switch (key.provider) {
    case 'aurora':
      return data.depositAddress?.toLowerCase() === key.depositAddress.toLowerCase();
    case 'relay':
      return data.requestId?.toLowerCase() === key.requestId.toLowerCase();
    case 'across':
      return data.originChainId === BigInt(key.originChainId) && data.depositId === BigInt(key.depositId);
  }
}

export function submitDeposit(key: TrackKey, txHash: Hex, originChainId: number, deps = liveDeps()) {
  const body = { ...key, txHash, ...(key.provider === 'relay' && { originChainId }) };
  return call(key, deps, `${deps.baseUrl}/move-asset/deposit/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function depositStatus(key: TrackKey, deps = liveDeps()) {
  const query = new URLSearchParams(Object.entries(key).map(([name, value]) => [name, String(value)]));
  return call(key, deps, `${deps.baseUrl}/move-asset/deposit/status?${query}`, { method: 'GET' });
}

async function call(key: TrackKey, deps: BackendDeps, url: string, init: RequestInit): Promise<BackendAnswer> {
  let res: Response;
  let text: string;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs) });
    text = await res.text();
  } catch (err) {
    log('warn', { msg: 'swap backend unreachable', error: errorLabel(err) });
    return { ok: false, code: 'unreachable' };
  }
  const body = parseJson(text);
  if (!res.ok) {
    const untrustedError = errorBody.safeParse(body).data?.result.error;
    log('warn', { msg: 'swap backend http error', status: res.status });
    return { ok: false, code: 'http_error', httpStatus: res.status, ...(untrustedError && { untrustedError }) };
  }
  const data = statusBody.safeParse(body).data?.result.data;
  if (!data || !echoes(key, data)) {
    log('warn', { msg: 'swap backend invalid response' });
    return { ok: false, code: 'invalid_response' };
  }
  const { state, txHash, rawState } = data;
  const extra = {
    ...(txHash && { txHash }),
    ...(rawState !== undefined && { untrustedRawState: rawState }),
  };
  if (!isBackendState(state)) return { ok: true, status: { state: 'unknown', untrustedState: state, ...extra } };
  return { ok: true, status: { state: swapState[state], backendState: state, ...extra } };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
