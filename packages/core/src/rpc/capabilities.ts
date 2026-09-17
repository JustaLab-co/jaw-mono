import { type Address } from 'viem';
import type { RequestArguments } from '../provider/index.js';
import { JAW_RPC_URL } from '../constants.js';
import { buildHandleJawRpcUrl, fetchRPCRequest, hexStringFromNumber } from '../utils/index.js';
import { MAINNET_CHAINS } from '../account/smartAccount.js';
import { store } from '../store/index.js';

/**
 * Chain metadata capability returned by wallet_getCapabilities
 * Contains chain-specific information including the icon as a data URI
 */
export interface ChainMetadataCapability {
    /** Chain icon as a data URI (e.g., data:image/svg+xml;base64,...) */
    icon?: string;
}

export type CapabilitiesResult = Record<`0x${string}`, Record<string, unknown>>;

/**
 * How long a capabilities response stays fresh.
 *
 * The payload — supported chains, their fee tokens and metadata — changes only when
 * the proxy's configuration does, but every transaction/permission dialog fetches it
 * on mount and nothing renders a fee row until it lands. A minute keeps repeated
 * dialog opens free while still picking up a server-side change within one.
 */
const CAPABILITIES_TTL_MS = 60_000;

/**
 * How long a failed lookup keeps the next caller from repeating it.
 *
 * Short, because most failures here are transient and pinning one for a minute would
 * leave a dialog without its fee row for that long. Not zero, because the keyless
 * path fails persistently when the origin is not registered: the icon hook asks per
 * chain, so a chain picker re-fires one refused request per chain on every mount.
 */
const CAPABILITIES_FAILURE_TTL_MS = 30_000;

const capabilitiesCache = new Map<string, { at: number; value: CapabilitiesResult }>();
const capabilitiesFailures = new Map<string, { at: number; error: unknown }>();
/** Requests in flight, so concurrent callers share one fetch instead of racing duplicates. */
const capabilitiesInflight = new Map<string, Promise<CapabilitiesResult>>();

/** Drop every cached capabilities response. Exposed for tests and for callers that need a forced refresh. */
export function clearCapabilitiesCache(): void {
    capabilitiesCache.clear();
    capabilitiesFailures.clear();
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
 * A failure is held for `CAPABILITIES_FAILURE_TTL_MS` and rethrown, so a persistent
 * refusal is asked about once per window instead of once per mount. Every caller gets
 * its own copy of the response.
 *
 * @param request - The wallet_getCapabilities request
 * @param apiKey - API key for authentication, if the caller has one
 * @param showTestnets - Whether to include testnet chains (default: false)
 * @returns Capabilities for all or filtered chains
 */
export async function handleGetCapabilitiesRequest(
    request: RequestArguments,
    apiKey: string | undefined,
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
    // The dApp is part of the key: with no api-key the proxy answers on the origin
    // we name instead, so two of them would otherwise share the keyless entry.
    // A caller with no key reaches this as '' from keys and as undefined from the
    // SDK, and both mean the same request, so they share one entry.
    const cacheKey = `${apiKey ?? ''}|${store.config.get().dappOrigin ?? ''}|${JSON.stringify(requestArgs.params ?? [])}`;

    // Every exit hands back a copy, never the cache entry itself. `JAWProvider` forwards
    // this result straight to the dApp, and the internal UI call sites all key on the same
    // `params: []` entry — so a single mutation by any one caller would otherwise be visible
    // to every later one, including the fee-token selector.
    const cached = capabilitiesCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CAPABILITIES_TTL_MS) {
        return structuredClone(cached.value);
    }

    const failed = capabilitiesFailures.get(cacheKey);
    if (failed && Date.now() - failed.at < CAPABILITIES_FAILURE_TTL_MS) throw failed.error;

    const inflight = capabilitiesInflight.get(cacheKey);
    if (inflight) return structuredClone(await inflight);

    const pending = (async () => {
        try {
            const result = (await fetchRPCRequest(requestArgs, rpcUrl)) as CapabilitiesResult;
            capabilitiesCache.set(cacheKey, { at: Date.now(), value: result });
            capabilitiesFailures.delete(cacheKey);
            return result;
        } catch (error) {
            // The rejection propagates to every sharer, and the next caller within the
            // window gets it back without a second request.
            capabilitiesFailures.set(cacheKey, { at: Date.now(), error });
            throw error;
        }
    })();

    capabilitiesInflight.set(cacheKey, pending);
    try {
        return structuredClone(await pending);
    } finally {
        capabilitiesInflight.delete(cacheKey);
    }
}
