import { balanceReader, chainClients, usdcBalance as readUsdcBalance, type ChainClients } from '@jaw.id/agent';
import { loadConfig } from '../lib/config.js';
import { apiKeyFor } from '../lib/api-key.js';

/**
 * Chain reads on the key the config holds right now. Resolved on every call so
 * the long-lived `jaw mcp` server picks up a key set after its first read.
 */
export const cliChainClients: ChainClients = {
  publicClient: (chainId) => chainClients(apiKeyFor(loadConfig())).publicClient(chainId),
};

export const usdcBalance = (network: string, owner: `0x${string}`) =>
  readUsdcBalance(network, owner, balanceReader(cliChainClients));

export const usdcBaseUnits = async (network: string, owner: `0x${string}`) =>
  BigInt((await usdcBalance(network, owner)).raw);
