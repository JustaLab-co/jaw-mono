import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { config } from '@/connections/config';
import { errorLabel, log } from '@/lib/edge';
import { safeFetch } from '@/lib/safe-fetch';

const PROVIDER = 'aurora';

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

export type BackendAnswer =
  | { ok: true; status: DepositStatus }
  | { ok: false; code: 'unreachable' | 'invalid_response' | 'swap_unavailable' }
  | { ok: false; code: 'http_error'; httpStatus: number; untrustedError?: string };

export type BackendDeps = { fetch: typeof fetch; baseUrl: string; apiKey: string | undefined; timeoutMs: number };

const liveDeps = (): BackendDeps => ({
  fetch: safeFetch(config().insecureFetchHosts),
  baseUrl: config().swapUrl,
  apiKey: config().swapApiKey,
  timeoutMs: 10_000,
});

const isBackendState = (state: string): state is BackendState => Object.hasOwn(swapState, state);

const statusBody = z.object({
  result: z.object({
    data: z.object({
      provider: z.literal(PROVIDER),
      depositAddress: z.string(),
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

export function submitDeposit(deposit: { depositAddress: Address; txHash: Hex }, deps = liveDeps()) {
  return call(deposit.depositAddress, deps, `${deps.baseUrl}/move-asset/deposit/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: PROVIDER, depositAddress: deposit.depositAddress, txHash: deposit.txHash }),
  });
}

export function depositStatus(depositAddress: Address, deps = liveDeps()) {
  const query = new URLSearchParams({ provider: PROVIDER, depositAddress });
  return call(depositAddress, deps, `${deps.baseUrl}/move-asset/deposit/status?${query}`, { method: 'GET' });
}

async function call(
  depositAddress: Address,
  deps: BackendDeps,
  url: string,
  init: RequestInit
): Promise<BackendAnswer> {
  if (!deps.apiKey) return { ok: false, code: 'swap_unavailable' };
  let res: Response;
  let text: string;
  try {
    res = await deps.fetch(url, {
      ...init,
      headers: { ...init.headers, 'x-api-key': deps.apiKey },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
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
  if (!data || data.depositAddress.toLowerCase() !== depositAddress.toLowerCase()) {
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
