import { base, baseSepolia, type Chain } from 'viem/chains';
import { refusal } from '@/lib/safe-fetch';
import { parseKeyRing, type KeyRing } from './seal';

export const SUPPORTED_CHAINS: Readonly<Record<number, Chain>> = { [base.id]: base, [baseSepolia.id]: baseSepolia };

export interface Config {
  issuer: string;
  resource: string;
  /** Where the owner's wallet opens: keys.jaw.id, whose cli-bridge page answers over the relay. */
  keysOrigin: string;
  relayUrl: string;
  chain: Chain;
  rpcUrl: string | undefined;
  mainnetRpcUrl: string | undefined;
  /** Local verification only: hosts jaw_quote may reach without the SSRF checks. */
  insecureFetchHosts: ReadonlySet<string>;
  paymasterApiKey: string | undefined;
  /** Base units a refill brings the payer up to, so refills are rare; the grant's cap still bounds it. */
  floatTarget: bigint;
  /** USDC base units per day a connection that pays asks for when it connects. */
  dailyBudget: bigint;
  swapUrl: string;
  swapQuoteTtlSec: number;
  ring: KeyRing;
}

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const publicUrl = new URL(required('JAW_MCP_PUBLIC_URL'));
  const issuer = publicUrl.origin;
  const insecureFetchHosts = new Set((process.env.JAW_MCP_INSECURE_FETCH_HOSTS ?? '').split(',').filter(Boolean));
  if (insecureFetchHosts.size > 0 && !isLocal(publicUrl.hostname)) {
    throw new Error(
      `JAW_MCP_INSECURE_FETCH_HOSTS is for local testing only, and JAW_MCP_PUBLIC_URL ${issuer} is not local`
    );
  }
  const chainId = Number(process.env.JAW_MCP_CHAIN_ID ?? baseSepolia.id);
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) throw new Error(`JAW_MCP_CHAIN_ID ${chainId} is not supported`);
  cached = {
    issuer,
    resource: `${issuer}/mcp`,
    keysOrigin: new URL(required('JAW_KEYS_URL')).origin,
    relayUrl: process.env.JAW_RELAY_URL || 'wss://relay.jaw.id',
    chain,
    rpcUrl: process.env.JAW_MCP_RPC_URL || undefined,
    mainnetRpcUrl: process.env.JAW_MCP_MAINNET_RPC_URL || undefined,
    insecureFetchHosts,
    paymasterApiKey: process.env.JAW_MCP_API_KEY || undefined,
    floatTarget: baseUnits('JAW_MCP_FLOAT_TARGET', process.env.JAW_MCP_FLOAT_TARGET || '250000'),
    dailyBudget: baseUnits('JAW_MCP_DAILY_BUDGET', process.env.JAW_MCP_DAILY_BUDGET || '1000000'),
    swapUrl: swapUrl(process.env.JAW_MCP_SWAP_URL || 'https://api.justaname.id/proxy/v2', insecureFetchHosts),
    swapQuoteTtlSec: quoteTtl(process.env.JAW_MCP_SWAP_QUOTE_TTL_SEC || '300'),
    ring: parseKeyRing(process.env.JAW_MCP_SEALING_KEYS),
  };
  return cached;
}

// Loopback, or the .localhost and .test names no public server can have.
function isLocal(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.test')
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function baseUnits(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be whole base units, such as 250000 for 0.25 USDC`);
  return BigInt(value);
}

export const QUOTE_MARGIN_SEC = 60;

function quoteTtl(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= QUOTE_MARGIN_SEC) {
    throw new Error('JAW_MCP_SWAP_QUOTE_TTL_SEC must be whole seconds over 60, such as 300');
  }
  return Number(value);
}

function swapUrl(value: string, insecureFetchHosts: ReadonlySet<string>): string {
  if (!URL.canParse(value) || /[?#]/.test(value)) {
    throw new Error('JAW_MCP_SWAP_URL must be a URL with no query or hash, such as https://api.justaname.id/proxy/v2');
  }
  const url = new URL(value);
  const allowed = 'list its host:port in JAW_MCP_INSECURE_FETCH_HOSTS to allow it';
  const refused = refusal(url, insecureFetchHosts);
  if (refused) throw new Error(`JAW_MCP_SWAP_URL is refused, ${refused}: ${allowed}`);
  if (isLocal(url.hostname) && !insecureFetchHosts.has(url.host)) {
    throw new Error(`JAW_MCP_SWAP_URL is refused, its host is local: ${allowed}`);
  }
  return value.replace(/\/+$/, '');
}
