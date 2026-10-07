/** Clients JAW ships, registered on the server. Only these may be called official. */
export const FIRST_PARTY_CLIENTS: Readonly<Record<string, string>> = { 'jaw-cli': 'JAW CLI' };

export interface ClientIdentity {
  clientId: string;
  /** The first-party name, or what a third-party client declared about itself. */
  name: string;
  /** Domain of the client's metadata document: the identity a third-party client cannot fake. */
  host: string | null;
  official: boolean;
  /** A third-party client whose declared name claims to be JAW. */
  reservedName: boolean;
}

export function clientIdentity(clientId: string, declaredName: string): ClientIdentity {
  const firstParty = Object.hasOwn(FIRST_PARTY_CLIENTS, clientId) ? FIRST_PARTY_CLIENTS[clientId] : undefined;
  let host: string | null = null;
  try {
    host = new URL(clientId).host;
  } catch {
    host = null;
  }
  const squeezed = declaredName.replace(/[\s\p{Cf}]/gu, '');
  return {
    clientId,
    name: firstParty ?? declaredName,
    host,
    official: firstParty !== undefined,
    reservedName: firstParty === undefined && /jaw/i.test(squeezed),
  };
}
