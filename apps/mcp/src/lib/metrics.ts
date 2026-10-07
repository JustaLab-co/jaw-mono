// Per process: each instance reports its own refusals since it started.
const unauthorized = new Map<string, number>();

export function countUnauthorized(client: string) {
  unauthorized.set(client, (unauthorized.get(client) ?? 0) + 1);
}

export const unauthorizedCounts = (): ReadonlyMap<string, number> => unauthorized;
