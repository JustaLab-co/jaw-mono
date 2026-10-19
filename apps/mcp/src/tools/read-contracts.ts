import type { McpServer } from '@modelcontextprotocol/server';
import {
  BaseError,
  encodeFunctionData,
  getAbiItem,
  HttpRequestError,
  isHex,
  RpcRequestError,
  TimeoutError,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import { z } from 'zod';
import { proxyChains, proxyClientFor } from '@/lib/chain';
import { fenceText, reply } from '@/lib/fence';
import { refusal } from './reply';

const MAX_READS = 100;

const readInput = z.strictObject({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  abi: z.array(z.record(z.string(), z.unknown())).min(1).describe('ABI fragment holding the function'),
  functionName: z.string(),
  args: z.array(z.unknown()).optional().describe('Arguments in ABI order. Pass uint values as decimal strings'),
});

const input = z.strictObject({
  chainId: z.number().int().positive().describe('Any chain JAW supports'),
  reads: z.array(readInput).min(1).max(MAX_READS),
});

const result = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.unknown().describe('Decoded; integers as decimal strings, text fenced as untrusted'),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const output = z.object({
  chainId: z.number(),
  results: z.array(result).describe('One per read, in order'),
  summary: z.string(),
});

export type Read = z.infer<typeof readInput>;
export type ClientFor = (chainId: number) => PublicClient;

const TEXT_MAX = 2000;

// JSON has no bigint, so integers come back as decimal strings. Any other string is the contract's
// own text and is fenced, except hex (addresses, bytes), which cannot carry instructions.
function plain(v: unknown, source: string): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return isHex(v) ? v : fenceText(source, v, TEXT_MAX);
  if (Array.isArray(v)) return v.map((x) => plain(x, source));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x, source)]));
  return v;
}

const abiOf = (r: Read) => r.abi as unknown as Abi;
const functionsOf = (r: Read) => abiOf(r).filter((item) => item.type === 'function');

// A hex name is matched as a selector, which throws on a fragment with no inputs.
function hasFunction(r: Read) {
  try {
    return !!getAbiItem({ abi: functionsOf(r), name: r.functionName });
  } catch {
    return false;
  }
}

const messageOf = (error: Error) => (error as { shortMessage?: string }).shortMessage ?? error.message;

// multicall swallows an encoding error and sends 0x, which then reads as "returned no data".
function encodeError(r: Read) {
  try {
    encodeFunctionData({ abi: functionsOf(r), functionName: r.functionName, args: r.args });
  } catch (e) {
    return messageOf(e as Error);
  }
  return undefined;
}

// With allowFailure, a failed request to the RPC is copied onto every read instead of thrown.
const unreachable = (error: Error) =>
  error instanceof BaseError &&
  !!error.walk((e) => e instanceof HttpRequestError || e instanceof RpcRequestError || e instanceof TimeoutError);

function failure(error: Error, read: Read, source: string) {
  const message = messageOf(error);
  if (message.includes('returned no data'))
    return `${read.address} returned no data: it is not a contract that has ${read.functionName}.`;
  return fenceText(source, message, TEXT_MAX);
}

/** Runs the reads in one multicall. A read that fails carries its own error and does not stop the others. */
export async function readContracts(args: { chainId: number; reads: Read[] }, clientFor: ClientFor = proxyClientFor) {
  const { chainId, reads } = args;
  const chains = proxyChains().map((c) => c.id);
  if (!chains.includes(chainId))
    return refusal(`Chain ${chainId} is not one JAW supports. Supported: ${chains.join(', ')}.`);
  const lacking = reads.findIndex((r) => !hasFunction(r));
  if (lacking !== -1)
    return refusal(`Read ${lacking}: the ABI has no function named "${reads[lacking].functionName}".`);
  for (const [i, r] of reads.entries()) {
    const error = encodeError(r);
    if (error) return refusal(`Read ${i}: its args do not encode. ${error}`);
  }

  const client = clientFor(chainId);
  if (!client.chain?.contracts?.multicall3)
    return refusal(`Chain ${chainId} has no multicall contract to batch reads.`);
  const settled = await client.multicall({
    contracts: reads.map((r) => ({
      address: r.address as Address,
      abi: abiOf(r),
      functionName: r.functionName,
      args: r.args,
    })),
    allowFailure: true,
  });
  if (settled.some((s) => s.status === 'failure' && unreachable(s.error)))
    return refusal(`The RPC for chain ${chainId} is unavailable, so nothing was read. Try again shortly.`);
  const results = settled.map((s, i) => {
    const source = `${reads[i].address} on ${chainId}`;
    return s.status === 'success'
      ? { ok: true as const, value: plain(s.result, source) }
      : { ok: false as const, error: failure(s.error, reads[i], source) };
  });
  const returned = results.filter((r) => r.ok).length;
  return reply(output.parse({ chainId, results, summary: `${returned} of ${results.length} reads returned.` }));
}

export function registerReadContractsTool(server: McpServer) {
  server.registerTool(
    'jaw_read_contracts',
    {
      description:
        'Read view functions of any contracts on a chain JAW supports, in one batch. Each read is an address, an ABI fragment, a function name and its args. Returns the decoded value of each, or an error for that read alone. Changes nothing and needs no budget.',
      inputSchema: input,
      outputSchema: output,
      annotations: { readOnlyHint: true },
    },
    async (args) => readContracts(args)
  );
}
