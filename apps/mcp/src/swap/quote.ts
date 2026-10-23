import type { Address } from 'viem';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { errorLabel, log } from '@/lib/edge';
import { fenceText } from '@/lib/fence';
import { refusal, safeFetch } from '@/lib/safe-fetch';
import { checkQuote, type QuoteRequest } from './check';
import { quoteReused, release, writeHeld, type SwapLease, type SwapRequest, type SwapRow } from './store';

const BODY_MAX = 8_000;

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

function quoteUrl(row: SwapRow): string {
  const query = new URLSearchParams({
    originChainId: String(row.originChainId),
    destinationChainId: String(row.destinationChainId),
    originToken: row.originToken,
    destinationToken: row.destinationToken,
    amount: row.amount,
    depositor: row.depositor,
    recipient: row.recipient,
    tradeType: 'EXACT_INPUT',
    providers: 'across,relay',
  });
  return `${config().swapUrl}/move-asset/quote?${query}`;
}

type Answer = { kind: 'answered'; status: number; body: string } | { kind: 'unreachable' };

async function ask(url: string, deps: QuoteDeps): Promise<Answer> {
  try {
    const res = await deps.fetch(url, {
      headers: { 'x-api-key': deps.apiKey },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    return { kind: 'answered', status: res.status, body: await res.text() };
  } catch (err) {
    log('warn', { msg: 'swap quote unreachable', error: errorLabel(err) });
    return { kind: 'unreachable' };
  }
}

export async function quote(t: Tenant, held: { row: SwapRow; token: string }, deps = liveDeps()): Promise<QuoteStep> {
  if (held.row.quoteId) return { kind: 'done', row: held.row };
  const lease = { connectionId: t.connectionId, id: held.row.id, token: held.token };
  const url = quoteUrl(held.row);
  if (refusal(new URL(url), config().insecureFetchHosts)) {
    return stepOf(await writeHeld(lease, { state: 'quote_failed', code: 'insecure_url' }));
  }
  // The backend's quote lives from when it was asked, so the owner window counts from here.
  const askedAt = new Date();
  const answer = await ask(url, deps);
  return stepOf(await conclude(lease, held.row, url, askedAt, answer));
}

const stepOf = (row: SwapRow | undefined): QuoteStep => (row ? { kind: 'done', row } : { kind: 'lease_lost' });

// A key the backend does not take is this server's setting, not the caller's input, so the
// swap stays quoting and the same key quotes once the setting is fixed.
const KEY_REFUSED = new Set([401, 402, 403]);

async function conclude(lease: SwapLease, request: QuoteRequest, url: string, askedAt: Date, answer: Answer) {
  if (answer.kind === 'unreachable') return release(lease, { code: 'backend_unavailable' });
  const { status, body } = answer;
  const fenced = body ? fenceText(new URL(url).host, body, BODY_MAX) : null;
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
  const checked = checkQuote(request, dataOf(body));
  if (!checked.ok) {
    const state = checked.code === 'quote_invalid' ? 'quote_failed' : 'quote_rejected';
    return writeHeld(lease, { state, code: checked.code, quoteFenced: fenced });
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
    if (!quoteReused(err)) throw err;
    return writeHeld(lease, { state: 'quote_rejected', code: 'quote_reused', quoteFenced: fenced });
  }
}

function dataOf(raw: string): unknown {
  try {
    return JSON.parse(raw)?.result?.data;
  } catch {
    return undefined;
  }
}
