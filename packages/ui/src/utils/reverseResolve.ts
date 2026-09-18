import { createPublicClient, http, toCoinType, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';

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

/**
 * The mainnet client each rpc url resolves over, kept per url.
 *
 * `batch.multicall` is what keeps this one round trip rather than one per address:
 * viem folds the universal resolver calls issued in the same tick into a single
 * multicall, which is the property the service hop used to provide.
 */
const clients = new Map<string, PublicClient>();

function clientFor(rpcUrl: string): PublicClient {
  let client = clients.get(rpcUrl);
  if (!client) {
    client = createPublicClient({ chain: mainnet, transport: http(rpcUrl), batch: { multicall: true } });
    clients.set(rpcUrl, client);
  }
  return client;
}

/**
 * The name an address reverses to, or null.
 *
 * A chain other than mainnet is asked under its own coin type first, which is the
 * name the owner set for that chain, and falls back to the default record. The
 * fallback is what keeps this from showing fewer names than the service did: most
 * addresses have only the default one.
 */
async function nameOf(client: PublicClient, address: Address, chainId: number): Promise<string | null> {
  if (chainId !== mainnet.id) {
    const scoped = await client.getEnsName({ address, coinType: toCoinType(chainId) }).catch(() => null);
    if (scoped) return scoped;
  }
  return client.getEnsName({ address }).catch(() => null);
}

/** Whether the name carries an avatar record. The value is never read here: the metadata proxy resolves it. */
async function hasAvatar(client: PublicClient, name: string): Promise<boolean> {
  const record = await client.getEnsText({ name, key: 'avatar' }).catch(() => null);
  return !!record;
}

async function reverseResolve(
  inputs: ReverseInput[],
  rpcUrl: string,
  withRecords: boolean
): Promise<Record<string, ResolvedIdentity>> {
  const unique = Array.from(new Map(inputs.map((i) => [`${i.address.toLowerCase()}:${i.chainId}`, i])).values());
  if (unique.length === 0) return {};

  const client = clientFor(rpcUrl);
  const resolved: Record<string, ResolvedIdentity> = {};

  const named = await Promise.all(
    unique.map(async (input) => ({
      input,
      name: await nameOf(client, input.address as Address, input.chainId),
    }))
  );

  const avatars = withRecords
    ? await Promise.all(named.map(({ name }) => (name ? hasAvatar(client, name) : Promise.resolve(false))))
    : [];

  named.forEach(({ input, name }, i) => {
    if (!name) return;
    const identity: ResolvedIdentity = { name };
    if (withRecords && avatars[i]) identity.avatar = ensMetadataAvatarUrl(name);
    resolved[input.address.toLowerCase()] = identity;
  });

  return resolved;
}

/** Reverse-resolve addresses to ENS names over the chain, deduped and folded into one multicall. Never rejects; unresolved addresses are omitted. Returns lowercased address -> name. */
export async function reverseResolveAddresses(inputs: ReverseInput[], rpcUrl: string): Promise<Record<string, string>> {
  const identities = await reverseResolve(inputs, rpcUrl, false);
  const names: Record<string, string> = {};
  for (const [address, identity] of Object.entries(identities)) {
    names[address] = identity.name;
  }
  return names;
}

/** Like {@link reverseResolveAddresses} but also reports which names carry an avatar record. Returns lowercased address -> { name, avatar? }. */
export async function reverseResolveWithAvatars(
  inputs: ReverseInput[],
  rpcUrl: string
): Promise<Record<string, ResolvedIdentity>> {
  return reverseResolve(inputs, rpcUrl, true);
}
