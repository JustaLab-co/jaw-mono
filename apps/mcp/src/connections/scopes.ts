/** What a connection can be granted. Every tool needs wallet:read. */
export const CONNECTION_SCOPES = {
  'wallet:read': 'See your account, balances and payment history',
  'x402:pay': 'Pay x402 services from a daily USDC budget you approve',
} as const;
export type ConnectionScope = keyof typeof CONNECTION_SCOPES;

/** Clients JAW ships, registered on the server rather than fetched from a metadata document. */
export const FIRST_PARTY_CLIENTS: Readonly<Record<string, string>> = { 'jaw-cli': 'JAW CLI' };

/** Scopes that spend from the account, which the connection grants an on-chain permission for. */
export const spends = (scopes: readonly string[]) => scopes.includes('x402:pay');
