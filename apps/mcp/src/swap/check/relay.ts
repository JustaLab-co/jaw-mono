import { hashStruct, pad, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { MAX_ROUTE_COST_BPS, TESTNET_MAX_ROUTE_COST_BPS, type RelayContracts } from '../allowlist';
import type { BackendQuote, CheckCode, QuoteRequest } from '../check';
import { amountsCode, floorCode, routeOf } from './shared';

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
  .transform(BigInt)
  .refine((n) => n < 2n ** 256n);
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
const MAX_ORDER_LIFETIME_SEC = 7 * 86_400 + 3_600;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function checkRelayOrder(request: QuoteRequest, quote: BackendQuote, now: number): RelayOrderResult {
  const fail = (code: CheckCode) => ({ ok: false as const, code });

  if (!relayQuoteId.test(quote.quoteId) || quote.deposit !== undefined) return fail('quote_id');
  const amounts = amountsCode(request, quote);
  if (amounts) return fail(amounts);

  const route = routeOf(request, 'relay');
  if (!route.ok) return route;
  const { origin, destination } = route;
  if (request.originChainId === request.destinationChainId) return fail('destination_chain');

  const maxCostBps = origin.testnet ? TESTNET_MAX_ROUTE_COST_BPS : MAX_ROUTE_COST_BPS;
  const floor = floorCode(request, BigInt(quote.minOutputAmount), maxCostBps);
  if (floor) return fail(floor);

  if (quote.relayOrder === undefined) return fail('order_missing');
  const parsed = relayOrder.safeParse(quote.relayOrder);
  if (!parsed.success) return fail('order_terms');
  const order = parsed.data.orderData;
  const orderId = idOf(order);
  if (orderId !== parsed.data.orderId.toLowerCase()) return fail('order_id');

  const code = termsCode(request, quote, order, {
    from: origin.relay,
    to: destination.relay,
    testnet: origin.testnet === true,
  });
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
  { from, to, testnet }: { from: RelayContracts; to: RelayContracts; testnet: boolean }
): CheckCode | undefined {
  const toRouter = (data: Hex, relay: RelayContracts) =>
    same(data, pad(relay.erc20Router)) || (testnet && data === '0x');

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
    if (!side || !same(refund.currency, side.token)) return 'refund_terms';
    if (!toRouter(refund.extraData, side.relay)) return 'router_mismatch';
  }
  if (new Set(refunds.map((refund) => refund.chainId)).size !== refunds.length) return 'refund_terms';

  const { output } = order;
  const [paid] = output.payments;
  if (output.chainId !== to.protocolChain) return 'destination_chain';
  if (!toRouter(output.extraData, to)) return 'router_mismatch';
  if (!same(paid.recipient, request.recipient)) return 'recipient';
  if (!same(paid.currency, request.destinationToken)) return 'output_token';
  if (paid.minimumAmount !== BigInt(quote.minOutputAmount)) return 'output_amount';
  if (paid.expectedAmount !== BigInt(quote.expectedOutputAmount)) return 'output_amount';

  const solverSide = sides.find(({ relay }) => relay.protocolChain === order.solverChainId);
  if (!solverSide) return 'order_terms';
  if (!solverSide.relay.solvers.some((solver) => same(solver, order.solver))) return 'solver_unknown';

  if (output.calls.length !== 0) return 'order_calls';
  return undefined;
}
