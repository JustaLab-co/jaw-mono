import { getAddress, isAddress, type Address } from 'viem';
import type { Tenant } from '@/connections/auth';
import { config, ownerWindowMs } from '@/connections/config';
import { errorLabel, log } from '@/lib/edge';
import { fenceText } from '@/lib/fence';
import { refusal, safeFetch } from '@/lib/safe-fetch';
import { checkQuote, type CheckCode, type QuoteRequest } from './check';
import { sameAsset } from './check/assets';
import {
  depositAddressReused,
  isDepositAddressTaken,
  isOrderTaken,
  orderReused,
  quoteIdReused,
  release,
  writeHeld,
  type SwapLease,
  type SwapRequest,
  type SwapRow,
} from './store';

const BODY_MAX = 8_000;
export const SOLANA = 792703809;
const PROVIDER_NAME = /^[a-z0-9-]{1,32}$/i;

export type SwapInput = {
  originChainId: number;
  originToken: Address;
  destinationChainId: number;
  destinationToken: string;
  amount: string;
  recipient?: string;
};

export type QuoteStep = { kind: 'done'; row: SwapRow } | { kind: 'lease_lost' };

export type QuoteDeps = { fetch: typeof fetch; apiKey: string; timeoutMs: number };

const liveDeps = (): QuoteDeps => ({
  fetch: safeFetch(config().insecureFetchHosts),
  apiKey: config().swapApiKey ?? '',
  timeoutMs: 15_000,
});

const lowerHex = (value: string) => (/^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value);

export function swapRequest(t: Tenant, input: SwapInput): SwapRequest {
  return {
    originChainId: input.originChainId,
    originToken: lowerHex(input.originToken),
    destinationChainId: input.destinationChainId,
    destinationToken: lowerHex(input.destinationToken),
    amount: input.amount,
    depositor: lowerHex(t.account),
    recipient: lowerHex(input.recipient ?? t.account),
  };
}

function providersFor(request: QuoteRequest): string {
  const enabled = config().swapProviders;
  if (sameAsset(request)) return [...enabled].join(',');
  return enabled.has('aurora') ? 'aurora' : '';
}

function quoteUrl(row: SwapRow, providers: string): string {
  const query = new URLSearchParams({
    originChainId: String(row.originChainId),
    destinationChainId: String(row.destinationChainId),
    originToken: row.originToken,
    destinationToken: row.destinationToken,
    amount: row.amount,
    depositor: row.depositor,
    recipient: row.recipient,
    tradeType: 'EXACT_INPUT',
  });
  const route = row.destinationChainId === SOLANA ? 'swap/quote' : 'move-asset/quote';
  if (route === 'move-asset/quote') query.set('providers', providers);
  return `${config().swapUrl}/${route}?${query}`;
}

type Answer = { kind: 'answered'; status: number; body: string; scrubbed: string } | { kind: 'unreachable' };

