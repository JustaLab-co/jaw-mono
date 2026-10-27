import { describe, expect, it } from 'vitest';
import { getAddress, hashStruct, pad, zeroAddress, type Hex } from 'viem';
import { readBridgeBatch } from './batch';
import {
  ACROSS_CALLS,
  RELAY_NATIVE_DEPOSIT,
  RELAY_NATIVE_ORDER,
  RELAY_USDC_APPROVE,
  RELAY_USDC_DEPOSIT,
  RELAY_USDC_ORDER,
  RELAY_USDC_V32_APPROVE,
  RELAY_USDC_V32_DEPOSIT,
  RELAY_USDC_V32_ORDER,
  SIGNER,
} from './fixtures';
import { ORDER_TYPES } from './relayOrder';
import type { BridgeCall } from './view';
import { BridgeContracts } from './table';
import { BRIDGE_CHAINS } from './contracts';

const contracts = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS });

const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';
const MISMATCH = 'The Relay order details do not match this deposit, so this screen does not show them.';
const UNKNOWN_ROUTE =
  'This Relay order uses a solver or route this screen does not recognize, so its terms are not shown.';
const includes = (what: string) => `This Relay order includes ${what}, so its terms are not shown.`;

const SIGNER_CHECKSUM = '0x6ca44a56b06869530c953dFa7868973be1456769';
const OTHER = '0x1111111111111111111111111111111111111111';
const OTHER_CHECKSUM = '0x1111111111111111111111111111111111111111';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const USDC_V32_ORDER_ID = '0xd9dcfa1b6777423024cd61fed0c44fca59864cd8b5e0619ca3be985fa34ed70e';
const USDC_ORDER_ID = '0x0de6aaacb71ffd230278e6aa855c6159b4e9e4be35ed782c48d74b1b42193c54';
const POLYGON_SOLVER = '0xC1A6E71C0f69aD498AA4029BDF9F8CDBa79f9678';
const NOT_ROUTER = pad(OTHER);
const NATIVE_ORDER_ID = '0x61fb170c281e35e82af8773e6b9c0cbc065e9f74abe896149ad6a480eaf9536e';

type Order = typeof RELAY_USDC_ORDER;

const edit = (change: (order: Order) => void, base: Order = RELAY_USDC_ORDER): Order => {
  const order = structuredClone(base);
  change(order);
  return order;
};
const idOf = (order: Order): Hex => hashStruct({ types: ORDER_TYPES, primaryType: 'Order', data: order as never });
const withId = (deposit: BridgeCall, id: string): BridgeCall => ({
  ...deposit,
  data: (deposit.data ?? '').slice(0, -64) + id.slice(2),
});
const capability = (orderData: unknown) => ({ optional: true, orderData });

const usdcBatchOn = (table: BridgeContracts, order: unknown, { rehash = false } = {}) => {
  const deposit = rehash ? withId(RELAY_USDC_DEPOSIT, idOf(order as Order)) : RELAY_USDC_DEPOSIT;
  return readBridgeBatch(table, [RELAY_USDC_APPROVE, deposit], SIGNER, capability(order));
};
const usdcBatch = (order: unknown, opts?: { rehash?: boolean }) => usdcBatchOn(contracts, order, opts);

