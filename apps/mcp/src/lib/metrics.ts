const unauthorized = new Map<string, number>();

// Any app a user consented to can hold a token, so past this many clients the rest share one label.
const MAX_CLIENTS = 100;

export function countUnauthorized(client: string) {
  const label = unauthorized.has(client) || unauthorized.size < MAX_CLIENTS ? client : 'other';
  unauthorized.set(label, (unauthorized.get(label) ?? 0) + 1);
}

export const unauthorizedCounts = (): ReadonlyMap<string, number> => unauthorized;
