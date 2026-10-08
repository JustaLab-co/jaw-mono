import type { PublicClient } from 'viem';
import { balanceReader, chainClients, usdcBalance as readUsdcBalance, type ChainClients } from '@jaw.id/agent';
import { loadConfig } from '../lib/config.js';
import { apiKeyFor } from '../lib/api-key.js';

// One client per (chain, apiKey) across the process — a fresh transport per read
// is wasted setup once balance checks run more than once per payment. Keying on
// the apiKey too matters for the long-lived `jaw mcp` server: a first read before
// a key is configured would otherwise cache the public-RPC client forever, so a
// later `jaw config set apiKey` (or a key change) never takes effect. A new key
// yields a new cache entry and a keyed transport; the stale entry just goes cold.
const clients = new Map<string, PublicClient>();

/** Chain reads on the key the config holds right now, resolved on every call. */
export const cliChainClients: ChainClients = {
  publicClient(chainId) {
    const apiKey = apiKeyFor(loadConfig());
    const key = `${chainId}:${apiKey ?? ''}`;
    let client = clients.get(key);
    if (!client) {
      client = chainClients(apiKey).publicClient(chainId);
      clients.set(key, client);
    }
    return client;
  },
};

export const usdcBalance = (network: string, owner: `0x${string}`) =>
  readUsdcBalance(network, owner, balanceReader(cliChainClients));

export const usdcBaseUnits = async (network: string, owner: `0x${string}`) =>
  BigInt((await usdcBalance(network, owner)).raw);
