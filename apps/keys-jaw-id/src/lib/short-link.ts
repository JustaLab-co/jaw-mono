import { isAddress, type Address } from 'viem';

/**
 * A short owner link, `/a/<id>#<k>`, names a blob this app stores and carries the key that opens it in the fragment,
 * which never reaches a server. The blob is AES-256-GCM over the long link's values, with the id as associated data so
 * a blob moved to another id does not open. A batch blob (`v: 2`) holds, instead, the short links of several owner
 * links of one account.
 */
export const SHORT_LINK_ID = /^[A-Za-z0-9_-]{22}$/;

const KEY = /^[A-Za-z0-9_-]{43}$/;
const AD_LABEL = 'jaw-short-link/1';
const IV_BYTES = 12;

/** What the cli-bridge page needs: the session and relay of its query, and its fragment. */
export type OpenedLink = { session: string; relay: string; fragment: string };

/** One owner link of a batch: its own short link, and the chain its request is for. */
export type BatchMember = { id: string; key: string; chainId: number };

/** A batch link: the owner links of one account, at most one per chain, approved on one screen. */
export type OpenedBatch = { account: Address; members: BatchMember[] };

/** As many owner links as one account can hold open at once. */
export const MAX_BATCH_MEMBERS = 5;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Undefined for anything that does not open: a bad id or key, a missing or expired blob, or a tampered one. */
export async function openShortLink(
  id: string,
  key: string,
  fetcher: Fetcher = fetch
): Promise<OpenedLink | OpenedBatch | undefined> {
  // 43 canonical base64url characters are exactly 32 bytes.
  const raw = KEY.test(key) && SHORT_LINK_ID.test(id) ? canonicalBytes(key) : undefined;
  if (!raw) return undefined;
  try {
    const response = await fetcher(`/api/a/${id}`, { cache: 'no-store' });
    if (!response.ok) return undefined;
    const { blob } = await response.json();
    const sealed = typeof blob === 'string' ? canonicalBytes(blob) : undefined;
    if (!sealed) return undefined;
    const aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.slice(0, IV_BYTES),
        additionalData: new TextEncoder().encode(`${AD_LABEL}\n${id}`),
      },
      aesKey,
      sealed.slice(IV_BYTES)
    );
    const opened = JSON.parse(new TextDecoder().decode(plain));
    return opened?.v === 2 ? batchOf(opened, id) : linkOf(opened);
  } catch {
    return undefined;
  }
}

function linkOf(v: Record<string, unknown>): OpenedLink | undefined {
  const { v: version, session, relay, pk, s } = v;
  if (version !== 1) return undefined;
  if ([session, relay, pk, s].some((field) => typeof field !== 'string')) return undefined;
  return { session: session as string, relay: relay as string, fragment: `pk=${pk}&s=${s}` };
}

function batchOf(v: Record<string, unknown>, id: string): OpenedBatch | undefined {
  const { account, members } = v;
  if (typeof account !== 'string' || !isAddress(account)) return undefined;
  if (!Array.isArray(members) || members.length === 0 || members.length > MAX_BATCH_MEMBERS) return undefined;
  // A member naming the batch itself would open as a batch again.
  if (!members.every((m) => isMember(m) && m.id !== id)) return undefined;
  // One member per chain. The page still checks each member's request against the chain it is listed under.
  const distinct = (field: 'id' | 'chainId') => new Set(members.map((m) => m[field])).size === members.length;
  if (!distinct('id') || !distinct('chainId')) return undefined;
  return { account, members: members.map(({ id, key, chainId }) => ({ id, key, chainId })) };
}

function isMember(m: unknown): m is BatchMember {
  if (typeof m !== 'object' || m === null) return false;
  const { id, key, chainId } = m as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    SHORT_LINK_ID.test(id) &&
    typeof key === 'string' &&
    KEY.test(key) &&
    canonicalBytes(key) !== undefined &&
    Number.isSafeInteger(chainId) &&
    (chainId as number) > 0
  );
}

/** Unpadded base64url decoded, only when re-encoding gives the same text back, which rejects any other alphabet. */
function canonicalBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const again = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return again === text ? bytes : undefined;
  } catch {
    return undefined;
  }
}
