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
const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';
const MISMATCH = 'The Relay order details do not match this deposit, so this screen does not show them.';
const UNKNOWN_ROUTE =
  'This Relay order uses a solver or route this screen does not recognize, so its terms are not shown.';
const notThisAccount = (who: string, address: string) => `${who} is not this account: ${getAddress(address)}.`;

type Order = typeof RELAY_OTHER_RECIPIENT_ORDER;
type Refund = Order['inputs'][0]['refunds'][0];

const REFUND_ON: Record<string, Refund> = {
  base: RELAY_OTHER_RECIPIENT_ORDER.inputs[0].refunds[0],
  arbitrum: RELAY_OTHER_RECIPIENT_ORDER.inputs[0].refunds[1],
};
const CHAIN_NAME: Record<string, string> = { base: 'Base', arbitrum: 'Arbitrum' };

const withId = (order: Order): BridgeCall => {
  const id = hashStruct({ types: ORDER_TYPES, primaryType: 'Order', data: order as never });
  return {
    ...RELAY_OTHER_RECIPIENT_DEPOSIT,
    data: (RELAY_OTHER_RECIPIENT_DEPOSIT.data ?? '').slice(0, -64) + id.slice(2),
  };
};
const read = (order: unknown, deposit: BridgeCall) =>
  readBridgeBatch(contracts, [RELAY_OTHER_RECIPIENT_APPROVE, deposit], ACCOUNT, { optional: true, orderData: order });
const change = (edit: (order: Order) => void): Order => {
  const order = structuredClone(RELAY_OTHER_RECIPIENT_ORDER);
  edit(order);
  return order;
};

const spelling = (address: string) =>
  fc.constantFrom(address.toLowerCase(), getAddress(address), `0x${address.slice(2).toUpperCase()}`);
const refund = fc.record({
  chain: fc.constantFrom('base', 'arbitrum'),
  to: fc.oneof(spelling(ACCOUNT), spelling(RECIPIENT), spelling(THIRD)),
});

describe('a Relay order with one to three refunds on any chains, to any addresses, hashed into the deposit', () => {
  it('shows its terms with one row per refund and the exact notices, or hides them when a chain repeats', () => {
    fc.assert(
      fc.property(fc.array(refund, { minLength: 1, maxLength: 3 }), (refunds) => {
        const order = change((o) => {
          o.inputs[0].refunds = refunds.map(({ chain, to }) => ({ ...REFUND_ON[chain], recipient: to }));
        });
        const batch = read(order, withId(order));

        if (new Set(refunds.map(({ chain }) => chain)).size !== refunds.length) {
          expect(batch?.transfer?.title).toBe('Deposit to Relay');
          expect(batch?.notices).toEqual([RELAY_HIDDEN]);
          return;
        }

        expect(batch?.transfer).toMatchObject({
          title: 'Bridge to Arbitrum',
          otherRecipient: RECIPIENT,
          receive: { kind: 'minimum', amount: { chainId: 42161, amount: 1_910_824n } },
        });
        const rows = batch?.transfer?.details.filter(({ label }) => label.startsWith('Refund')) ?? [];
        expect(rows).toEqual(
          refunds.map(({ chain, to }) => {
            const full = getAddress(to);
            return {
              label: `Refund on ${CHAIN_NAME[chain]}`,
              value: full === ACCOUNT ? 'This account' : full,
              copy: full,
            };
          })
        );
        const warned = refunds
          .filter(
            ({ chain, to }) => getAddress(to) !== ACCOUNT && !(chain === 'arbitrum' && getAddress(to) === RECIPIENT)
          )
          .map(({ to }) => notThisAccount('The refund address', to));
        expect(batch?.notices).toEqual([...new Set([notThisAccount('The recipient', RECIPIENT), ...warned])]);
      }),
      { numRuns: 120 }
    );
  });
});

describe('an order edited after the quote', () => {
  it.each([
    ['the recipient, under the old id', change((o) => (o.output.payments[0].recipient = THIRD.toLowerCase()))],
    ['a refund recipient, under the old id', change((o) => (o.inputs[0].refunds[1].recipient = THIRD.toLowerCase()))],
    ['the minimum out, under the old id', change((o) => (o.output.payments[0].minimumAmount = '1'))],
  ])('when it changes %s, then the mismatch shows and no terms', (_, order) => {
    const batch = read(order, RELAY_OTHER_RECIPIENT_DEPOSIT);
    expect(batch?.transfer?.title).toBe('Deposit to Relay');
    expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
  });

  it('when a refund moves to a chain outside the route and the id is taken again, then the route warning shows and no terms', () => {
    const order = change((o) => (o.inputs[0].refunds[0].chainId = 'optimism'));
    const batch = read(order, withId(order));
    expect(batch?.transfer?.title).toBe('Deposit to Relay');
    expect(batch?.notices).toEqual([UNKNOWN_ROUTE, RELAY_HIDDEN]);
  });

  it('when the recipient changes and the id is taken again, then the new recipient shows and the old one is warned as a refund address', () => {
    const order = change((o) => (o.output.payments[0].recipient = THIRD.toLowerCase()));
    const batch = read(order, withId(order));
    expect(batch?.transfer?.otherRecipient).toBe(THIRD);
    expect(batch?.notices).toEqual([
      notThisAccount('The recipient', THIRD),
      notThisAccount('The refund address', RECIPIENT),
    ]);
  });

  it('when a refund goes to a 32-byte recipient and the id is taken again, then no terms show', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), (at, bytes) => {
        const order = change((o) => (o.inputs[0].refunds[at].recipient = toHex(bytes)));
        const batch = read(order, withId(order));
        expect(batch?.transfer?.title).toBe('Deposit to Relay');
        expect(batch?.notices).toEqual([RELAY_HIDDEN]);
      }),
      { numRuns: 30 }
    );
  });

  it('when any other JSON value stands in for the order, then it never throws and shows the mismatch', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (orderData) => {
        const batch = read(orderData, RELAY_OTHER_RECIPIENT_DEPOSIT);
        expect(batch?.transfer?.title).toBe('Deposit to Relay');
        expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
      })
    );
  });
});
