import type { McpServer } from '@modelcontextprotocol/server';
import { getAddress, isAddress } from 'viem';
import { normalize } from 'viem/ens';
import { z } from 'zod';
import { tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { chainName, listed, networkName } from '@/lib/owner-text';
import { safeFetch } from '@/lib/safe-fetch';
import { refusal, withNext } from './reply';

const MAINNET_ID = 1;
const MAINNET = `eip155:${MAINNET_ID}`;
const MAINNET_COIN = 60;
const EVM_FLAG = 0x80000000;

const reason = z.enum(['invalid_name', 'invalid_address', 'no_address', 'no_primary_name', 'lookup_failed']);

const resolveOutput = z.object({
  name: z.string().nullable(),
  address: z.string().nullable(),
  chainId: z.string(),
  addresses: z.array(
    z.object({
      coinType: z.number(),
      chainId: z.string().optional(),
      default: z.boolean().optional(),
      address: z.string(),
    })
  ),
  reason: reason.optional(),
  summary: z.string(),
});
type Resolved = z.infer<typeof resolveOutput>;
type Reason = z.infer<typeof reason>;

const forwardBody = z.object({
  result: z.object({
    data: z.object({ records: z.object({ addresses: z.array(z.object({ id: z.number(), value: z.string() })) }) }),
  }),
});
const reverseBody = z.object({ result: z.object({ data: z.object({ name: z.string().nullable() }) }) });

export type ResolveDeps = { fetch: typeof fetch; url: string; apiKey: string; timeoutMs: number };

const liveDeps = (): ResolveDeps => ({
  fetch: safeFetch(config().insecureFetchHosts),
  url: config().resolveUrl,
  apiKey: config().resolveApiKey ?? '',
  timeoutMs: 8_000,
});

const unresolved = (why: Reason, summary: string, name: string | null = null, address: string | null = null) =>
  resolveOutput.parse({ name, address, chainId: MAINNET, addresses: [], reason: why, summary });

const failed = () => unresolved('lookup_failed', 'The lookup could not finish right now. Try again.');

// ENSIP-11: an EVM chain's coin type is 0x80000000 | chainId, mainnet keeps the legacy 60, and
// 0x80000000 alone is the default for every EVM chain without its own record (ENSIP-19).
// Other coin types hold raw ENSIP-9 bytes, not an address to send to, so they are dropped.
function entryOf(coinType: number, value: string): Resolved['addresses'][number] | undefined {
  if (coinType !== MAINNET_COIN && coinType < EVM_FLAG) return undefined;
  if (!isAddress(value, { strict: false })) return undefined;
  const address = getAddress(value);
  if (coinType === MAINNET_COIN) return { coinType, chainId: MAINNET, address };
  if (coinType === EVM_FLAG) return { coinType, default: true, address };
  return { coinType, chainId: `eip155:${coinType - EVM_FLAG}`, address };
}

// A key the backend does not take is this server's setting, not the caller's input.
const KEY_REFUSED = new Set([401, 402, 403]);

type Answer = { status: number; body: unknown } | undefined;

async function ask(path: string, query: Record<string, string>, deps: ResolveDeps): Promise<Answer> {
  try {
    const res = await deps.fetch(`${deps.url}/${path}?${new URLSearchParams(query)}`, {
      headers: { 'x-api-key': deps.apiKey },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  } catch (err) {
    log('warn', { msg: 'ens lookup unreachable', error: errorLabel(err) });
    return undefined;
  }
}

function refused(path: string, status: number) {
  log(KEY_REFUSED.has(status) ? 'error' : 'warn', { msg: 'ens backend did not answer the lookup', path, status });
  return failed();
}

async function addressOf(name: string, deps: ResolveDeps): Promise<Resolved> {
  const answer = await ask('resolve', { ens: name }, deps);
  if (!answer) return failed();
  // The name uses JustaName's resolver but its domain is not onboarded.
  if (answer.status === 404) return unresolved('no_address', `${name} has no address.`, name);
  if (answer.status !== 200) return refused('resolve', answer.status);
  const body = forwardBody.safeParse(answer.body);
  if (!body.success) return failed();
  const addresses = body.data.result.data.records.addresses
    .map((a) => entryOf(a.id, a.value))
    .filter((a) => a !== undefined);
  if (addresses.length === 0) return unresolved('no_address', `${name} has no address.`, name);
  const mainnet = addresses.find((a) => a.coinType === MAINNET_COIN)?.address ?? null;
  const ethereum = chainName(MAINNET_ID);
  const others = whereOf(addresses.filter((a) => a.coinType !== MAINNET_COIN));
  const summary = mainnet
    ? `${name} resolves to ${mainnet} on ${ethereum}.${others ? ` It also has an address on ${others}.` : ''}`
    : `${name} has no ${ethereum} address. It has an address on ${others}.`;
  return resolveOutput.parse({ name, address: mainnet, chainId: MAINNET, addresses, summary });
}

/** Where a name has an address, for the owner: each network by name, the default entry last as every other one. */
function whereOf(entries: Resolved['addresses']): string {
  const named = entries.flatMap((a) => (a.chainId ? [networkName(Number(a.chainId.split(':')[1]))] : []));
  return listed(entries.some((a) => a.default) ? [...named, 'every other network'] : named);
}

async function nameOf(address: string, deps: ResolveDeps): Promise<Resolved> {
  const owner = getAddress(address);
  const answer = await ask('reverse', { address: owner, coinType: String(MAINNET_COIN) }, deps);
  if (!answer) return failed();
  if (answer.status !== 200) return refused('reverse', answer.status);
  const body = reverseBody.safeParse(answer.body);
  if (!body.success) return failed();
  // The backend answers a name only when it resolves back to the address.
  const { name } = body.data.result.data;
  if (!name) return unresolved('no_primary_name', `${owner} has no primary name.`, null, owner);
  const addresses = [{ coinType: MAINNET_COIN, chainId: MAINNET, address: owner }];
  return resolveOutput.parse({ name, address: owner, chainId: MAINNET, addresses, summary: `${owner} is ${name}.` });
}

export async function lookup(input: { name: string } | { address: string }, deps = liveDeps()): Promise<Resolved> {
  if ('address' in input) {
    if (!isAddress(input.address, { strict: false }))
      return unresolved('invalid_address', 'That is not a valid address.');
    return nameOf(input.address, deps);
  }
  let name: string;
  try {
    name = normalize(input.name);
  } catch {
    return unresolved('invalid_name', `"${input.name.slice(0, 100)}" is not a valid ENS name.`);
  }
  return addressOf(name, deps);
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
        'owner gives a name as a recipient, before building the transfer. A name answers `address` (its Ethereum one) ' +
        'and `addresses`, one per network it has an address on: use the one for the network you are sending on, or ' +
        'the entry with `default: true` when that network has none, and if neither exists tell the owner the name has ' +
        'no address there. Show the owner the name and the address before sending, and never guess an address from a ' +
        'name. Use the reverse lookup to show a friendly name for an address in a history or a permission. Only EVM ' +
        'addresses are returned. Pass exactly one of name or address. A reason says why nothing came back.',
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
