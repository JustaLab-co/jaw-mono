/**
 * What a connection can be granted, and what the owner signs that each allows.
 * Every tool needs wallet:read. wallet:send is deprecated: still granted when a
 * client asks for it, so older clients connect, but it allows nothing.
 */
export const CONNECTION_SCOPES = {
  'wallet:read': 'See your account, balances and payment history',
  'x402:pay': 'Pay x402 services from a daily USDC budget you approve',
  'wallet:send': null,
} as const;
export type ConnectionScope = keyof typeof CONNECTION_SCOPES;

/** The scopes the metadata lists for clients to ask for. */
export const ADVERTISED_SCOPES = (Object.keys(CONNECTION_SCOPES) as ConnectionScope[]).filter(
  (s) => CONNECTION_SCOPES[s] !== null
);

/** Clients JAW ships, registered on the server rather than fetched from a metadata document. */
export const FIRST_PARTY_CLIENTS: Readonly<Record<string, string>> = { 'jaw-cli': 'JAW CLI' };

/** Whether the connection gets a daily budget: an on-chain permission and its prefund. */
export const spends = (scopes: readonly string[]) => scopes.includes('x402:pay');
