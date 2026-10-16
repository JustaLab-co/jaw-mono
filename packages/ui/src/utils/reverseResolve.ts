import { toCoinType } from 'viem';

const REVERSE_ENDPOINT = 'https://api.justaname.id/ens/v2/reverse';
const MAX_BATCH = 50;
// ENS metadata service: a valid-cert proxy that resolves a name's avatar record server-side and
// streams the bytes. We render this instead of the raw avatar URL so the signing/permission page
// never connects directly to an attacker-controlled host — a host with a TLS cert error there
// taints the page and blocks the WebAuthn (passkey) ceremony in strict browsers (e.g. Brave).
const ENS_METADATA_AVATAR_BASE = 'https://metadata.ens.domains/mainnet/avatar/';

/** The ENS metadata proxy URL for a name's avatar. */
export function ensMetadataAvatarUrl(name: string): string {
  return ENS_METADATA_AVATAR_BASE + encodeURIComponent(name);
}

export interface ReverseInput {
  address: string;
  chainId: number;
}

export interface ResolvedIdentity {
  name: string;
  avatar?: string;
}

interface ReverseText {
  key: string;
  value: string;
}

interface ReverseSlot {
  address: string;
  name: string | null;
  // Echoes the coinType of the `@eip155:<chainId>` suffix the address was asked
  // with. Null for a slot that failed before the lookup, which has no chain.
  coinType: number | null;
  // With `records=true`, records are attached in /v2/resolve's shape — note the nested `records.records`.
  records?: { records?: { texts?: ReverseText[] | null } | null } | null;
}

interface ReverseResponse {
  result?: { data?: ReverseSlot | ReverseSlot[] | null };
}

/** Keyed by address and chain: the same address can carry a different name on each one. */
export function identityKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}:${chainId}`;
}

/**
 * The coinType the service echoes for a chain.
 *
 * Undefined for a chain id ENSIP-11 cannot express, which is reachable: the chain comes off
 * the transaction the dApp asked to sign, not off our own list, and `toCoinType` throws at
 * or above 2^31. Without this one bad id would take the whole batch down with it.
 */
function coinTypeOf(chainId: number): number | undefined {
  try {
    return Number(toCoinType(chainId));
  } catch {
    return undefined;
  }
}

async function fetchReverseBatch(
  batch: ReverseInput[],
  rpcUrl: string,
  withRecords: boolean
): Promise<Record<string, ResolvedIdentity>> {
  const url = new URL(REVERSE_ENDPOINT);
  // Per-address `@eip155:<chainId>` suffix scopes each address to its chain; the API echoes it back lowercased and stripped.
  batch.forEach(({ address, chainId }) => url.searchParams.append('address', `${address}@eip155:${chainId}`));
  url.searchParams.set('rpcUrl', rpcUrl);
  // records=true returns each name's records inline, so the avatar needs no separate forward resolution.
  if (withRecords) url.searchParams.set('records', 'true');

  const res = await fetch(url.toString());
  if (!res.ok) {
    // A 5xx or a 429 is an outage, worth asking again. Any other 4xx says the request
    // itself is wrong, which asking again will not fix, so it reads as no names.
    if (res.status >= 500 || res.status === 429) throw new Error(`Reverse resolution failed: ${res.status}`);
    return {};
  }

  const body = (await res.json()) as ReverseResponse;
  const data = body.result?.data;
  if (!data) return {};

  // The chain a slot belongs to is read back off its coinType rather than taken from
  // the request's order, so a slot that cannot be placed renders as hex instead of
  // lending its name to another chain's row.
  const chainByCoinType = new Map<number, number>();
  for (const { chainId } of batch) {
    const coinType = coinTypeOf(chainId);
    if (coinType !== undefined) chainByCoinType.set(coinType, chainId);
  }

  const slots = Array.isArray(data) ? data : [data];
  const resolved: Record<string, ResolvedIdentity> = {};
  for (const slot of slots) {
    if (!slot?.name) continue;
    const chainId = slot.coinType === null ? undefined : chainByCoinType.get(slot.coinType);
    if (chainId === undefined) continue;
    const identity: ResolvedIdentity = { name: slot.name };
    if (withRecords) {
      // Gate on record presence only; the ENS metadata proxy resolves the record's value
      // (https/ipfs/data/eip155 NFT) itself, so we don't parse it here.
      const hasAvatar = !!slot.records?.records?.texts?.find((t) => t.key === 'avatar')?.value;
      if (hasAvatar) identity.avatar = ensMetadataAvatarUrl(slot.name);
    }
    resolved[identityKey(slot.address, chainId)] = identity;
  }
  return resolved;
}

export interface ReverseResolution {
  /** Keyed by {@link identityKey}; an address the service answered with no name is absent. */
  resolved: Record<string, ResolvedIdentity>;
  /** Addresses whose request failed, so whether they have a name is unknown. */
  unanswered: ReverseInput[];
}

async function reverseResolve(
  inputs: ReverseInput[],
  rpcUrl: string,
  withRecords: boolean
): Promise<ReverseResolution> {
  const unique = Array.from(new Map(inputs.map((i) => [identityKey(i.address, i.chainId), i])).values());

  const batches: ReverseInput[][] = [];
  for (let i = 0; i < unique.length; i += MAX_BATCH) {
    batches.push(unique.slice(i, i + MAX_BATCH));
  }

  const results = await Promise.allSettled(batches.map((batch) => fetchReverseBatch(batch, rpcUrl, withRecords)));
  const resolution: ReverseResolution = { resolved: {}, unanswered: [] };
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') Object.assign(resolution.resolved, result.value);
    else resolution.unanswered.push(...batches[i]);
  });
  return resolution;
}

/** Reverse-resolve addresses to ENS names in one batched request (deduped, chunked at 50, parallel). Never rejects; unresolved addresses are omitted. Keyed by {@link identityKey}. */
export async function reverseResolveAddresses(inputs: ReverseInput[], rpcUrl: string): Promise<Record<string, string>> {
  const { resolved } = await reverseResolve(inputs, rpcUrl, false);
  const names: Record<string, string> = {};
  for (const [key, identity] of Object.entries(resolved)) {
    names[key] = identity.name;
  }
  return names;
}

/** Like {@link reverseResolveAddresses} but with `records=true`, so each name's avatar comes back in the same request. Keyed by {@link identityKey}. */
export async function reverseResolveWithAvatars(
  inputs: ReverseInput[],
  rpcUrl: string
): Promise<Record<string, ResolvedIdentity>> {
  return (await reverseResolve(inputs, rpcUrl, true)).resolved;
}

/**
 * Like {@link reverseResolveWithAvatars}, but says which addresses went unanswered instead of
 * reading a failed request as "no name". For callers that keep the answer: a miss is worth
 * keeping for the session, an outage is not.
 */
export function reverseResolveIdentities(inputs: ReverseInput[], rpcUrl: string): Promise<ReverseResolution> {
  return reverseResolve(inputs, rpcUrl, true);
}
