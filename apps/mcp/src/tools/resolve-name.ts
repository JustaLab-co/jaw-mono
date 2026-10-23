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
import { refusal, withNext } from './reply';

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
export const ccipRequest = (params: CcipRequestParameters) => ccipRequestVia(safeFetch(new Set()), params);

export async function ccipRequestVia(
  guarded: typeof fetch,
  { data, sender, urls, requestOptions }: CcipRequestParameters
) {
  for (const url of urls) {
    requestOptions?.signal?.throwIfAborted();
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

export const ensClient = (transport: Transport, signal?: AbortSignal): EnsClient =>
  createPublicClient({
    chain: mainnet,
    transport,
    ccipRead: { request: (args) => ccipRequest({ ...args, requestOptions: { signal } }) },
  });

const mainnetClient = (signal?: AbortSignal) =>
  ensClient(http(config().mainnetRpcUrl, { timeout: LOOKUP_MS, fetchOptions: { signal } }), signal);

const unresolved = (why: Reason, summary: string, name: string | null = null, address: string | null = null) =>
  resolveOutput.parse({ name, address, chainId, reason: why, summary });

/** Throws when `name` does not normalize or the lookup fails. */
export async function resolveName(name: string, client: EnsClient = mainnetClient()) {
  return addressOf(normalize(name), client);
}

async function addressOf(name: string, client: EnsClient): Promise<Resolved> {
  const address = await client.getEnsAddress({ name });
  if (!address) return unresolved('no_address', `${name} has no address.`, name);
  return resolveOutput.parse({ name, address, chainId, summary: `${name} resolves to ${address}.` });
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

async function withDeadline(run: (signal: AbortSignal) => Promise<Resolved>, ms: number): Promise<Resolved> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('lookup timed out')), ms);
  const late = new Promise<never>((_, stop) =>
    deadline.signal.addEventListener('abort', () => stop(deadline.signal.reason))
  );
  try {
    return await Promise.race([run(deadline.signal), late]);
  } catch (err) {
    log('warn', { msg: 'ens lookup failed', error: errorLabel(err) });
    return unresolved('lookup_failed', 'The lookup could not finish right now. Try again.');
  } finally {
    clearTimeout(timer);
  }
}

export async function lookup(
  input: { name: string } | { address: string },
  connect: (signal: AbortSignal) => EnsClient = mainnetClient,
  ms = LOOKUP_MS
): Promise<Resolved> {
  if ('address' in input) {
    if (!isAddress(input.address, { strict: false }))
      return unresolved('invalid_address', 'That is not a valid address.');
    return withDeadline((signal) => nameOf(input.address, connect(signal)), ms);
  }
  let name: string;
  try {
    name = normalize(input.name);
  } catch {
    return unresolved('invalid_name', `"${input.name.slice(0, 100)}" is not a valid ENS name.`);
  }
  return withDeadline((signal) => addressOf(name, connect(signal)), ms);
}

// The call failed, as opposed to the lookup answering that there is nothing.
const FAILED = new Set<Reason | undefined>(['invalid_name', 'invalid_address', 'lookup_failed']);

export function registerResolveNameTool(server: McpServer) {
  server.registerTool(
    'jaw_resolve_name',
    {
      title: 'Look up a name or address',
      description:
        'Turn a name such as alice.eth into its address, or an address into its primary name. Use it whenever the ' +
        'owner gives a name as a recipient: resolve it before building the transfer, and show the owner both the name ' +
        'and the address they are about to send to. Never guess an address from a name. Use the reverse lookup to show ' +
        'a friendly name for an address in a history or a permission. Pass exactly one of name or address. A reason ' +
        'says why nothing came back; a name with no address is not a destination.',
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
      return refusal(withNext('Nothing was looked up.', 'Pass exactly one of `name` or `address`.'));
    }
  );
}

function answer(out: Resolved) {
  const res = reply(out);
  return FAILED.has(out.reason) ? { ...res, isError: true } : res;
}