async function ask(url: string, deps: QuoteDeps): Promise<Answer> {
  try {
    const res = await deps.fetch(url, {
      headers: { 'x-api-key': deps.apiKey },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const body = await res.text();
    const scrubbed = deps.apiKey ? body.split(deps.apiKey).join('[key]') : body;
    return { kind: 'answered', status: res.status, body, scrubbed };
  } catch (err) {
    log('warn', { msg: 'swap quote unreachable', error: errorLabel(err) });
    return { kind: 'unreachable' };
  }
}

export async function quote(t: Tenant, held: { row: SwapRow; token: string }, deps = liveDeps()): Promise<QuoteStep> {
  if (held.row.quoteId) return { kind: 'done', row: held.row };
  const lease = { connectionId: t.connectionId, id: held.row.id, token: held.token };
  const request = quoteRequestOf(held.row);
  if (!request) return stepOf(await writeHeld(lease, { state: 'quote_failed', code: 'invalid_request' }));
  const providers = providersFor(request);
  if (!providers) {
    return stepOf(await writeHeld(lease, { state: 'quote_rejected', code: 'quote_unsupported_provider' }));
  }
  const url = quoteUrl(held.row, providers);
  if (refusal(new URL(url), config().insecureFetchHosts)) {
    return stepOf(await writeHeld(lease, { state: 'quote_failed', code: 'insecure_url' }));
  }
  // The backend's quote lives from when it was asked, so the owner window counts from here.
  const askedAt = new Date();
  const answer = await ask(url, deps);
  const row = await conclude(lease, request, url, askedAt, answer);
  if (row?.code === 'quote_unsupported_provider') {
    log('warn', {
      msg: 'swap quote from an unsupported provider',
      provider: (row.quote as { provider: string }).provider,
      originChainId: row.originChainId,
      destinationChainId: row.destinationChainId,
    });
  }
  return stepOf(row);
}

const stepOf = (row: SwapRow | undefined): QuoteStep => (row ? { kind: 'done', row } : { kind: 'lease_lost' });

export function quoteRequestOf(row: SwapRow): QuoteRequest | undefined {
  if (!isAddress(row.originToken, { strict: false }) || !isAddress(row.depositor, { strict: false })) return undefined;
  return {
    originChainId: row.originChainId,
    originToken: getAddress(row.originToken),
    amount: row.amount,
    account: getAddress(row.depositor),
    destinationChainId: row.destinationChainId,
    destinationToken: row.destinationToken,
    recipient: row.recipient,
  };
}

// A key the backend does not take is this server's setting, not the caller's input, so the
// swap stays quoting and the same key quotes once the setting is fixed.
const KEY_REFUSED = new Set([401, 402, 403]);

const ALLOWLIST_DRIFT: ReadonlySet<CheckCode> = new Set(['solver_unknown', 'router_mismatch']);

async function conclude(lease: SwapLease, request: QuoteRequest, url: string, askedAt: Date, answer: Answer) {
  if (answer.kind === 'unreachable') return release(lease, { code: 'backend_unavailable' });
  const { status, body, scrubbed } = answer;
  const fenced = scrubbed ? fenceText(new URL(url).host, scrubbed, BODY_MAX) : null;
  if (status === 200) return keepQuote(lease, request, askedAt, body, fenced);
  if (KEY_REFUSED.has(status)) {
    log('error', { msg: 'swap backend refused the swap api key', status });
    return release(lease, { code: 'backend_unavailable' });
  }
  if (status >= 500) return release(lease, { code: 'backend_unavailable' });
  const code = status >= 400 ? 'quote_unavailable' : 'quote_invalid';
  return writeHeld(lease, { state: 'quote_failed', code, quoteFenced: fenced });
}

async function keepQuote(
  lease: SwapLease,
  request: QuoteRequest,
  askedAt: Date,
  body: string,
  fenced: string | null
): Promise<SwapRow | undefined> {
  const data = dataOf(body);
  const provider = disabledProvider(data);
  if (provider) {
    return writeHeld(lease, { state: 'quote_rejected', code: 'quote_unsupported_provider', quote: { provider } });
  }
  const checked = await checkQuote(request, data, {
    isDepositAddressTaken,
    isOrderTaken,
    now: () => Math.floor(Date.now() / 1000),
    ownerWindowSec: ownerWindowMs(config().swapQuoteTtlSec) / 1000,
  });
  if (!checked.ok) {
    if (ALLOWLIST_DRIFT.has(checked.code)) {
      log('warn', {
        msg: 'swap quote refused on allowlist drift',
        provider: (data as { provider: string }).provider,
        originChainId: request.originChainId,
        destinationChainId: request.destinationChainId,
        code: checked.code,
      });
    }
    const state = checked.code === 'quote_invalid' ? 'quote_failed' : 'quote_rejected';
    const { provider, offered, floor } = checked;
    const shown = checked.code === 'route_unsupported' || checked.code === 'output_floor';
    return writeHeld(lease, {
      state,
      code: checked.code,
      quote: shown ? { provider, offered, floor } : undefined,
      quoteFenced: fenced,
    });
  }
  try {
    return await writeHeld(lease, {
      code: null,
      quotedAt: askedAt,
      quoteId: checked.quoteId,
      depositAddress: checked.depositAddress,
      quote: checked.quote,
      call: checked.calls,
      quoteFenced: fenced,
    });
  } catch (err) {
    if (checked.quote.provider !== 'aurora' && quoteIdReused(err)) {
      return writeHeld(lease, { state: 'quote_rejected', code: 'quote_reused', quoteFenced: fenced });
    }
    if (depositAddressReused(err)) {
      return writeHeld(lease, { state: 'quote_rejected', code: 'deposit_address_reused', quoteFenced: fenced });
    }
    if (orderReused(err)) {
      return writeHeld(lease, { state: 'quote_rejected', code: 'order_reused', quoteFenced: fenced });
    }
    throw err;
  }
}

function disabledProvider(data: unknown): string | undefined {
  const { provider, quoteId } = (data ?? {}) as { provider?: unknown; quoteId?: unknown };
  if (typeof provider !== 'string') return undefined;
  const prefix = typeof quoteId === 'string' && quoteId.includes(':') ? quoteId.split(':')[0] : '';
  const enabled = (name: string) => (config().swapProviders as ReadonlySet<string>).has(name);
  if (enabled(provider) && enabled(prefix)) return undefined;
  return [prefix, provider].find((name) => !enabled(name) && PROVIDER_NAME.test(name)) ?? 'unknown';
}

function dataOf(raw: string): unknown {
  try {
    return JSON.parse(raw)?.result?.data;
  } catch {
    return undefined;
  }
}
