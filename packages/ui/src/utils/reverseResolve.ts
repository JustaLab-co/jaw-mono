import { toCoinType, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { getPublicClient } from './publicClient';

// ENS metadata service: a valid-cert proxy that resolves a name's avatar record server-side and
// streams the bytes. We render this instead of the raw avatar URL so the signing/permission page
// never connects directly to an attacker-controlled host — a host with a TLS cert error there
// taints the page and blocks the WebAuthn (passkey) ceremony in strict browsers (e.g. Brave).
const ENS_METADATA_AVATAR_BASE = 'https://metadata.ens.domains/mainnet/avatar/';

/** The ENS metadata proxy URL for a name's avatar. */
export function ensMetadataAvatarUrl(name: string): string {
  return ENS_METADATA_AVATAR_BASE + encodeURIComponent(name);
}

// The name service, kept for one case only: a name whose resolver is offchain.
// Following that lookup from here would mean fetching a host the resolver names,
// which the signing page must not do, so a server that can does it instead.
const REVERSE_ENDPOINT = 'https://api.justaname.id/ens/v2/reverse';

/**
 * How long an answer is remembered, per address, chain, rpc url and whether the
 * avatar was asked for.
 *
 * Names change rarely and the dialogs re-render often, so without this a screen
 * asks again on every paint. An answer is what gets remembered, including the
 * answer that there is no name: that one will not change within the window. A
 * node that did not answer is not an answer, and neither is a timeout: both
 * report the network of the moment, and both are asked again.
 */
const MEMORY_MS = 60_000;

/**
 * How long the whole resolution may take, the fallback included.
 *
 * Names are decoration on a signing screen: the address and the amounts do not
 * wait for them. Whatever has not arrived by here is left out and the address
 * renders as hex, which is what already happens when a node will not answer.
 */
const BUDGET_MS = 2_000;

export interface ReverseInput {
  address: string;
  chainId: number;
}

/** One slot of the name service's answer. Everything in it is off the wire, so nothing is assumed present. */
interface ReverseSlot {
  address?: string;
  name?: string | null;
  // With `records=true` the records arrive in /v2/resolve's shape, nested twice.
  records?: { records?: { texts?: { key: string }[] | null } | null } | null;
}

export interface ResolvedIdentity {
  name: string;
  avatar?: string;
}

/** Keyed by address and chain: the same address can carry a different name per chain. */
export function identityKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}:${chainId}`;
}

type EnsClient = ReturnType<typeof getPublicClient>;
/** An answer, or one of the two things that are not one. */
type Outcome = { identity: ResolvedIdentity | null } | 'offchain' | 'unanswered';

const memory = new Map<string, { at: number; identity: ResolvedIdentity | null }>();

/** Drops what was remembered. For tests, which would otherwise share it. */
export function clearIdentityMemory(): void {
  memory.clear();
}

/** What an answer is filed under. The url and the avatar are part of it: a key changes who answers, and a name remembered without its avatar would be served to a caller that asked for one. */
function memoryKey(input: ReverseInput, rpcUrl: string, withAvatar: boolean): string {
  return `${identityKey(input.address, input.chainId)}|${rpcUrl}|${withAvatar ? 'avatar' : 'name'}`;
}

function remembered(key: string): { identity: ResolvedIdentity | null } | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= MEMORY_MS) {
    memory.delete(key);
    return undefined;
  }
  return { identity: entry.identity };
}

/** The ENSIP-10 revert this client refuses to follow, which is how an offchain name announces itself. */
const OFFCHAIN_LOOKUP_SELECTOR = '0x556f1830';

function isOffchainLookup(error: unknown): boolean {
  for (let node: unknown = error, depth = 0; node && depth < 8; depth++) {
    const { data, cause } = node as { data?: unknown; cause?: unknown };
    const raw = typeof data === 'string' ? data : (data as { data?: string } | undefined)?.data;
    if (typeof raw === 'string' && raw.startsWith(OFFCHAIN_LOOKUP_SELECTOR)) return true;
    node = cause;
  }
  return false;
}

/**
 * The name an address reverses to over the chain.
 *
 * Off mainnet both records are asked at once and the chain's own wins: it is the
 * name the owner set for that chain, and the default is what almost everyone has.
 * Asking in sequence would put a second round trip inside a two second budget for
 * the sake of the rarer answer.
 *
 * `toCoinType` throws for a chain id ENSIP-9 cannot express. That is caught here,
 * so such a chain still gets the default name rather than rejecting the batch
 * every other name is in.
 */
async function nameOnChain(client: EnsClient, address: Address, chainId: number): Promise<string | null> {
  const fallback = client.getEnsName({ address });
  if (chainId === mainnet.id) return fallback;

  const scoped = await Promise.resolve()
    .then(() => client.getEnsName({ address, coinType: toCoinType(chainId) }))
    .catch((error) => {
      // An offchain resolver is the server's to follow, and the name it holds is
      // the one this address answers with, so it decides for both reads.
      if (isOffchainLookup(error)) throw error;
      return null;
    });
  return scoped ?? (await fallback);
}

/** Whether the name carries an avatar record. The value is never read: the metadata proxy resolves it. */
async function avatarOf(client: EnsClient, name: string): Promise<string | undefined> {
  const record = await client.getEnsText({ name, key: 'avatar' }).catch(() => null);
  return record ? ensMetadataAvatarUrl(name) : undefined;
}

async function resolveOnChain(
  client: EnsClient,
  input: ReverseInput,
  withAvatar: boolean
): Promise<Exclude<Outcome, 'timeout'>> {
  try {
    const name = await nameOnChain(client, input.address as Address, input.chainId);
    if (!name) return { identity: null };
    const avatar = withAvatar ? await avatarOf(client, name) : undefined;
    return { identity: avatar ? { name, avatar } : { name } };
  } catch (error) {
    // Only the offchain lookup goes to the server. Anything else is a node that
    // did not answer: sending it on would turn a blip of ours into a second
    // request that fails the same way, and filing it as "no name" would put hex
    // on the screen for the whole window. With the multicall batching on, one
    // 5xx rejects every caller in the batch, so that would be the whole dialog.
    if (isOffchainLookup(error)) return 'offchain';
    return 'unanswered';
  }
}

/** Whether the url carries a key. Without one the name service refuses, so the hop is not worth making. */
function carriesApiKey(rpcUrl: string): boolean {
  try {
    return !!new URL(rpcUrl).searchParams.get('api-key');
  } catch {
    return false;
  }
}

/** The offchain names, resolved by the server that may follow their gateways. One request per chain, since the service echoes the address alone and two chains would collapse onto it. */
async function resolveOffchain(
  inputs: ReverseInput[],
  rpcUrl: string,
  withAvatar: boolean
): Promise<Map<string, ResolvedIdentity | null>> {
  const answers = new Map<string, ResolvedIdentity | null>();
  if (inputs.length === 0) return answers;
  // Deterministic without a key, so it is remembered as a non-answer rather than retried.
  if (!carriesApiKey(rpcUrl)) {
    for (const input of inputs) answers.set(identityKey(input.address, input.chainId), null);
    return answers;
  }

  const byChain = new Map<number, ReverseInput[]>();
  for (const input of inputs) {
    const group = byChain.get(input.chainId);
    if (group) group.push(input);
    else byChain.set(input.chainId, [input]);
  }

  await Promise.all(
    Array.from(byChain, async ([chainId, group]) => {
      const url = new URL(REVERSE_ENDPOINT);
      group.forEach(({ address }) => url.searchParams.append('address', `${address}@eip155:${chainId}`));
      url.searchParams.set('rpcUrl', rpcUrl);
      if (withAvatar) url.searchParams.set('records', 'true');

      const res = await fetch(url.toString());
      if (!res.ok) return;

      const body = (await res.json()) as { result?: { data?: ReverseSlot | ReverseSlot[] | null } };
      const data = body.result?.data;
      if (!data) return;

      for (const slot of Array.isArray(data) ? data : [data]) {
        // Read back from the wire, so nothing here is assumed to be there.
        if (!slot?.address) continue;
        const key = identityKey(slot.address, chainId);
        if (!slot.name) {
          answers.set(key, null);
          continue;
        }
        const hasAvatar = withAvatar && !!slot.records?.records?.texts?.some((t) => t.key === 'avatar');
        answers.set(
          key,
          hasAvatar ? { name: slot.name, avatar: ensMetadataAvatarUrl(slot.name) } : { name: slot.name }
        );
      }
    })
  );
  return answers;
}

async function reverseResolve(
  inputs: ReverseInput[],
  rpcUrl: string,
  withAvatar: boolean
): Promise<Record<string, ResolvedIdentity>> {
  const unique = Array.from(new Map(inputs.map((i) => [identityKey(i.address, i.chainId), i])).values());
  if (unique.length === 0 || !rpcUrl) return {};

  const resolved: Record<string, ResolvedIdentity> = {};
  const ask: ReverseInput[] = [];

  for (const input of unique) {
    const known = remembered(memoryKey(input, rpcUrl, withAvatar));
    if (!known) {
      ask.push(input);
      continue;
    }
    if (known.identity) resolved[identityKey(input.address, input.chainId)] = known.identity;
  }
  if (ask.length === 0) return resolved;

  const client = getPublicClient(mainnet.id, rpcUrl);
  // One budget for the whole thing, cleared as soon as the work is done rather
  // than left to fire into an empty room. Nothing is remembered when it expires,
  // so the next dialog asks again instead of inheriting the network of a moment.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), BUDGET_MS);
  });

  try {
    const onChain = await Promise.race([
      Promise.all(ask.map(async (input) => ({ input, outcome: await resolveOnChain(client, input, withAvatar) }))),
      budget,
    ]);
    if (onChain === 'timeout') return resolved;

    const offchain: ReverseInput[] = [];
    for (const { input, outcome } of onChain) {
      const key = identityKey(input.address, input.chainId);
      // A node that did not answer is asked again by whoever renders next.
      if (outcome === 'unanswered') continue;
      if (outcome === 'offchain') {
        offchain.push(input);
        continue;
      }
      memory.set(memoryKey(input, rpcUrl, withAvatar), { at: Date.now(), identity: outcome.identity });
      if (outcome.identity) resolved[key] = outcome.identity;
    }
    if (offchain.length === 0) return resolved;

    const answers = await Promise.race([resolveOffchain(offchain, rpcUrl, withAvatar).catch(() => null), budget]);
    if (answers === 'timeout' || !answers) return resolved;

    for (const input of offchain) {
      const key = identityKey(input.address, input.chainId);
      if (!answers.has(key)) continue;
      const identity = answers.get(key) ?? null;
      memory.set(memoryKey(input, rpcUrl, withAvatar), { at: Date.now(), identity });
      if (identity) resolved[key] = identity;
    }
    return resolved;
  } finally {
    clearTimeout(timer);
  }
}

/** Reverse-resolve addresses to ENS names over the chain. Never rejects; unresolved addresses are omitted. Keyed by {@link identityKey}. */
export async function reverseResolveAddresses(inputs: ReverseInput[], rpcUrl: string): Promise<Record<string, string>> {
  const identities = await reverseResolve(inputs, rpcUrl, false);
  const names: Record<string, string> = {};
  for (const [key, identity] of Object.entries(identities)) {
    names[key] = identity.name;
  }
  return names;
}

/** Like {@link reverseResolveAddresses} but also reports which names carry an avatar record. Keyed by {@link identityKey}. */
export async function reverseResolveWithAvatars(
  inputs: ReverseInput[],
  rpcUrl: string
): Promise<Record<string, ResolvedIdentity>> {
  return reverseResolve(inputs, rpcUrl, true);
}
