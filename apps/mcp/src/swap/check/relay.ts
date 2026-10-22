import { hashStruct, pad, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { ALLOWLIST, type RelayContracts } from '../allowlist';
import type { BackendQuote, CheckCode, QuoteRequest } from '../check';
import { clearsFloor, sameAsset } from './assets';

// EIP-712 types of a Relay order, from relay-settlement packages/sdk/src/order/index.ts.
const ORDER_TYPES = {
  Order: [
    { name: 'version', type: 'string' },
    { name: 'solverChainId', type: 'string' },
    { name: 'solver', type: 'address' },
    { name: 'salt', type: 'uint256' },
    { name: 'inputs', type: 'Input[]' },
    { name: 'output', type: 'Output' },
    { name: 'fees', type: 'Fee[]' },
  ],
  Input: [
    { name: 'payment', type: 'InputPayment' },
    { name: 'refunds', type: 'InputRefund[]' },
  ],
  InputPayment: [
    { name: 'chainId', type: 'string' },
    { name: 'currency', type: 'bytes' },
    { name: 'amount', type: 'uint256' },
    { name: 'weight', type: 'uint256' },
  ],
  InputRefund: [
    { name: 'chainId', type: 'string' },
    { name: 'recipient', type: 'bytes' },
    { name: 'currency', type: 'bytes' },
    { name: 'minimumAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint32' },
    { name: 'extraData', type: 'bytes' },
  ],
  Output: [
    { name: 'chainId', type: 'string' },
    { name: 'payments', type: 'OutputPayment[]' },
    { name: 'deadline', type: 'uint32' },
    { name: 'calls', type: 'bytes[]' },
    { name: 'extraData', type: 'bytes' },
  ],
  OutputPayment: [
    { name: 'recipient', type: 'bytes' },
    { name: 'currency', type: 'bytes' },
    { name: 'minimumAmount', type: 'uint256' },
    { name: 'expectedAmount', type: 'uint256' },
  ],
  Fee: [
    { name: 'recipientChainId', type: 'string' },
    { name: 'recipient', type: 'bytes' },
    { name: 'currencyChainId', type: 'string' },
    { name: 'currency', type: 'bytes' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

const bytes = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/)
  .transform((s) => s as Hex);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/)
  .transform(BigInt);
const uint32 = z.number().int().min(0).max(0xffffffff);
const chain = z.string();

const orderData = z.strictObject({
  version: z.string(),
  solverChainId: chain,
  solver: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((s) => s.toLowerCase() as Address),
  salt: uint,
  inputs: z.array(
    z.strictObject({
      payment: z.strictObject({ chainId: chain, currency: bytes, amount: uint, weight: uint }),
      refunds: z.array(
        z.strictObject({
          chainId: chain,
          recipient: bytes,
          currency: bytes,
          minimumAmount: uint,
          deadline: uint32,
          extraData: bytes,
        })
      ),
    })
  ),
  output: z.strictObject({
    chainId: chain,
    payments: z.array(z.strictObject({ recipient: bytes, currency: bytes, minimumAmount: uint, expectedAmount: uint })),
    deadline: uint32,
    calls: z.array(bytes),
    extraData: bytes,
  }),
  fees: z.array(
    z.strictObject({
      recipientChainId: chain,
      recipient: bytes,
      currencyChainId: chain,
      currency: bytes,
      amount: uint,
    })
  ),
});

const relayOrder = z.strictObject({
  orderId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  orderData,
});

type OrderData = z.infer<typeof orderData>;

const idOf = (order: OrderData) => hashStruct({ types: ORDER_TYPES, primaryType: 'Order', data: order });

/** The orderId Relay's Depository commits to, or undefined when the data is not a Relay order. */
export function relayOrderId(data: unknown): Hex | undefined {
  const parsed = orderData.safeParse(data);
  return parsed.success ? idOf(parsed.data) : undefined;
}

export type RelayOrderResult = { ok: true; orderId: Hex; deadline: number } | { ok: false; code: CheckCode };

const relayQuoteId = /^relay:0x[0-9a-fA-F]{64}$/;
const baseUnits = /^[1-9][0-9]*$/;
const MAX_ORDER_LIFETIME_SEC = 7 * 86_400 + 3_600;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const routerData = (relay: RelayContracts) => pad(relay.erc20Router);

export function checkRelayOrder(request: QuoteRequest, quote: BackendQuote, now: number): RelayOrderResult {
  const fail = (code: CheckCode) => ({ ok: false as const, code });

  if (!relayQuoteId.test(quote.quoteId) || quote.deposit !== undefined) return fail('quote_id');
  if (!baseUnits.test(request.amount) || quote.inputAmount !== request.amount) return fail('input_amount');
  const { expectedOutputAmount, minOutputAmount } = quote;
  if (!baseUnits.test(expectedOutputAmount) || !baseUnits.test(minOutputAmount)) return fail('output_amount');
  if (BigInt(minOutputAmount) > BigInt(expectedOutputAmount)) return fail('output_amount');

  const origin = ALLOWLIST[request.originChainId];
  const destination = ALLOWLIST[request.destinationChainId];
  if (!origin?.relay) return fail('unsupported_chain');
  if (!destination?.relay || origin.testnet !== destination.testnet) return fail('destination_chain');

  const pair = sameAsset(request);
  if (!pair) return fail('route_unsupported');
  if (!clearsFloor(request, BigInt(minOutputAmount), pair)) return fail('output_floor');

  if (quote.relayOrder === undefined) return fail('order_missing');
  const parsed = relayOrder.safeParse(quote.relayOrder);
  if (!parsed.success) return fail('order_terms');
  const order = parsed.data.orderData;
  const orderId = idOf(order);
  if (orderId !== parsed.data.orderId.toLowerCase()) return fail('order_id');

  const code = termsCode(request, quote, order, { from: origin.relay, to: destination.relay });
  if (code) return fail(code);
  const deadlines = [order.output.deadline, ...order.inputs[0].refunds.map((refund) => refund.deadline)];
  if (!deadlines.every((deadline) => now < deadline && deadline <= now + MAX_ORDER_LIFETIME_SEC)) {
    return fail('deadline');
  }
  return { ok: true, orderId, deadline: order.output.deadline };
}

function termsCode(
  request: QuoteRequest,
  quote: BackendQuote,
  order: OrderData,
  { from, to }: { from: RelayContracts; to: RelayContracts }
): CheckCode | undefined {
  if (order.version !== 'v1' || order.inputs.length !== 1 || order.fees.length !== 0) return 'order_terms';
  if (order.output.payments.length !== 1) return 'order_terms';

  const [{ payment, refunds }] = order.inputs;
  if (payment.chainId !== from.protocolChain || !same(payment.currency, request.originToken)) return 'input_amount';
  if (payment.amount !== BigInt(request.amount)) return 'input_amount';

  if (refunds.length === 0) return 'refund_terms';
  if (refunds.some((refund) => !same(refund.recipient, request.account))) return 'refund_recipient';
  const sides = [
    { relay: from, token: request.originToken },
    { relay: to, token: request.destinationToken },
  ];
  for (const refund of refunds) {
    const side = sides.find(({ relay }) => relay.protocolChain === refund.chainId);
    if (!side || !same(refund.currency, side.token) || !same(refund.extraData, routerData(side.relay))) {
      return 'refund_terms';
    }
  }
  if (new Set(refunds.map((refund) => refund.chainId)).size !== refunds.length) return 'refund_terms';

  const { output } = order;
  const [paid] = output.payments;
  if (output.chainId !== to.protocolChain) return 'destination_chain';
  if (!same(output.extraData, routerData(to))) return 'order_terms';
  if (!same(paid.recipient, request.recipient)) return 'recipient';
  if (!same(paid.currency, request.destinationToken)) return 'output_token';
  if (paid.minimumAmount !== BigInt(quote.minOutputAmount)) return 'output_amount';
  if (paid.expectedAmount !== BigInt(quote.expectedOutputAmount)) return 'output_amount';

  const solverChain = Object.values(ALLOWLIST).find(({ relay }) => relay?.protocolChain === order.solverChainId);
  if (!solverChain?.relay?.solvers.some((solver) => same(solver, order.solver))) return 'order_terms';

  if (output.calls.length !== 0) return 'order_calls';
  return undefined;
}
