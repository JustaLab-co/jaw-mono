import type { Hex } from 'viem';
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
  | { ok: false; code: 'unreachable' | 'invalid_response' }
  | { ok: false; code: 'http_error'; httpStatus: number; untrustedError?: string };

export type BackendDeps = { fetch: typeof fetch; baseUrl: string; timeoutMs: number };

const liveDeps = (): BackendDeps => ({
  fetch: safeFetch(config().insecureFetchHosts),
  baseUrl: config().swapUrl,
  timeoutMs: 10_000,
});

const backendState = z.enum(Object.keys(swapState) as [BackendState, ...BackendState[]]);

const statusBody = z.object({
  result: z.object({
    data: z.object({
      provider: z.literal(PROVIDER),
      depositAddress: z.string(),
      state: z.string().max(256),
      txHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .optional(),
      rawState: z.string().max(256).optional(),
    }),
  }),
});

const errorBody = z.object({ result: z.object({ error: z.string().max(256) }) });

export function submitDeposit(deposit: { depositAddress: string; txHash: Hex }, deps = liveDeps()) {
  return call(deposit.depositAddress, deps, `${deps.baseUrl}/move-asset/deposit/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: PROVIDER, depositAddress: deposit.depositAddress, txHash: deposit.txHash }),
  });
}

export function depositStatus(depositAddress: string, deps = liveDeps()) {
  const query = new URLSearchParams({ provider: PROVIDER, depositAddress });
  return call(depositAddress, deps, `${deps.baseUrl}/move-asset/deposit/status?${query}`, { method: 'GET' });
}

async function call(depositAddress: string, deps: BackendDeps, url: string, init: RequestInit): Promise<BackendAnswer> {
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
    return { ok: false, code: 'http_error', httpStatus: res.status, ...(untrustedError && { untrustedError }) };
  }
  const parsed = statusBody.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'invalid_response' };
  const { depositAddress: answered, state, txHash, rawState } = parsed.data.result.data;
  if (answered.toLowerCase() !== depositAddress.toLowerCase()) return { ok: false, code: 'invalid_response' };
  const extra = {
    ...(txHash && { txHash: txHash as Hex }),
    ...(rawState !== undefined && { untrustedRawState: rawState }),
  };
  const known = backendState.safeParse(state);
  if (!known.success) return { ok: true, status: { state: 'unknown', untrustedState: state, ...extra } };
  return { ok: true, status: { state: swapState[known.data], backendState: known.data, ...extra } };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
