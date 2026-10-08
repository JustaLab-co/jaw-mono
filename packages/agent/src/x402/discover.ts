// Client for the Coinbase x402 Bazaar discovery service — the public catalog of
// x402-payable endpoints. Read-only: this finds services an agent could pay,
// it never pays. Paying a discovered `url` goes back through payAndFetch so the
// on-chain caps and policy still apply.
//
// The Bazaar API is unauthenticated for reads. Everything it returns
// (serviceName, description, tags) is third-party seller copy and therefore
// UNTRUSTED — the MCP layer fences it before handing it to the agent.

import { usdcForNetwork } from './asset-registry.js';
import { isX402Scheme } from './types.js';

const BAZAAR_BASE = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery';
// Coinbase's own docs cap search at 20 results per call.
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;
const DEFAULT_NETWORK = 'eip155:8453';
// The discovery API is a well-behaved HTTPS service, but Node's fetch has no
// default timeout, so bound it like every other network call in this package.
const DISCOVER_TIMEOUT_MS = 15_000;
// Cap the response we buffer. A discovery payload is tiny (at most 20 small
// entries), but the bytes are still untrusted: without a cap a misbehaving or
// compromised endpoint could stream gigabytes and OOM the agent. Mirrors the
// MAX_BODY_BYTES guard in http.ts.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export interface DiscoverParams {
  /** Free-text/keyword search over the catalog. Required unless `payTo` is set. */
  query?: string;
  /** CAIP-2 network to prefer when picking the price to show. */
  network?: string;
  /**
   * Only surface services at or below this USD price per call, judged on the
   * option we would actually pay: a `upto` service is measured by its ceiling,
   * since that is what a payment authorizes and what the spend caps count.
   *
   * Asked of the Bazaar and then applied again here, because the two do not
   * necessarily agree. The catalog filters on whichever of a service's options
   * matched, and we go on to select a different one, the cheapest on the
   * preferred network. An entry priced in an asset we cannot value is kept:
   * there is no figure to compare, and dropping it would hide a service for
   * being unfamiliar rather than for being expensive.
   */
  maxUsdPrice?: string;
  /** Only Coinbase-curated (health-probed) services. */
  curatedOnly?: boolean;
  /** Max results, 1..20. */
  limit?: number;
  /** Merchant mode: list every service registered by this seller address. */
  payTo?: string;
}

/** The cheapest payment option for a service, resolved for the caller. */
export interface ServicePrice {
  amount: string;
  /**
   * What `amount` and `approxUsd` are.
   *
   * `price` means that is what a call costs. `ceiling` means the server may
   * charge anything up to it and picks the figure after the work is done, so it
   * is an upper bound and not an estimate. Spelled out rather than left for the
   * reader to derive from `scheme`, because a catalog is read to compare
   * numbers and these two are not the same kind of number.
   */
  kind: 'price' | 'ceiling';
  asset: string;
  network: string;
  payTo: string | null;
  scheme: string | null;
  maxTimeoutSeconds: number | null;
  /** amount / 10^decimals when the asset is known USDC, else null. */
  approxUsd: number | null;
}

/** One catalog entry, mapped to what an agent needs to decide and then pay. */
export interface DiscoveredService {
  /** Seller-declared name. Null when the service was indexed without one. */
  name: string | null;
  /** The resource URL to pass to jaw_pay_and_fetch. */
  url: string;
  description: string | null;
  tags: string[] | null;
  /** Cheapest option matching the preferred network, else cheapest overall. */
  price: ServicePrice | null;
  /** How to call the resource, as advertised (method + params example). */
  howToCall: unknown;
  /** Index signals — Coinbase-computed, unauditable, informational only. */
  trust: {
    curated: boolean | null;
    calls30d: number | null;
    payers30d: number | null;
    lastCalledAt: string | null;
  };
  x402Version: number | null;
}

export interface DiscoverResult {
  mode: 'search' | 'merchant';
  count: number;
  /** Bazaar signalled the result set was truncated — narrow the query. */
  partialResults: boolean;
  /** How the Bazaar matched (hybrid/vector/text); absent in merchant mode. */
  searchMethod?: string;
  services: DiscoveredService[];
}

// Defensive readers: the response is untrusted remote JSON, so narrow every
// field by runtime type instead of trusting a shape.
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toPrice(entry: Record<string, unknown>): ServicePrice | null {
  const amount = asString(entry.amount);
  const network = asString(entry.network);
  const asset = asString(entry.asset);
  if (amount === null || !/^\d+$/.test(amount) || network === null || asset === null) return null;

  const usdc = usdcForNetwork(network);
  let approxUsd: number | null = null;
  if (usdc && usdc.address.toLowerCase() === asset.toLowerCase()) {
    // amount passed /^\d+$/, so BigInt can't throw; guard the Number() cast so a
    // pathologically huge amount degrades to null instead of Infinity.
    const n = Number(BigInt(amount)) / 10 ** usdc.decimals;
    approxUsd = Number.isFinite(n) ? n : null;
  }

  const scheme = asString(entry.scheme);
  // An option we cannot sign is not a price, it is a distraction. Left in, a
  // catalog entry priced in a scheme this client refuses would be listed as the
  // cheap one, chosen on that basis, and then paid through whatever other
  // option the challenge offered, which is usually the expensive one.
  if (!isX402Scheme(scheme)) return null;
  return {
    amount,
    kind: scheme === 'upto' ? 'ceiling' : 'price',
    asset,
    network,
    payTo: asString(entry.payTo),
    scheme,
    maxTimeoutSeconds: asNumber(entry.maxTimeoutSeconds),
    approxUsd,
  };
}