const CREDITED = { label: 'Credited to', value: 'This account', copy: SIGNER_CHECKSUM };
const orderDetail = (id: string) => ({ label: 'Order', value: `${id.slice(0, 6)}…${id.slice(-4)}`, copy: id });
/** The transfer as it reads with no usable order: what is sent, and nothing about where it goes. */
const BASE = { name: 'Base', nativeSymbol: 'ETH' };
const withoutOrder = (id: string) => ({
  provider: 'relay',
  title: 'Deposit to Relay',
  origin: BASE,
  send: {
    chainId: 8453,
    amount: 10_000_000n,
    token: { address: getAddress(BASE_USDC), known: true, symbol: 'USDC', decimals: 6 },
  },
  details: [CREDITED, orderDetail(id)],
});
const toArbitrum = { receive: { kind: 'minimum', amount: { chainId: 42161 } } };
const USDC_ORDER_TRANSFER = {
  provider: 'relay',
  title: 'Bridge to Arbitrum',
  send: withoutOrder(USDC_ORDER_ID).send,
  origin: BASE,
  destination: { name: 'Arbitrum', nativeSymbol: 'ETH' },
  receive: {
    kind: 'minimum',
    amount: {
      chainId: 42161,
      amount: 9_776_477n,
      token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', known: true, symbol: 'USDC', decimals: 6 },
    },
  },
  details: [
    { label: 'Recipient', value: 'This account', copy: SIGNER_CHECKSUM },
    { label: 'Refund to', value: 'This account', copy: SIGNER_CHECKSUM },
    CREDITED,
    orderDetail(USDC_ORDER_ID),
  ],
};
const notThisAccount = (who: string) => `${who} is not this account: ${OTHER_CHECKSUM}.`;

