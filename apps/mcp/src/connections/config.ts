import { base, baseSepolia, type Chain } from 'viem/chains';
import { parseKeyRing, type KeyRing } from './seal';

const CHAINS: Record<number, Chain> = { [base.id]: base, [baseSepolia.id]: baseSepolia };

export interface Config {
  issuer: string;
  /** The MCP endpoint: the only resource tokens are issued for. */
  resource: string;
  keysOrigin: string;
  chain: Chain;
  rpcUrl: string | undefined;
  /** Mainnet RPC for ENS; the chain's default public RPC when unset. */
  mainnetRpcUrl: string | undefined;
  /** Hosts agent-supplied URLs may reach without the https and public-address checks. Local verification only. */
  fetchAllowHosts: ReadonlySet<string>;
  ring: KeyRing;
}

let cached: Config | undefined;

/** Parsed once from the environment. A missing variable throws on first use. */
export function config(): Config {
  if (cached) return cached;
  const issuer = new URL(required('JAW_MCP_PUBLIC_URL')).origin;
  const chainId = Number(process.env.JAW_MCP_CHAIN_ID ?? baseSepolia.id);
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`JAW_MCP_CHAIN_ID ${chainId} is not supported`);
  cached = {
    issuer,
    resource: `${issuer}/mcp`,
    keysOrigin: new URL(required('JAW_KEYS_URL')).origin,
    chain,
    rpcUrl: process.env.JAW_MCP_RPC_URL || undefined,
    mainnetRpcUrl: process.env.JAW_MCP_MAINNET_RPC_URL || undefined,
    fetchAllowHosts: new Set((process.env.JAW_MCP_FETCH_ALLOW_HOSTS ?? '').split(',').filter(Boolean)),
    ring: parseKeyRing(process.env.JAW_MCP_SEALING_KEYS),
  };
  return cached;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
