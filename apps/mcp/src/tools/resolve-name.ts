import type { McpServer } from '@modelcontextprotocol/server';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHex,
  type CcipRequestParameters,
  type PublicClient,
  type Transport,
} from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { FetchRefused } from '@jaw.id/agent';
import { z } from 'zod';
import { tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { safeFetch } from '@/lib/safe-fetch';
import { refusal } from './reply';

const LOOKUP_MS = 8_000;
const chainId = `eip155:${mainnet.id}`;

const reason = z.enum([
  'invalid_name',
  'invalid_address',
  'no_address',
  'no_primary_name',
  'unverified_name',
  'lookup_failed',
]);

const resolveOutput = z.object({
  name: z.string().nullable(),
  address: z.string().nullable(),
  chainId: z.string(),
  reason: reason.optional(),
  summary: z.string(),
});
type Resolved = z.infer<typeof resolveOutput>;
type Reason = z.infer<typeof reason>;

export type EnsClient = Pick<PublicClient, 'getEnsAddress' | 'getEnsName'>;

// CCIP-Read gateway URLs come from resolver contracts, so they go through the guarded fetch.
export async function ccipRequest({ data, sender, urls, requestOptions }: CcipRequestParameters) {
  const guarded = safeFetch(new Set());
  for (const url of urls) {
    const get = url.includes('{data}');
    const res = await guarded(url.replace('{sender}', sender.toLowerCase()).replace('{data}', data), {
      method: get ? 'GET' : 'POST',
      headers: get ? {} : { 'Content-Type': 'application/json' },
      body: get ? undefined : JSON.stringify({ data, sender }),
      signal: requestOptions?.signal,
    }).catch((err) => {
      if (err instanceof FetchRefused) throw err;
      return null;
    });
    if (!res?.ok) continue;
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (isHex(body?.data)) return body.data;
  }
  throw new Error('no gateway answered');
}

export const ensClient = (transport: Transport): EnsClient =>
  createPublicClient({ chain: mainnet, transport, ccipRead: { request: ccipRequest } });

const mainnetClient = () => ensClient(http(config().mainnetRpcUrl, { timeout: LOOKUP_MS }));

const unresolved = (why: Reason, summary: string, name: string | null = null, address: string | null = null) =>
  resolveOutput.parse({ name, address, chainId, reason: why, summary });

/** Throws when `name` does not normalize or the lookup fails. */
export async function resolveName(name: string, client: EnsClient = mainnetClient()) {
  const normalized = normalize(name);
  const address = await client.getEnsAddress({ name: normalized });
  if (!address) return unresolved('no_address', `${normalized} has no address.`, normalized);
  return resolveOutput.parse({ name: normalized, address, chainId, summary: `${normalized} resolves to ${address}.` });
}

async function nameOf(address: string, client: EnsClient): Promise<Resolved> {
  const owner = getAddress(address);
  const raw = await client.getEnsName({ address: owner });
  if (!raw) return unresolved('no_primary_name', `${owner} has no primary name.`, null, owner);
  // Anyone can write a reverse record, so the name counts only when it points back.
  let name: string;
  try {
    name = normalize(raw);
  } catch {
    return unresolved('unverified_name', `${owner} has a primary name that does not normalize.`, null, owner);
  }
  const back = await client.getEnsAddress({ name });
  if (back?.toLowerCase() !== owner.toLowerCase()) {
    return unresolved('unverified_name', `${owner} claims ${name}, which does not resolve back to it.`, null, owner);
  }
  return resolveOutput.parse({ name, address: owner, chainId, summary: `${owner} is ${name}.` });
}

const withTimeout = <T>(work: Promise<T>) =>
  Promise.race([
    work,
    new Promise<never>((_, stop) => setTimeout(() => stop(new Error('lookup timed out')), LOOKUP_MS).unref()),
  ]);

async function settle(run: () => Promise<Resolved>): Promise<Resolved> {
  try {
    return await withTimeout(run());
  } catch (err) {
    log('warn', { msg: 'ens lookup failed', error: errorLabel(err) });
    return unresolved('lookup_failed', 'The lookup could not finish right now. Try again.');
  }
}

/** A name returns its address and an address returns its primary name, both on Ethereum mainnet. */
export async function lookup(input: { name: string } | { address: string }, client?: EnsClient): Promise<Resolved> {
  if ('address' in input) {
    if (!isAddress(input.address, { strict: false }))
      return unresolved('invalid_address', 'That is not a valid address.');
    return settle(() => nameOf(input.address, client ?? mainnetClient()));
  }
  try {
    normalize(input.name);
  } catch {
    return unresolved('invalid_name', `"${input.name.slice(0, 100)}" is not a valid ENS name.`);
  }
  return settle(() => resolveName(input.name, client));
}

// The call failed, as opposed to the lookup answering that there is nothing.
const FAILED = new Set<Reason | undefined>(['invalid_name', 'invalid_address', 'lookup_failed']);

export function registerResolveNameTool(server: McpServer) {
  server.registerTool(
    'jaw_resolve_name',
    {
      description:
        'Resolve an ENS name to its address, or an address to its primary ENS name, on Ethereum mainnet. Pass exactly one of `name` or `address`. A reason says why nothing came back.',
      inputSchema: z.strictObject({
        name: z.string().max(255).optional().describe('An ENS name such as alice.eth'),
        address: z.string().optional().describe('An address to look up the primary name of'),
      }),
      outputSchema: resolveOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, address }, ctx) => {
      tenant(ctx);
      if (name !== undefined && address === undefined) return answer(await lookup({ name }));
      if (address !== undefined && name === undefined) return answer(await lookup({ address }));
      return refusal('Pass exactly one of `name` or `address`.');
    }
  );
}

function answer(out: Resolved) {
  const res = reply(out);
  return FAILED.has(out.reason) ? { ...res, isError: true } : res;
}