describe('given the relay-usdc batch and the order the MCP sends with it', () => {
  it('when the order hashes to the deposit id, then the transfer shows destination, recipient, minimum and refund, and no Relay notice', () => {
    const batch = usdcBatch(RELAY_USDC_ORDER);
    expect(batch?.transfer).toEqual(USDC_ORDER_TRANSFER);
    expect(batch?.notices).toEqual([]);
  });

  it('when a live quote names the v3.2 router, then the transfer shows destination, recipient, minimum and refund, and no Relay notice', () => {
    const batch = readBridgeBatch(
      contracts,
      [RELAY_USDC_V32_APPROVE, RELAY_USDC_V32_DEPOSIT],
      SIGNER,
      capability(RELAY_USDC_V32_ORDER)
    );
    expect(batch?.transfer).toEqual({
      ...USDC_ORDER_TRANSFER,
      receive: {
        kind: 'minimum',
        amount: { ...USDC_ORDER_TRANSFER.receive.amount, amount: 9_776_602n },
      },
      details: [...USDC_ORDER_TRANSFER.details.slice(0, 3), orderDetail(USDC_V32_ORDER_ID)],
    });
    expect(batch?.notices).toEqual([]);
  });

  it.each([
    ['checksummed', getAddress(RELAY_USDC_ORDER.solver)],
    ['upper and lower case that fails the checksum', '0xF70DA97812CB96acdf810712aa562db8dfa3dbef'],
  ])('when the solver arrives %s, then the order still matches', (_, solver) => {
    const batch = usdcBatch(edit((o) => (o.solver = solver)));
    expect(batch?.transfer).toEqual(USDC_ORDER_TRANSFER);
    expect(batch?.notices).toEqual([]);
  });

  it.each([
    ['listed for Base', edit((o) => (o.solver = '0x56c262027e0de4aea31d2489529cb25d23e58a8b'))],
    ['the shared solver listed for Arbitrum, the destination', edit((o) => (o.solverChainId = 'arbitrum'))],
    [
      'with router extraData in upper case',
      edit((o) => (o.output.extraData = o.output.extraData.toUpperCase().replace('0X', '0x'))),
    ],
  ])('when a matching order has a solver %s, then the order shows', (_, order) => {
    const batch = usdcBatch(order, { rehash: true });
    expect(batch?.transfer).toMatchObject(toArbitrum);
    expect(batch?.notices).toEqual([]);
  });

  it('when a matching order has a Base solver in mixed case that fails the checksum, then the order shows', () => {
    const order = edit((o) => (o.solver = '0x56c262027e0de4aea31d2489529cb25d23e58a8b'));
    const deposit = withId(RELAY_USDC_DEPOSIT, idOf(order));
    const mixed = { ...order, solver: '0x56C262027E0de4aea31d2489529cb25d23e58a8b' };
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, deposit], SIGNER, capability(mixed));
    expect(batch?.transfer).toMatchObject(toArbitrum);
    expect(batch?.notices).toEqual([]);
  });

  it('when amounts arrive as hex strings and bytes in upper case, then the order still matches', () => {
    const order = edit((o) => {
      o.inputs[0].payment.amount = '0x989680';
      o.output.payments[0].currency = '0xAF88D065E77C8CC2239327C5EDB3A432268E5831';
    });
    expect(usdcBatch(order)?.transfer).toEqual(USDC_ORDER_TRANSFER);
  });

  it('when the recipient is changed and the id is not, then the mismatch warning shows and no order terms', () => {
    const batch = usdcBatch(edit((o) => (o.output.payments[0].recipient = OTHER)));
    expect(batch?.transfer).toEqual(withoutOrder(USDC_ORDER_ID));
    expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
  });

  it('when the order belongs to another deposit, then the mismatch warning shows', () => {
    const batch = usdcBatch(RELAY_NATIVE_ORDER);
    expect(batch?.transfer).toEqual(withoutOrder(USDC_ORDER_ID));
    expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
  });

  it.each([
    ['an unknown key', { ...RELAY_USDC_ORDER, note: 'x' }],
    ['a number in place of an amount string', edit((o) => ((o.salt as unknown) = 1))],
    ['an amount that is not a number', edit((o) => (o.inputs[0].payment.amount = 'ten'))],
    ['a solver that is not an address', edit((o) => (o.solver = '0x1234'))],
    ['no orderData', undefined],
    ['a string in place of the order', 'order'],
    ['an amount of 2^256', edit((o) => (o.output.payments[0].minimumAmount = (2n ** 256n).toString()))],
    ['a deadline past 2^32 - 1', edit((o) => (o.output.deadline = 2 ** 32))],
  ])('when the order has %s, then the mismatch warning shows', (_, order) => {
    const batch = usdcBatch(order);
    expect(batch?.transfer).toEqual(withoutOrder(USDC_ORDER_ID));
    expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
  });

  it.each([
    ['input amount', edit((o) => (o.inputs[0].payment.amount = '9999999'))],
    ['input chain', edit((o) => (o.inputs[0].payment.chainId = 'arbitrum'))],
    ['input token', edit((o) => (o.inputs[0].payment.currency = BASE_WETH))],
  ])(
    'when the order hashes to the id but its %s differs from the deposit, then the mismatch warning shows',
    (_, order) => {
      const id = idOf(order);
      const batch = usdcBatch(order, { rehash: true });
      expect(batch?.transfer).toEqual(withoutOrder(id));
      expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
    }
  );

  it.each([
    [
      'a fee',
      includes('fees'),
      edit((o) =>
        (o.fees as unknown[]).push({
          recipientChainId: 'base',
          recipient: OTHER,
          currencyChainId: 'base',
          currency: BASE_USDC,
          amount: '1',
        })
      ),
    ],
    [
      'two payments',
      includes('more than one payment'),
      edit((o) => o.output.payments.push({ ...o.output.payments[0], recipient: OTHER })),
    ],
    ['a destination call', includes('destination calls'), edit((o) => (o.output.calls as string[]).push('0x12345678'))],
    [
      'an output token outside the table',
      includes('an unrecognized token'),
      edit((o) => (o.output.payments[0].currency = OTHER)),
    ],
    [
      'a 32-byte output token',
      includes('an unrecognized token'),
      edit((o) => (o.output.payments[0].currency = `0x${'ab'.repeat(32)}`)),
    ],
    ['a destination outside the table', UNKNOWN_ROUTE, edit((o) => (o.output.chainId = 'solana'))],
    ['an attacker solver', UNKNOWN_ROUTE, edit((o) => (o.solver = OTHER))],
    ['a solver listed only for another chain', UNKNOWN_ROUTE, edit((o) => (o.solver = POLYGON_SOLVER))],
    [
      'the solver chain of that other chain',
      UNKNOWN_ROUTE,
      edit((o) => ((o.solverChainId = 'polygon'), (o.solver = POLYGON_SOLVER))),
    ],
    ['a solver chain that is neither side', UNKNOWN_ROUTE, edit((o) => (o.solverChainId = 'optimism'))],
    ['output extraData of another address', UNKNOWN_ROUTE, edit((o) => (o.output.extraData = NOT_ROUTER))],
    ['empty output extraData on a mainnet', UNKNOWN_ROUTE, edit((o) => (o.output.extraData = '0x'))],
    ['output extraData one byte longer', UNKNOWN_ROUTE, edit((o) => (o.output.extraData = `${o.output.extraData}00`))],
    [
      'refund extraData of another address',
      UNKNOWN_ROUTE,
      edit((o) => (o.inputs[0].refunds[0].extraData = NOT_ROUTER)),
    ],
    ['empty refund extraData on a mainnet', UNKNOWN_ROUTE, edit((o) => (o.inputs[0].refunds[1].extraData = '0x'))],
    ['a refund on neither side', UNKNOWN_ROUTE, edit((o) => (o.inputs[0].refunds[1].chainId = 'optimism'))],
  ])('when a matching order has %s, then it says why the terms are not shown', (_, warning, order) => {
    const id = idOf(order);
    const batch = usdcBatch(order, { rehash: true });
    expect(batch?.transfer).toEqual(withoutOrder(id));
    expect(batch?.notices).toEqual([warning, RELAY_HIDDEN]);
  });

  it.each([
    ['a 32-byte recipient', edit((o) => (o.output.payments[0].recipient = `0x${'ab'.repeat(32)}`))],
    ['version v2', edit((o) => (o.version = 'v2'))],
    ['two inputs', edit((o) => o.inputs.push(o.inputs[0]))],
    ['no refunds', edit((o) => (o.inputs[0].refunds = []))],
    ['refunds to two addresses', edit((o) => (o.inputs[0].refunds[1].recipient = OTHER))],
    [
      'a 32-byte refund recipient',
      edit((o) => o.inputs[0].refunds.forEach((r) => (r.recipient = `0x${'ab'.repeat(32)}`))),
    ],
  ])(
    'when a matching order has %s, then the transfer stays as without an order and nothing is said about it',
    (_, order) => {
      const id = idOf(order);
      const batch = usdcBatch(order, { rehash: true });
      expect(batch?.transfer).toEqual(withoutOrder(id));
      expect(batch?.notices).toEqual([RELAY_HIDDEN]);
    }
  );

  it('when a matching order pays another address, then the recipient prints in full with the not-this-account warning', () => {
    const order = edit((o) => (o.output.payments[0].recipient = OTHER));
    const batch = usdcBatch(order, { rehash: true });
    expect(batch?.transfer?.details[0]).toEqual({ label: 'Recipient', value: OTHER_CHECKSUM, copy: OTHER_CHECKSUM });
    expect(batch?.transfer?.otherRecipient).toBe(OTHER_CHECKSUM);
    expect(batch?.transfer).toMatchObject(toArbitrum);
    expect(batch?.notices).toEqual([notThisAccount('The recipient')]);
  });

  it('when a matching order refunds another address, then the refund prints in full with the refund warning', () => {
    const order = edit((o) => o.inputs[0].refunds.forEach((r) => (r.recipient = OTHER)));
    const batch = usdcBatch(order, { rehash: true });
    expect(batch?.transfer?.details[1]).toEqual({ label: 'Refund to', value: OTHER_CHECKSUM, copy: OTHER_CHECKSUM });
    expect(batch?.notices).toEqual([notThisAccount('The refund address')]);
  });
});

