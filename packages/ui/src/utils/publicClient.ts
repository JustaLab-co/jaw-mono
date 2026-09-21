import { createPublicClient, http, type Chain } from 'viem';
import { JAW_RPC_URL, SUPPORTED_CHAINS } from '@jaw.id/core';

/** JAW RPC proxy URL for a chain, with the dApp's API key when one is available. */
export function jawRpcUrl(chainId: number, apiKey?: string): string {
  return apiKey ? `${JAW_RPC_URL}?chainId=${chainId}&api-key=${apiKey}` : `${JAW_RPC_URL}?chainId=${chainId}`;
}

// `chain` is widened to viem's base `Chain` on purpose: inferring it from the
// SUPPORTED_CHAINS union would give every client a 22-member chain type, and the
// resulting per-chain formatter unions make the client incompatible with actions
// typed against a plain client (simulateBlocks, readContract). The real chain
// object — formatters included — is still what gets passed at runtime.
function createClient(chainId: number, rpcUrl: string) {
  const chain: Chain | undefined = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  // `ccipRead: false`: an offchain lookup fetches urls a resolver names, and a `to`
  // in a call the user is about to sign chooses that resolver. A server follows those.
  return createPublicClient({ chain, transport: http(rpcUrl), batch: { multicall: true }, ccipRead: false });
}

const clientCache = new Map<string, ReturnType<typeof createClient>>();

/**
 * Cached public client for a chain.
 *
 * Clients are cached rather than built per call because `batch.multicall` folds
 * eth_calls into a single Multicall3 `aggregate3` only across calls issued on
 * the *same client instance* in the same tick — viem keys that scheduler by
 * `client.uid`. A fresh client per read (the previous shape of `tokenBalance`)
 * silently defeats it, so callers fanning out over N tokens must share one.
 *
 * `aggregate3` runs with `allowFailure`, so one reverting call still rejects
 * only its own caller, and every call in a group reads the same block.
 *
 * The accepted tradeoff is the other direction: a failure of the *aggregated
 * request itself* (node error, proxy 5xx) rejects every caller in the group
 * together, where unbatched only the failing call would have been lost. Viem's
 * batch scheduler rejects wholesale and its retries do not change that. For the
 * fee token list the visible effect is soft — the per-token catch in
 * `ReactUIHandler` renders every token at zero and unselectable — so it is
 * worth one shared request, but it is a real coupling, not a free one.
 *
 * That coupling crosses features, because the key below is (chainId, rpcUrl)
 * and `getJawPublicClient` resolves to the same URL the fee-token fan-out
 * builds: the balance reads and clear-signing's `createTokenResolver` share one
 * instance, and therefore one `aggregate3`. That is intended — it is what makes
 * a dialog open cost one round-trip — but it means those two fail together.
 *
 * The chain definition is pulled from `SUPPORTED_CHAINS` for its Multicall3
 * address. Chains viem has no address for fall back to one request per call —
 * viem swallows that lookup failure internally, so this is always safe to set.
 *
 * Deliberately not `http(url, { batch: true })`: viem's HTTP batch scheduler is
 * a module-global map keyed by URL, so it merges requests across unrelated
 * clients sharing an RPC URL and runs the whole batch under whichever client
 * opened the window — leaking one client's timeout and retry budget onto
 * another's calls.
 *
 * Throws on an empty `rpcUrl`. Attaching the chain definition costs us viem's own
 * guard: `http()` resolves `url || chain.rpcUrls.default.http[0]`, so an empty URL
 * that used to raise `UrlRequiredError` would instead silently route wallet traffic
 * to the chain's public node (mainnet.base.org and friends), bypassing the proxy.
 */
export function getPublicClient(chainId: number, rpcUrl: string) {
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for chain ${chainId}`);
  }

  const key = `${chainId}:${rpcUrl}`;
  const cached = clientCache.get(key);
  if (cached) return cached;

  const client = createClient(chainId, rpcUrl);
  clientCache.set(key, client);
  return client;
}

/**
 * Cached public client pointed at the JAW RPC proxy for a chain.
 *
 * Resolves to the *same instance* as `getPublicClient(chainId, jawRpcUrl(chainId, apiKey))`
 * — see the note there on what that shares.
 */
export function getJawPublicClient(chainId: number, apiKey?: string) {
  return getPublicClient(chainId, jawRpcUrl(chainId, apiKey));
}
