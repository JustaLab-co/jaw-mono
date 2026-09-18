import { type Address } from 'viem';
import type { RequestArguments } from '../provider/index.js';
import { JAW_RPC_URL } from '../constants.js';
import { buildHandleJawRpcUrl, fetchRPCRequest, hexStringFromNumber } from '../utils/index.js';
import { MAINNET_CHAINS } from '../account/smartAccount.js';
// Straight to the file rather than the store barrel: this needs one type, and
// `store/index.js` would pull the whole slice in to get it.
import type { FeeTokenCapability } from '../store/types.js';

/**
 * Chain metadata capability returned by wallet_getCapabilities
 * Contains chain-specific information including the icon as a data URI
 */
export interface ChainMetadataCapability {
    /** Chain icon as a data URI (e.g., data:image/svg+xml;base64,...) */
    icon?: string;
}

/**
 * What the proxy answers for one chain.
 *
 * The two capabilities we consume are declared; everything else stays open. The
 * proxy returns more than this models, and EIP-5792 requires a wallet to pass an
 * unknown capability through rather than break on it, so the index signature is
 * the contract and not a gap in it.
 *
 * Declared here rather than left to each caller: seven call sites were casting
 * the same two shapes out of `Record<string, unknown>` by hand, which is seven
 * copies of a type the package already exports.
 */
export interface ChainCapabilities {
    feeToken?: FeeTokenCapability;
    chainMetadata?: ChainMetadataCapability;
    [capability: string]: unknown;
}

export type CapabilitiesResult = Record<`0x${string}`, ChainCapabilities>;

/**
 * How long a capabilities response stays fresh.
 *
 * The payload — supported chains, their fee tokens and metadata — changes only when
 * the proxy's configuration does, but every transaction/permission dialog fetches it
 * on mount and nothing renders a fee row until it lands. A minute keeps repeated
 * dialog opens free while still picking up a server-side change within one.
 */
const CAPABILITIES_TTL_MS = 60_000;

const capabilitiesCache = new Map<string, { at: number; value: CapabilitiesResult }>();
/** Requests in flight, so concurrent callers share one fetch instead of racing duplicates. */
const capabilitiesInflight = new Map<string, Promise<CapabilitiesResult>>();

/** Drop every cached capabilities response. Exposed for tests and for callers that need a forced refresh. */
export function clearCapabilitiesCache(): void {
    capabilitiesCache.clear();
    capabilitiesInflight.clear();
}

/**
 * Handle wallet_getCapabilities request (EIP-5792)
 *
 * Returns the wallet's capabilities for all supported chains or filtered by chain IDs.
 * Fetches capabilities from the proxy service.
 *
 * If no chain filter is provided in params:
 * - If showTestnets is true: fetches capabilities for all chains
 * - If showTestnets is false: fetches capabilities only for mainnet chains
 *
 * Responses are memoized per (api key, effective params) for `CAPABILITIES_TTL_MS`,
 * and concurrent callers for the same key share a single request — the dialogs ask for
 * this on mount from several places at once, and it gates the fee-token chain.
 * Failures are never cached, and every caller gets its own copy of the response.
 *
 * @param request - The wallet_getCapabilities request
 * @param apiKey - API key for authentication
 * @param showTestnets - Whether to include testnet chains (default: false)
 * @returns Capabilities for all or filtered chains
 */
export async function handleGetCapabilitiesRequest(
    request: RequestArguments,
    apiKey: string,
    showTestnets = false
): Promise<CapabilitiesResult> {
    const rpcUrl = buildHandleJawRpcUrl(JAW_RPC_URL, apiKey);

    // EIP-5792 format: params[0] is account address, params[1] is optional array of chain IDs to filter by
    const params = request.params as [Address?, `0x${string}`[]?] | undefined;
    const filterChainIds = params?.[1];

    let requestArgs = request;

    // If no chain filter is provided, inject based on showTestnets preference
    if (!filterChainIds || filterChainIds.length === 0) {
        if (!showTestnets) {
            // Only request mainnet chains
            const chainFilter = MAINNET_CHAINS.map((chain) => hexStringFromNumber(chain.id));
            requestArgs = {
                ...request,
                params: [params?.[0], chainFilter],
            };
        }
        // If showTestnets is true, don't modify params - let proxy return all chains
    }

    // Key on the *effective* params, after the chain filter above is injected — two
    // callers that differ only in `showTestnets` resolve to different requests.
    const cacheKey = `${apiKey}|${JSON.stringify(requestArgs.params ?? [])}`;

    // Every exit hands back a copy, never the cache entry itself. `JAWProvider` forwards
    // this result straight to the dApp, and the internal UI call sites all key on the same
    // `params: []` entry — so a single mutation by any one caller would otherwise be visible
    // to every later one, including the fee-token selector.
    const cached = capabilitiesCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CAPABILITIES_TTL_MS) {
        return structuredClone(cached.value);
    }

    const inflight = capabilitiesInflight.get(cacheKey);
    if (inflight) return structuredClone(await inflight);

    const pending = (async () => {
        // The one unverified step. `ChainCapabilities` describes what the proxy
        // is expected to answer, and nothing here checks that it did; what
        // actually holds is the narrowing every consumer does before use
        // (`if (!feeTokenCap?.supported || !feeTokenCap?.tokens?.length)`). If a
        // runtime check is ever wanted, this is the single place for it.
        const result = (await fetchRPCRequest(requestArgs, rpcUrl)) as CapabilitiesResult;
        // Only a fulfilled response is cached; a rejection propagates to every sharer
        // and leaves the next caller free to retry.
        capabilitiesCache.set(cacheKey, { at: Date.now(), value: result });
        return result;
    })();

    capabilitiesInflight.set(cacheKey, pending);
    try {
        return structuredClone(await pending);
    } finally {
        capabilitiesInflight.delete(cacheKey);
    }
}