describe('given the relay-native deposit and its order', () => {
  it('when the order hashes to the deposit id, then the transfer shows Ethereum, the recipient and the minimum in ETH', () => {
    const batch = readBridgeBatch(contracts, [RELAY_NATIVE_DEPOSIT], SIGNER, capability(RELAY_NATIVE_ORDER));
    expect(batch?.transfer).toEqual({
      provider: 'relay',
      title: 'Bridge to Ethereum',
      origin: BASE,
      destination: { name: 'Ethereum', nativeSymbol: 'ETH' },
      send: {
        chainId: 8453,
        amount: 10n ** 16n,
        token: { address: zeroAddress, known: true, symbol: 'ETH', decimals: 18 },
      },
      receive: {
        kind: 'minimum',
        amount: {
          chainId: 1,
          amount: 9_741_110_979_793_708n,
          token: { address: zeroAddress, known: true, symbol: 'ETH', decimals: 18 },
        },
      },
      details: [
        { label: 'Recipient', value: 'This account', copy: SIGNER_CHECKSUM },
        { label: 'Refund to', value: 'This account', copy: SIGNER_CHECKSUM },
        CREDITED,
        orderDetail(NATIVE_ORDER_ID),
      ],
    });
    expect(batch?.notices).toEqual([]);
  });

  it('when the ERC-20 order is attached instead, then the mismatch warning shows', () => {
    const batch = readBridgeBatch(contracts, [RELAY_NATIVE_DEPOSIT], SIGNER, capability(RELAY_USDC_ORDER));
    expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
  });
});

