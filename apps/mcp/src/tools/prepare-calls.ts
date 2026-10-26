import type { McpServer } from '@modelcontextprotocol/server';
import { encodeFunctionData, isAddress, parseAbiItem, type AbiFunction, type Hex } from 'viem';
import { z } from 'zod';
import { reply } from '@/lib/fence';
import { counted } from '@/lib/owner-text';
import { callInput, MAX_CALLS } from './owner-calls';
import { refusal, withNext } from './reply';

const action = z.strictObject({
  to: callInput.shape.to.describe('The contract address, checksummed or all lowercase'),
  function: z.string().describe('Its signature, such as "transfer(address to, uint256 amount)"'),
  args: z.array(z.unknown()).describe('The arguments in order, numbers as decimal strings'),
  value: callInput.shape.value,
});

const input = z.strictObject({
  actions: z.array(action).min(1).max(MAX_CALLS),
});

const output = z.object({
  calls: z
    .array(z.object({ to: z.string(), data: z.string(), value: z.string() }))
    .describe('One per action, in order, as jaw_send_calls takes them'),
  summary: z.string(),
});

export type PrepareCallsInput = z.infer<typeof input>;
type Action = z.infer<typeof action>;

const NOT_FILLED = 'The request could not be filled in. Nothing was sent.';

const messageOf = (error: Error) => (error as { shortMessage?: string }).shortMessage ?? error.message;

/** The action's calldata, or why it cannot be built. */
function encode(a: Action): { data: Hex } | { error: string } {
  let fn: AbiFunction;
  try {
    fn = parseAbiItem(`function ${a.function.trim().replace(/^function\s+/, '')}`) as AbiFunction;
  } catch {
    return { error: 'its function is not a signature, such as "transfer(address to, uint256 amount)".' };
  }
  try {
    return { data: encodeFunctionData({ abi: [fn], functionName: fn.name, args: a.args }) };
  } catch (e) {
    return { error: `its arguments do not fit ${fn.name}: ${messageOf(e as Error)}` };
  }
}

/** Builds each action's calldata from its function and arguments. Nothing is sent: jaw_send_calls asks the owner. */
export function prepareCalls({ actions }: PrepareCallsInput) {
  const calls: { to: string; data: Hex; value: string }[] = [];
  for (const [i, a] of actions.entries()) {
    // A wrong checksum caught a made-up contract address in testing.
    if (!isAddress(a.to)) {
      return refusal(
        withNext(
          NOT_FILLED,
          `Action ${i + 1}: ${a.to} has a wrong checksum, so it was likely mistyped or made up. Look the address up again rather than guessing.`
        )
      );
    }
    const built = encode(a);
    if ('error' in built) return refusal(withNext(NOT_FILLED, `Action ${i + 1}: ${built.error}`));
    calls.push({ to: a.to, data: built.data, value: a.value ?? '0' });
  }
  return reply(
    output.parse({
      calls,
      summary: withNext(
        `Filled in ${counted(calls.length, 'action')}, ready to send to the wallet for approval. Nothing was sent.`,
        'Check these calls with jaw_simulate_calls, then pass them as they are to jaw_send_calls.'
      ),
    })
  );
}

export function registerPrepareCallsTool(server: McpServer) {
  server.registerTool(
    'jaw_prepare_calls',
    {
      title: 'Fill in a transaction',
      description:
        `Fill in one or more actions for the owner's own JAW wallet so they can review them and send them themselves: a transfer, a deposit into a lending market, a trade, any contract function, up to ${MAX_CALLS} on one network, run together. ` +
        'Describe each action as the contract function and its arguments, such as function "supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)" with args ["0x8335…", "10000000", "0x…", 0]; this builds the transaction from them. ' +
        "Amounts are in the token's smallest unit. " +
        'Returns the actions filled in for the wallet, where the owner checks them and confirms with their passkey; nothing is sent unless they do. ' +
        'Check the balance first. The result says what to do next.',
      inputSchema: input,
      outputSchema: output,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => prepareCalls(args)
  );
}
