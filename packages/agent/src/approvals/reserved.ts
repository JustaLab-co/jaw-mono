import { hexToString, isHex } from 'viem';

/** Messages starting with this are reserved for JAW's own statements. */
export const RESERVED_PREFIX = 'JAW ';

/** EIP-712 domain name reserved for JAW's consent and approval pages. Generic signing paths refuse it. */
export const JAW_DOMAIN_NAME = 'JAW';

const domain = (chainId: number) => ({ name: JAW_DOMAIN_NAME, version: '1', chainId });

/** What a JAW MCP connection can be granted, in the order consent lists and signs them. */
export const CONNECTION_SCOPES = {
  'wallet:read': 'See your account, balances and payment history',
  'x402:pay': 'Pay x402 services from a daily USDC budget you approve',
  'wallet:send': 'Ask you to approve transfers, contract calls and signatures',
} as const;
export type ConnectionScope = keyof typeof CONNECTION_SCOPES;

// A type alias, not an interface: viem's typed data checks need the index signature it implies.
export type ConsentTerms = {
  issuer: string;
  interaction: string;
  clientId: string;
  clientName: string;
  scopes: string;
  expires: string;
};

export function consentTypedData(chainId: number, terms: ConsentTerms) {
  return {
    domain: domain(chainId),
    types: {
      Consent: [
        { name: 'issuer', type: 'string' },
        { name: 'interaction', type: 'string' },
        { name: 'clientId', type: 'string' },
        { name: 'clientName', type: 'string' },
        { name: 'scopes', type: 'string' },
        { name: 'expires', type: 'string' },
      ],
    },
    primaryType: 'Consent',
    message: terms,
  } as const;
}

/** A reject is signed too, so only the account can move its own request. */
export function rejectionTypedData(chainId: number, request: string) {
  return {
    domain: domain(chainId),
    types: {
      Decision: [
        { name: 'request', type: 'string' },
        { name: 'verdict', type: 'string' },
      ],
    },
    primaryType: 'Decision',
    message: { request, verdict: 'reject' },
  } as const;
}

/** Proves the account to the connections page of one server, until `expires`. */
export function connectionsSignInTypedData(chainId: number, terms: { issuer: string; expires: string }) {
  return {
    domain: domain(chainId),
    types: {
      ConnectionsSignIn: [
        { name: 'issuer', type: 'string' },
        { name: 'expires', type: 'string' },
      ],
    },
    primaryType: 'ConnectionsSignIn',
    message: terms,
  } as const;
}

export const RESERVED_SIGNING_REFUSAL = 'JAW reserves this request for its own consent and approval pages';

/** Why a generic signing request must not reach the passkey, or undefined when it may. */
export function reservedSigningRefusal(method: string, params: unknown): string | undefined {
  const list = Array.isArray(params) ? params : [params];
  let reserved = false;
  if (method === 'personal_sign') reserved = list.some(isReservedText);
  else if (method.startsWith('eth_signTypedData')) reserved = list.some(isJawTypedData);
  else if (method === 'wallet_sign') {
    const request = (list[0] as { request?: { type?: unknown; data?: { message?: unknown } } } | undefined)?.request;
    reserved = request?.type === '0x45' ? isReservedText(request.data?.message) : isJawTypedData(request?.data);
  }
  return reserved ? RESERVED_SIGNING_REFUSAL : undefined;
}

function isReservedText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.startsWith(RESERVED_PREFIX) || (isHex(value) && hexToString(value).startsWith(RESERVED_PREFIX));
}

function isJawTypedData(value: unknown): boolean {
  let data = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return (data as { domain?: { name?: unknown } } | null)?.domain?.name === JAW_DOMAIN_NAME;
}
