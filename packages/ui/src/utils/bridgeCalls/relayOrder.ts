import { hashStruct, isAddressEqual, pad, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { BRIDGE_CHAINS, type RelayContracts } from './contracts';
import type { RelayDeposit } from './relay';
import { pinnedToken, tokenAmount, type TokenAmount } from './view';

export const ORDER_TYPES = {
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

const MAX_ORDER_CHARS = 32_768;

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

const orderSchema = z.strictObject({
  version: z.string(),
  solverChainId: z.string(),
  solver: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((s) => s.toLowerCase() as Address),
  salt: uint,
  inputs: z.array(
    z.strictObject({
      payment: z.strictObject({ chainId: z.string(), currency: bytes, amount: uint, weight: uint }),
      refunds: z.array(
        z.strictObject({
          chainId: z.string(),
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
    chainId: z.string(),
    payments: z.array(z.strictObject({ recipient: bytes, currency: bytes, minimumAmount: uint, expectedAmount: uint })),
    deadline: uint32,
    calls: z.array(bytes),
    extraData: bytes,
  }),
  fees: z.array(
    z.strictObject({
      recipientChainId: z.string(),
      recipient: bytes,
      currencyChainId: z.string(),
      currency: bytes,
      amount: uint,
    })
  ),
});

type Order = z.infer<typeof orderSchema>;

export type RelayOrder = {
  kind: 'order';
  destinationChainId: number;
  recipient: Address;
  minimumReceived: TokenAmount;
  refundTo: Address;
};
export type OrderUnshown = { kind: 'unshown'; reason: string };

const unshown = (reason: string): OrderUnshown => ({ kind: 'unshown', reason });
const includes = (what: string) => unshown(`This Relay order includes ${what}, so its terms are not shown.`);
const MISMATCH = unshown('The Relay order details do not match this deposit, so this screen does not show them.');
const UNKNOWN_ROUTE = unshown(
  'This Relay order uses a solver or route this screen does not recognize, so its terms are not shown.'
);
const isAddress = (hex: Hex): hex is Address => hex.length === 42;
const sameBytes = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

export function readRelayOrder(capability: unknown, deposit: RelayDeposit): RelayOrder | OrderUnshown | undefined {
  if (capability === undefined) return undefined;
  const data = (capability as { orderData?: unknown } | null)?.orderData;
  if (tooLarge(data)) return MISMATCH;

  const parsed = orderSchema.safeParse(data);
  if (!parsed.success) return MISMATCH;
  const order = parsed.data;
  if (hashStruct({ types: ORDER_TYPES, primaryType: 'Order', data: order }) !== deposit.orderId) {
    return MISMATCH;
  }
  if (order.inputs.length !== 1) return undefined;
  const { payment } = order.inputs[0];
  const origin = BRIDGE_CHAINS[deposit.send.chainId].relay?.protocolChain;
  if (payment.chainId !== origin || !sameBytes(payment.currency, deposit.send.token.address)) return MISMATCH;
  if (payment.amount !== deposit.send.amount) return MISMATCH;
  if (!knownRoute(order, payment.chainId)) return UNKNOWN_ROUTE;
  return termsOf(order);
}

const relayOf = (protocolChain: string): RelayContracts | undefined =>
  Object.values(BRIDGE_CHAINS).find((chain) => chain.relay?.protocolChain === protocolChain)?.relay;

function knownRoute(order: Order, origin: string): boolean {
  const sides = [origin, order.output.chainId];
  const routeOf = (chain: string) => (sides.includes(chain) ? relayOf(chain) : undefined);
  const testnet = relayOf(origin)?.testnet === true;
  const viaRouter = (chain: string, extraData: Hex) => {
    const route = routeOf(chain);
    if (!route) return false;
    return sameBytes(extraData, pad(route.erc20Router)) || (testnet && extraData === '0x');
  };
  const solvers = routeOf(order.solverChainId)?.solvers ?? [];
  return (
    solvers.some((solver) => isAddressEqual(solver, order.solver)) &&
    viaRouter(order.output.chainId, order.output.extraData) &&
    order.inputs[0].refunds.every((refund) => viaRouter(refund.chainId, refund.extraData))
  );
}

function termsOf(order: Order): RelayOrder | OrderUnshown | undefined {
  const { output, fees } = order;
  if (order.version !== 'v1') return undefined;
  if (output.calls.length !== 0) return includes('destination calls');
  if (fees.length !== 0) return includes('fees');
  if (output.payments.length !== 1) return includes('more than one payment');
  const [{ recipient, currency: paid, minimumAmount }] = output.payments;
  const currency = paid.toLowerCase() as Hex;
  const refundTo = order.inputs[0].refunds.map((refund) => refund.recipient.toLowerCase() as Hex);
  const destination = Object.keys(BRIDGE_CHAINS)
    .map(Number)
    .find((chainId) => BRIDGE_CHAINS[chainId].relay?.protocolChain === output.chainId);
  if (destination === undefined || !isAddress(recipient)) return undefined;
  if (!isAddress(currency) || (currency !== zeroAddress && !pinnedToken(destination, currency))) {
    return includes('an unrecognized token');
  }
  if (new Set(refundTo).size !== 1 || !isAddress(refundTo[0])) return undefined;
  return {
    kind: 'order',
    destinationChainId: destination,
    recipient,
    minimumReceived: tokenAmount(destination, currency, minimumAmount),
    refundTo: refundTo[0],
  };
}

function tooLarge(data: unknown): boolean {
  try {
    return (JSON.stringify(data) ?? '').length > MAX_ORDER_CHARS;
  } catch {
    return true;
  }
}