describe('given a Relay deposit on Base Sepolia', () => {
  const BASE_SEPOLIA_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  const SEPOLIA_USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
  const testnetOrder = (refundExtraData: string, outputExtraData: string) =>
    edit((o) => {
      o.solverChainId = 'base-sepolia';
      o.solver = '0x3e34b27a9bf37D8424e1a58aC7fc4D06914B76B9';
      o.inputs[0].payment = { ...o.inputs[0].payment, chainId: 'base-sepolia', currency: BASE_SEPOLIA_USDC };
      o.inputs[0].refunds = [
        { ...o.inputs[0].refunds[0], chainId: 'base-sepolia', currency: BASE_SEPOLIA_USDC, extraData: refundExtraData },
      ];
      o.output.chainId = 'sepolia';
      o.output.extraData = outputExtraData;
      o.output.payments[0].currency = SEPOLIA_USDC;
    });
  const read = (order: Order) =>
    readBridgeBatch(
      contracts,
      [
        {
          chainId: 84532,
          to: '0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3',
          data: withId(RELAY_USDC_DEPOSIT, idOf(order)).data?.replace(BASE_USDC.slice(2), BASE_SEPOLIA_USDC.slice(2)),
        },
      ],
      SIGNER,
      capability(order)
    );

  it.each([
    ['empty', '0x', '0x'],
    [
      'each chain router',
      pad('0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222'),
      pad('0xA1BEa5fe917450041748Dbbbe7E9AC57A4bBEBaB'),
    ],
  ])('when the order extraData is %s, then the order shows, as Relay allows on testnets', (_, refund, output) => {
    const batch = read(testnetOrder(refund, output));
    expect(batch?.transfer).toMatchObject({ receive: { amount: { chainId: 11155111 } } });
    expect(batch?.notices).toEqual([]);
  });

  it('when the order uses the mainnet router, then the route warning shows', () => {
    const router = pad('0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f');
    const batch = read(testnetOrder(router, router));
    expect(batch?.notices).toEqual([UNKNOWN_ROUTE, RELAY_HIDDEN]);
  });
});