// Pick the cheapest option, preferring the caller's network. A multi-option
// service can't steer the agent onto a pricier chain, mirroring how the pay
// loop selects the cheapest acceptable requirement.
function selectPrice(accepts: unknown[], preferNetwork: string): ServicePrice | null {
  const prices = accepts.map((a) => toPrice(asRecord(a))).filter((p): p is ServicePrice => p !== null);
  if (prices.length === 0) return null;
  const matching = prices.filter((p) => p.network === preferNetwork);
  const pool = matching.length > 0 ? matching : prices;
  // Smallest figure wins, and a tie goes to the fixed price. The same rule the
  // payment path applies when a challenge offers both: equal numbers mean
  // different things, and the one that cannot grow is the safer thing to show.
  return pool.reduce((min, p) => {
    const cheaper = BigInt(p.amount) < BigInt(min.amount);
    const fixedPriceTie = BigInt(p.amount) === BigInt(min.amount) && min.kind === 'ceiling' && p.kind === 'price';
    return cheaper || fixedPriceTie ? p : min;
  });
}

function mapService(raw: unknown, preferNetwork: string): DiscoveredService {
  const r = asRecord(raw);
  const info = asRecord(asRecord(asRecord(r.extensions).bazaar).info);
  const quality = asRecord(r.quality);
  const tags = asArray(r.tags).filter((t): t is string => typeof t === 'string');

  return {
    name: asString(r.serviceName),
    url: asString(r.resource) ?? '',
    description: asString(r.description),
    tags: tags.length > 0 ? tags : null,
    price: selectPrice(asArray(r.accepts), preferNetwork),
    howToCall: info.input,
    trust: {
      curated: asBool(r.curated),
      calls30d: asNumber(quality.l30DaysTotalCalls),
      payers30d: asNumber(quality.l30DaysUniquePayers),
      lastCalledAt: asString(quality.lastCalledAt),
    },
    x402Version: asNumber(r.x402Version),
  };
}

// Buffer the response with a hard size cap, then parse. Prefers the byte stream
// (bounded as it arrives) and falls back to text() when there is no stream.
async function readCappedJson(res: Response): Promise<Record<string, unknown>> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('x402 Bazaar response exceeded the size cap');
    return asRecord(JSON.parse(text));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('x402 Bazaar response exceeded the size cap');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return asRecord(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
}

async function bazaarGet(path: string, search: URLSearchParams): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const res = await fetch(`${BAZAAR_BASE}/${path}?${search.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`x402 Bazaar discovery returned HTTP ${res.status}`);
    }
    return await readCappedJson(res);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the caller's price cap, or refuse it.
 *
 * It arrives as free text a model wrote, and both ways of getting it wrong fail
 * quietly in opposite directions. `Number('')` is zero, a finite cap that
 * filters away everything, and an empty string is also falsy where the query is
 * built, so the Bazaar never sees it and the caller gets an empty page with no
 * reason attached. `"$0.01"` is NaN, which disables the filter while the caller
 * believes a cap is being enforced. Neither is something to guess at, so a cap
 * that is not a plain non-negative number is an error rather than an
 * interpretation.
 */
function parseUsdCap(maxUsdPrice?: string): number | undefined {
  if (maxUsdPrice === undefined) return undefined;
  const cap = Number(maxUsdPrice);
  if (maxUsdPrice.trim() === '' || !Number.isFinite(cap) || cap < 0) {
    throw new Error(`maxUsdPrice must be a non-negative number of USD, got ${JSON.stringify(maxUsdPrice)}`);
  }
  return cap;
}

/**
 * Drop what we would not pay, judged on the option we would actually pay.
 *
 * The Bazaar filters on whichever option matched its query, and `selectPrice`
 * then picks the cheapest on the preferred network, which need not be the same
 * one. Without this a caller asking for a cent per call can be handed a service
 * whose selected option authorizes several dollars. Entries with no valuable
 * asset are kept: there is nothing to compare them against, and hiding them
 * would be hiding the unfamiliar rather than the expensive.
 */
function withinCap(services: DiscoveredService[], cap?: number): DiscoveredService[] {
  if (cap === undefined) return services;
  return services.filter((s) => s.price?.approxUsd == null || s.price.approxUsd <= cap);
}

/**
 * Search the x402 Bazaar (or, with `payTo`, list one seller's services).
 * Returns a compact, mapped view; the raw seller-authored strings inside it are
 * untrusted and must be fenced before reaching the model.
 */
export async function discoverServices(params: DiscoverParams): Promise<DiscoverResult> {
  const network = params.network ?? DEFAULT_NETWORK;

  const cap = parseUsdCap(params.maxUsdPrice);

  if (params.payTo) {
    const data = await bazaarGet('merchant', new URLSearchParams({ payTo: params.payTo }));
    // The merchant endpoint takes no price filter, so this is the only place it
    // gets applied for a seller listing.
    const services = withinCap(
      asArray(data.resources).map((r) => mapService(r, network)),
      cap
    );
    return { mode: 'merchant', count: services.length, partialResults: false, services };
  }

  const search = new URLSearchParams();
  if (params.query) search.set('query', params.query);
  search.set('network', network);
  if (params.maxUsdPrice) search.set('maxUsdPrice', params.maxUsdPrice);
  if (params.curatedOnly) search.set('curatedOnly', 'true');
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  search.set('limit', String(limit));

  const data = await bazaarGet('search', search);
  const services = withinCap(
    asArray(data.resources).map((r) => mapService(r, network)),
    cap
  );
  return {
    mode: 'search',
    count: services.length,
    partialResults: asBool(data.partialResults) ?? false,
    searchMethod: asString(data.searchMethod) ?? undefined,
    services,
  };
}
