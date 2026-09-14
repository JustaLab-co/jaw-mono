import { createPublicClient, http, erc20Abi, formatUnits, type Chain, type PublicClient } from 'viem';
import { base, baseSepolia, polygon } from 'viem/chains';
import { usdcForNetwork, type UsdcAsset, type UsdcChainId } from './asset-registry.js';
import { loadConfig } from '../lib/config.js';

// The JAW proxy RPC endpoint, mirrored from core's JAW_RPC_URL. Kept as a local
// literal rather than an import because `@jaw.id/core` is lazy-loaded in the CLI
// (a static import would pull it into startup); keep in sync if core's URL moves.
const JAW_RPC_URL = 'https://api.justaname.id/proxy/v1/rpc';

// Keyed on the registry's own chain ids, so this map and USDC_BY_NETWORK cannot
// drift: a registry entry with no viem chain here fails to compile, and a viem
// chain the registry does not carry fails the same way. A loop throwing at
// import time catches only the first of those two, and only once the process is
// already running.
const CHAINS: Record<UsdcChainId, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [polygon.id]: polygon,
};

// One client per (chain, apiKey) across the process — a fresh transport per read
// is wasted setup once balance checks run more than once per payment. Keying on
// the apiKey too matters for the long-lived `jaw mcp` server: a first read before
// a key is configured would otherwise cache the public-RPC client forever, so a
// later `jaw config set apiKey` (or a key change) never takes effect. A new key
// yields a new cache entry and a keyed transport; the stale entry just goes cold.
const clients = new Map<string, PublicClient>();

/**
 * Every read through this transport runs inside the payment lock, so one that
 * hangs wedges every payment on the machine and not just its own. viem's
 * defaults are 10s per request across four attempts, roughly 41s before a read
 * gives up, and a payment makes at least four of them: the Permit2 allowance,
 * the payer balance, the delegation probe and the account's EIP-712 domain.
 *
 * The rest of this path is bounded on purpose too (`FETCH_TIMEOUT_MS` in http.ts,
 * the race in `awaitCall`). These reads were the ones left out of that rule.
 */

/**
 * Per attempt, not per read: `RPC_RETRY_COUNT` attempts of this each.
 *
 * The same 5000 appears as `DEFAULT_TIMEOUT_MS` in `permission-onchain.ts`, which
 * bounds a whole read including its retries through `within()`. The two are
 * complementary and the shared number is a coincidence, not one knob: a transport
 * timeout cannot stop three attempts from adding up, which is what `within()` is
 * there for. `permission-onchain.ts` reads through this transport too, so it has
 * both, and neither is redundant.
 */
const RPC_TIMEOUT_MS = 5_000;
const RPC_RETRY_COUNT = 2;

/**
 * Route reads through the same JAW proxy core uses, so the x402 modules see the
 * same node/state core does and don't depend on viem's public RPC fallback
 * (rate-limited and flaky). This matters for the delegation probe in payer.ts:
 * a dropped getCode there would sign a raw signature where a wrapped one was
 * needed. Falls back to the public RPC when no apiKey is configured (e.g. tests).
 */
function rpcTransport(chainId: number, apiKey?: string) {
  const options = { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT };
  if (!apiKey) return http(undefined, options);
  return http(`${JAW_RPC_URL}?chainId=${chainId}&api-key=${apiKey}`, options);
}

/** Shared per-(chain, apiKey) public client for the x402 modules (reads only). */
export function publicClientFor(chainId: number): PublicClient {
  // Widened because a caller may hold any chain id: `permission-onchain.ts` reads
  // for whatever chain the session was made on, which is a number off a config
  // file. The throw below is what narrows it.
  const chain = (CHAINS as Record<number, Chain | undefined>)[chainId];
  if (!chain) throw new Error(`x402: no viem chain configured for chainId ${chainId}`);
  const apiKey = loadConfig().apiKey;
  const key = `${chainId}:${apiKey ?? ''}`;
  let client = clients.get(key);
  if (!client) {
    client = createPublicClient({ chain, transport: rpcTransport(chainId, apiKey) });
    clients.set(key, client);
  }
  return client;
}

/** Reads the raw USDC balance (base units) of `owner`. Injectable for tests. */
export type BalanceReader = (asset: UsdcAsset, owner: `0x${string}`) => Promise<bigint>;

const readOnChain: BalanceReader = (asset, owner) =>
  publicClientFor(asset.chainId).readContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });

export interface UsdcBalance {
  network: string;
  asset: `0x${string}`;
  /** Base units, decimal string. */
  raw: string;
  /** Human-readable amount, formatted with the asset's decimals from the registry. */
  formatted: string;
}

/**
 * Read an address's USDC balance on a CAIP-2 network so an agent can tell
 * whether it can afford a payment (or confirm one landed).
 */
export async function usdcBalance(
  network: string,
  owner: `0x${string}`,
  read: BalanceReader = readOnChain
): Promise<UsdcBalance> {
  const asset = usdcForNetwork(network);
  if (!asset) throw new Error(`Unsupported x402 network: ${network}`);
  const raw = await read(asset, owner);
  return { network, asset: asset.address, raw: raw.toString(), formatted: formatUnits(raw, asset.decimals) };
}
