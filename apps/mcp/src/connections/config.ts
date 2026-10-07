import { base, baseSepolia, type Chain } from 'viem/chains';
import { parseKeyRing, type KeyRing } from './seal';

export const SUPPORTED_CHAINS: Readonly<Record<number, Chain>> = { [base.id]: base, [baseSepolia.id]: baseSepolia };

export interface Config {
  issuer: string;
  resource: string;
  keysOrigin: string;
  chain: Chain;
  rpcUrl: string | undefined;
  mainnetRpcUrl: string | undefined;
  /** Local verification only: hosts jaw_quote may reach without the SSRF checks. */
  insecureFetchHosts: ReadonlySet<string>;
  /** Charges a refill's gas through JAW's ERC-20 paymaster. Without it no refill runs. Never logged. */
  apiKey: string | undefined;
  ring: KeyRing;
}

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const issuer = new URL(required('JAW_MCP_PUBLIC_URL')).origin;
  const chainId = Number(process.env.JAW_MCP_CHAIN_ID ?? baseSepolia.id);
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) throw new Error(`JAW_MCP_CHAIN_ID ${chainId} is not supported`);
  cached = {
    issuer,
    resource: `${issuer}/mcp`,
    keysOrigin: new URL(required('JAW_KEYS_URL')).origin,
    chain,
    rpcUrl: process.env.JAW_MCP_RPC_URL || undefined,
    mainnetRpcUrl: process.env.JAW_MCP_MAINNET_RPC_URL || undefined,
    insecureFetchHosts: new Set((process.env.JAW_MCP_INSECURE_FETCH_HOSTS ?? '').split(',').filter(Boolean)),
    apiKey: process.env.JAW_MCP_API_KEY || undefined,
    ring: parseKeyRing(process.env.JAW_MCP_SEALING_KEYS),
  };
  return cached;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