describe('given no usable capability', () => {
  it('when the request has no jawRelayOrder, then the transfer says the destination is not in this transaction', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.transfer).toEqual(withoutOrder(USDC_ORDER_ID));
    expect(batch?.notices).toEqual([RELAY_HIDDEN]);
  });

  const sized = (chars: number) => {
    const order = edit((o) => {
      o.inputs[0].payment.weight = '10';
      o.output.extraData = '0x';
    });
    order.output.extraData = `0x${'ab'.repeat((chars - JSON.stringify(order).length) / 2)}`;
    expect(JSON.stringify(order).length).toBe(chars);
    return order;
  };

  it('when a matching order is 32768 characters of JSON, then it is read past the size check', () => {
    const batch = usdcBatch(sized(32_768), { rehash: true });
    expect(batch?.notices).toEqual([UNKNOWN_ROUTE, RELAY_HIDDEN]);
  });

  it('when a matching order is over 32768 characters of JSON, then the mismatch warning shows', () => {
    const order = sized(32_770);
    const batch = usdcBatch(order, { rehash: true });
    expect(batch?.transfer).toEqual(withoutOrder(idOf(order)));
    expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
  });

  it('when the capability cannot be turned into JSON, then the mismatch warning shows', () => {
    const batch = usdcBatch(edit((o) => ((o.salt as unknown) = 1n)));
    expect(batch?.transfer).toEqual(withoutOrder(USDC_ORDER_ID));
    expect(batch?.notices).toEqual([MISMATCH, RELAY_HIDDEN]);
  });

  it('when the capability rides on an Across batch, then the Across transfer and notices are unchanged', () => {
    const plain = readBridgeBatch(contracts, [ACROSS_CALLS.prod], SIGNER);
    expect(readBridgeBatch(contracts, [ACROSS_CALLS.prod], SIGNER, capability(RELAY_USDC_ORDER))).toEqual(plain);
    expect(readBridgeBatch(contracts, [ACROSS_CALLS.prod], SIGNER, capability('junk'))).toEqual(plain);
  });

  it('when the capability rides on a batch with no bridge call, then there is still no bridge view', () => {
    const transfer = { chainId: 8453, to: OTHER, value: '1' };
    expect(readBridgeBatch(contracts, [transfer], SIGNER, capability(RELAY_USDC_ORDER))).toBeNull();
  });
});

describe('given a Relay order through a router the compiled table does not list', () => {
  const STALE = 'This screen could not refresh its list of bridge contracts.';
  const viaNewRouter = edit((o) => {
    o.output.extraData = NOT_ROUTER;
    for (const refund of o.inputs[0].refunds) refund.extraData = NOT_ROUTER;
  });
  const withNewRouter = (source: 'live' | 'snapshot') => {
    const chains = structuredClone(BRIDGE_CHAINS);
    for (const chain of Object.values(chains)) {
      if (chain.relay) chain.relay.erc20Routers = [...chain.relay.erc20Routers, OTHER_CHECKSUM];
    }
    return new BridgeContracts({ version: 2, chains }, source);
  };
  const read = (table: BridgeContracts) => usdcBatchOn(table, viaNewRouter, { rehash: true });

  it('when a live table lists the router, then the order reads as a known route', () => {
    expect(read(withNewRouter('live'))?.notices).toEqual([]);
  });

  it('when the live table lacks the router, then the route is unknown and the refresh line stays out', () => {
    expect(read(contracts)?.notices).toEqual([UNKNOWN_ROUTE, RELAY_HIDDEN]);
  });

  it('when the table in use is the snapshot and the route is unknown, then the notice adds the refresh line', () => {
    const snapshot = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS }, 'snapshot');
    expect(read(snapshot)?.notices).toEqual([UNKNOWN_ROUTE, RELAY_HIDDEN, STALE]);
  });

  it('when the table in use is the snapshot and the route is known, then no refresh line shows', () => {
    const snapshot = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS }, 'snapshot');
    expect(usdcBatchOn(snapshot, RELAY_USDC_ORDER)?.notices).toEqual([]);
  });
});

describe('given a Relay order the snapshot cannot place', () => {
  const STALE = 'This screen could not refresh its list of bridge contracts.';
  const snapshot = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS }, 'snapshot');
  const live = new BridgeContracts({ version: 2, chains: BRIDGE_CHAINS }, 'live');

  it.each([
    ['a payout token outside the table', edit((o) => (o.output.payments[0].currency = OTHER))],
    ['a destination outside the table', edit((o) => (o.output.chainId = 'solana'))],
  ])('when the order has %s, then the snapshot adds the refresh line and a live table does not', (_, order) => {
    expect(usdcBatchOn(snapshot, order, { rehash: true })?.notices).toContain(STALE);
    expect(usdcBatchOn(live, order, { rehash: true })?.notices).not.toContain(STALE);
  });

  it('when the order is mismatched, then the snapshot adds no refresh line', () => {
    expect(
      usdcBatchOn(
        snapshot,
        edit((o) => (o.salt = '7'))
      )?.notices
    ).not.toContain(STALE);
  });
});
