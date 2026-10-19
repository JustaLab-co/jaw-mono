import type { McpServer } from '@modelcontextprotocol/server';
import {
  BaseError,
  ContractFunctionZeroDataError,
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
const OUTPUT_MAX = 100_000;
const DEPTH_MAX = 32;
const PARAMS_MAX = 2000;

const cut = (what: string) => `[truncated: ${what}]`;

function text(source: string, v: string) {
  const fenced = fenceText(source, v, TEXT_MAX);
  return v.length > TEXT_MAX ? `${fenced}\n${cut(`${v.length} characters in all`)}` : fenced;
}

// JSON has no bigint, so integers come back as decimal strings. Any other string is the contract's
// own text and is fenced, except hex (addresses, bytes), which cannot carry instructions.
function leaf(v: unknown, source: string): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'string') return v;
  if (!isHex(v)) return text(source, v);
  return v.length > TEXT_MAX ? `${v.slice(0, TEXT_MAX)}${cut(`${(v.length - 2) / 2} bytes in all`)}` : v;
}

type Budget = { left: number };

function capped(v: unknown, source: string, budget: Budget): unknown {
  if (budget.left <= 0) return cut(`the reply reached ${OUTPUT_MAX} characters`);
  if (Array.isArray(v)) {
    const shown: unknown[] = [];
    for (const x of v) {
      if (budget.left <= 0) {
        shown.push(cut(`${v.length - shown.length} more items`));
        break;
      }
      shown.push(capped(x, source, budget));
    }
    return shown;
  }
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capped(x, source, budget)]));
  const out = leaf(v, source);
  budget.left -= String(out).length;
  return out;
}

const functionsOf = (r: Read) => (r.abi as unknown as Abi).filter((item) => item.type === 'function');

type Param = { components?: unknown } | null;

// The walk stops at DEPTH_MAX, so a hostile ABI cannot exhaust the stack here or in viem's coder.
function shapeError(r: Read): string | undefined {
  let params = 0;
  const walk = (list: unknown, depth: number): string | undefined => {
    if (!Array.isArray(list)) return undefined;
    if (depth > DEPTH_MAX) return `its ABI is nested more than ${DEPTH_MAX} levels deep`;
    params += list.length;
    if (params > PARAMS_MAX) return `its ABI has more than ${PARAMS_MAX} parameters`;
    for (const p of list as Param[]) {
      const error = walk(p?.components, depth + 1);
      if (error) return error;
    }
    return undefined;
  };
  for (const item of r.abi) {
    if (item.type !== 'function') continue;
    const error = walk(item.inputs, 1) ?? walk(item.outputs, 1);
    if (error) return error;
  }
  return undefined;
}

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

const walks = (error: Error, match: (e: unknown) => boolean) => error instanceof BaseError && !!error.walk(match);

// With allowFailure, a failed request to the RPC is copied onto every read instead of thrown.
const unreachable = (error: Error) =>
  walks(error, (e) => e instanceof HttpRequestError || e instanceof RpcRequestError || e instanceof TimeoutError);

function failure(error: Error, read: Read, source: string) {
  if (walks(error, (e) => e instanceof ContractFunctionZeroDataError))
    return `${read.address} returned no data: it is not a contract that has ${read.functionName}.`;
  return text(source, messageOf(error));
}

/** Runs the reads in one multicall. A read that fails carries its own error and does not stop the others. */
export async function readContracts(args: { chainId: number; reads: Read[] }, clientFor: ClientFor = proxyClientFor) {
  const { chainId, reads } = args;
  const chains = proxyChains().map((c) => c.id);
  if (!chains.includes(chainId))
    return refusal(`Chain ${chainId} is not one JAW supports. Supported: ${chains.join(', ')}.`);
  for (const [i, r] of reads.entries()) {
    const error = shapeError(r);
    if (error) return refusal(`Read ${i}: ${error}.`);
  }
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
      abi: functionsOf(r),
      functionName: r.functionName,
      args: r.args,
    })),
    allowFailure: true,
  });
  if (settled.some((s) => s.status === 'failure' && unreachable(s.error)))
    return refusal(`The RPC for chain ${chainId} is unavailable, so nothing was read. Try again shortly.`);
  const budget = { left: OUTPUT_MAX };
  const results = settled.map((s, i) => {
    const source = `${reads[i].address} on ${chainId}`;
    return s.status === 'success'
      ? { ok: true as const, value: capped(s.result, source, budget) }
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
