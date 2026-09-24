import { createPublicClient } from 'viem';
import { mainnet } from 'viem/chains';

import { rpcTransport } from './publicClient';

const CHAIN_RESOLVER_ADDRESS = '0x2a9B5787207863cf2d63d20172ed1F7bB2c9487A' as const;

const CHAIN_LABEL_ABI = [
  {
    name: 'chainLabel',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '_interoperableAddress', type: 'bytes' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

const STORAGE_KEY = 'interop_chain_labels';

const memoryCache = new Map<number, string | null>();

let storageLoaded = false;

function loadFromStorage(): void {
  if (storageLoaded) return;
  storageLoaded = true;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const entries: Record<string, string> = JSON.parse(stored);
    for (const [chainId, label] of Object.entries(entries)) {
      memoryCache.set(Number(chainId), label || null);
    }
  } catch {
    // localStorage unavailable or corrupt — continue without cache
  }
}

function saveToStorage(chainId: number, label: string | null): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const entries: Record<string, string> = stored ? JSON.parse(stored) : {};
    if (label) {
      entries[chainId.toString()] = label;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable — memory cache still works
  }
}

function encodeChainBinary(chainId: number): `0x${string}` {
  const version = [0x00, 0x01];
  const chainType = [0x00, 0x00]; // eip155

  let hex = chainId.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const chainRefBytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    chainRefBytes.push(parseInt(hex.slice(i, i + 2), 16));
  }

  const chainRefLen = [chainRefBytes.length];
  const addrLen = [0x00];

  const bytes = [...version, ...chainType, ...chainRefLen, ...chainRefBytes, ...addrLen];
  return ('0x' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

// In-flight promises to avoid duplicate queries for the same chainId
const pendingQueries = new Map<number, Promise<string | null>>();

/**
 * Resolves a chainId to its human-readable interop label (e.g., 42161 → "arbitrum")
 * by querying the on.eth ChainResolver contract on Ethereum mainnet.
 *
 * Results are cached in localStorage (persistent) and memory (fast).
 * Returns null if the chain is not registered or the query fails.
 */
export async function getChainLabel(chainId: number, rpcUrl: string): Promise<string | null> {
  // 1. Memory cache
  if (memoryCache.has(chainId)) {
    return memoryCache.get(chainId) ?? null;
  }

  // 2. localStorage cache
  loadFromStorage();
  if (memoryCache.has(chainId)) {
    return memoryCache.get(chainId) ?? null;
  }

  // 3. Deduplicate in-flight queries
  if (pendingQueries.has(chainId)) {
    return pendingQueries.get(chainId)!;
  }

  const query = queryChainLabel(chainId, rpcUrl);
  pendingQueries.set(chainId, query);

  try {
    const result = await query;
    return result;
  } finally {
    pendingQueries.delete(chainId);
  }
}

async function queryChainLabel(chainId: number, rpcUrl: string): Promise<string | null> {
  try {
    const client = createPublicClient({
      chain: mainnet,
      transport: rpcTransport(rpcUrl),
    });

    const binary = encodeChainBinary(chainId);

    const label = await client.readContract({
      address: CHAIN_RESOLVER_ADDRESS,
      abi: CHAIN_LABEL_ABI,
      functionName: 'chainLabel',
      args: [binary],
    });

    const result = label && label.length > 0 ? label : null;

    memoryCache.set(chainId, result);
    saveToStorage(chainId, result);

    return result;
  } catch {
    // Query failed — cache null in memory only (retry on next page load)
    memoryCache.set(chainId, null);
    return null;
  }
}
