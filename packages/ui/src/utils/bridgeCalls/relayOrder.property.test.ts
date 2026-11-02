import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { getAddress, hashStruct, toHex } from 'viem';
import { readBridgeBatch } from './batch';
import { BRIDGE_CHAINS } from './contracts';
import {
  RELAY_OTHER_RECIPIENT_APPROVE,
  RELAY_OTHER_RECIPIENT_DEPOSIT,
  RELAY_OTHER_RECIPIENT_DEPOSITOR,
  RELAY_OTHER_RECIPIENT_ORDER,
} from './fixtures';
import { ORDER_TYPES } from './relayOrder';
import { BridgeContracts } from './table';
import type { BridgeCall } from './view';

const contracts = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS });
const ACCOUNT = getAddress(RELAY_OTHER_RECIPIENT_DEPOSITOR);
const RECIPIENT = getAddress(RELAY_OTHER_RECIPIENT_ORDER.output.payments[0].recipient);
const THIRD = getAddress('0x1111111111111111111111111111111111111111');
const CHAIN_NAME: Record<string, string> = { base: 'Base', arbitrum: 'Arbitrum' };
const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';

type Order = typeof RELAY_OTHER_RECIPIENT_ORDER;

const withId = (order: Order): BridgeCall => {
  const id = hashStruct({ types: ORDER_TYPES, primaryType: 'Order', data: order as never });
  return {
    ...RELAY_OTHER_RECIPIENT_DEPOSIT,
    data: (RELAY_OTHER_RECIPIENT_DEPOSIT.data ?? '').slice(0, -64) + id.slice(2),
  };
};
const read = (order: unknown, deposit: BridgeCall) =>
  readBridgeBatch(contracts, [RELAY_OTHER_RECIPIENT_APPROVE, deposit], ACCOUNT, { optional: true, orderData: order });

const spelling = (address: string) =>
  fc.constantFrom(address.toLowerCase(), getAddress(address), `0x${address.slice(2).toUpperCase()}`);
const party = fc.oneof(spelling(ACCOUNT), spelling(RECIPIENT), spelling(THIRD));

describe('a Relay order whose refunds go to any mix of addresses, hashed into the deposit', () => {
  it('shows the destination, the recipient and the minimum, one refund row per chain, and warns about every address that is not this account', () => {
    fc.assert(
      fc.property(party, party, (baseRefund, arbitrumRefund) => {
        const order = structuredClone(RELAY_OTHER_RECIPIENT_ORDER);
        order.inputs[0].refunds[0].recipient = baseRefund;
        order.inputs[0].refunds[1].recipient = arbitrumRefund;
        const batch = read(order, withId(order));
        const transfer = batch?.transfer;

        expect(transfer?.title).toBe('Bridge to Arbitrum');
        expect(transfer?.otherRecipient).toBe(RECIPIENT);
        expect(transfer?.receive).toMatchObject({ kind: 'minimum', amount: { chainId: 42161, amount: 1_910_824n } });
        expect(batch?.notices).not.toContain(RELAY_HIDDEN);

        const refunds = order.inputs[0].refunds.map((refund) => ({
          chain: CHAIN_NAME[refund.chainId],
          to: getAddress(refund.recipient),
        }));
        const rows = transfer?.details.filter((row) => row.label.startsWith('Refund')) ?? [];
        const oneAddress = refunds[0].to === refunds[1].to;
        expect(rows.map((row) => [row.label, row.copy])).toEqual(
          oneAddress ? [['Refund to', refunds[0].to]] : refunds.map(({ chain, to }) => [`Refund on ${chain}`, to])
        );

        const printed =
          transfer?.details.flatMap((row) => (row.copy?.length === 42 ? [getAddress(row.copy)] : [])) ?? [];
        for (const address of printed.filter((a) => a !== ACCOUNT)) {
          expect(batch?.notices.some((notice) => notice.includes(address))).toBe(true);
        }
      }),
      { numRuns: 60 }
    );
  });
});

describe('an order that disagrees with the deposit or with itself', () => {
  const edits: [string, (order: Order) => void][] = [
    ['recipient', (o) => (o.output.payments[0].recipient = THIRD.toLowerCase())],
    ['destination chain', (o) => (o.output.chainId = 'base')],
    ['minimum out', (o) => (o.output.payments[0].minimumAmount = '1')],
    ['a refund recipient', (o) => (o.inputs[0].refunds[1].recipient = THIRD.toLowerCase())],
    ['a refund chain', (o) => (o.inputs[0].refunds[0].chainId = 'arbitrum')],
  ];

  it('never shows a destination or a recipient when the order was changed after its id was taken', () => {
    fc.assert(
      fc.property(fc.constantFrom(...edits), ([, edit]) => {
        const order = structuredClone(RELAY_OTHER_RECIPIENT_ORDER);
        edit(order);
        const batch = read(order, RELAY_OTHER_RECIPIENT_DEPOSIT);
        expect(batch?.transfer?.title).toBe('Deposit to Relay');
        expect(batch?.transfer?.otherRecipient).toBeUndefined();
        expect(batch?.notices).toContain(RELAY_HIDDEN);
      })
    );
  });

  it('never shows a destination when a refund goes to a 32-byte recipient, even with a matching id', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), (at, bytes) => {
        const order = structuredClone(RELAY_OTHER_RECIPIENT_ORDER);
        order.inputs[0].refunds[at].recipient = toHex(bytes);
        const batch = read(order, withId(order));
        expect(batch?.transfer?.title).toBe('Deposit to Relay');
        expect(batch?.notices).toContain(RELAY_HIDDEN);
      }),
      { numRuns: 30 }
    );
  });

  it('never throws and never shows a destination for any other value in place of the order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (orderData) => {
        const batch = read(orderData, RELAY_OTHER_RECIPIENT_DEPOSIT);
        expect(batch?.transfer?.title).toBe('Deposit to Relay');
        expect(batch?.transfer?.otherRecipient).toBeUndefined();
      })
    );
  });
});
