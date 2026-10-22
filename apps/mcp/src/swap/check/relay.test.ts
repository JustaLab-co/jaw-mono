import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, getAddress, pad, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { callsOf } from '../calls';
import { checkQuote, type BackendQuote, type CheckDeps, type QuoteRequest } from '../check';
import prodAnswer from '../fixtures/prod-relay-quote.json';
import nativeAnswer from '../fixtures/relay-native.json';
import usdcFeeAnswer from '../fixtures/relay-usdc-fee.json';
import usdcAnswer from '../fixtures/relay-usdc.json';
import { checkRelayOrder, relayOrderId } from './relay';

type Refund = {
  chainId: string;
  recipient: string;
  currency: string;
  minimumAmount: string;
  deadline: number;
  extraData: string;
};
type Payment = { recipient: string; currency: string; minimumAmount: string; expectedAmount: string };
type Order = {
  version: string;
  solverChainId: string;
  solver: string;
  salt: string;
  inputs: { payment: { chainId: string; currency: string; amount: string; weight: string }; refunds: Refund[] }[];
  output: { chainId: string; payments: Payment[]; deadline: number; calls: string[]; extraData: string };
  fees: object[];
};
type RelayQuote = BackendQuote & { relayOrder: { orderId: string; orderData: Order } };

const ACCOUNT = getAddress('0x6ca44a56b06869530c953dfa7868973be1456769');
const ATTACKER = '0x3333333333333333333333333333333333333333';
const BASE_USDC = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const ARB_USDC = getAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
const BASE_SEPOLIA_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const BASE_SEPOLIA_ROUTER = '0x000000000000000000000000f5042e6ffac5a625d4e7848e0b01373d8eb9e222';
const ATTACKER_DATA = '0x0000000000000000000000003333333333333333333333333333333333333333';
const TESTNET_SOLVER = '0x3e34b27a9bf37d8424e1a58ac7fc4d06914b76b9';
const NINES_78 = '9'.repeat(78);
const QUOTED_AT = 1_792_676_780;
const LAST_DEADLINE = QUOTED_AT + 7 * 86_400 + 3_600;

const usdcRequest: QuoteRequest = {
  originChainId: 8453,
  originToken: BASE_USDC,
  amount: '10000000',
  account: ACCOUNT,
  destinationChainId: 42161,
  destinationToken: ARB_USDC,
  recipient: ACCOUNT,
};
const nativeRequest: QuoteRequest = {
  ...usdcRequest,
  originToken: zeroAddress,
  amount: '10000000000000000',
  destinationChainId: 1,
  destinationToken: zeroAddress,
};

const quoteOf = (answer: { result: { data: unknown } }) => structuredClone(answer.result.data) as RelayQuote;

function variant(change: (quote: RelayQuote, order: Order) => void, { resign = true } = {}) {
  const quote = quoteOf(usdcAnswer);
  change(quote, quote.relayOrder.orderData);
  if (resign) {
    const id = relayOrderId(quote.relayOrder.orderData);
    if (!id) throw new Error('the changed order no longer parses');
    quote.relayOrder.orderId = id;
  }
  return quote;
}

const codeOf = (quote: BackendQuote, request = usdcRequest) => {
  const result = checkRelayOrder(request, quote, QUOTED_AT);
  return result.ok ? 'passed' : result.code;
};

describe('checkRelayOrder', () => {
  describe('given the live Relay quotes with protocol.v2 mapped to relayOrder', () => {
    it.each([
      [
        're_usdc',
        usdcAnswer,
        usdcRequest,
        '0x0de6aaacb71ffd230278e6aa855c6159b4e9e4be35ed782c48d74b1b42193c54',
        1793281580,
      ],
      [
        're_usdc_fee',
        usdcFeeAnswer,
        usdcRequest,
        '0x4aefef577bdf321635a10542aace42bcfaf4cc33be7220c61ca9b24f197c607f',
        1793281581,
      ],
      [
        're_native',
        nativeAnswer,
        nativeRequest,
        '0x61fb170c281e35e82af8773e6b9c0cbc065e9f74abe896149ad6a480eaf9536e',
        1793281580,
      ],
    ])(
      'when %s is checked against its request, then it passes with the order id and output deadline',
      (_, answer, request, orderId, deadline) => {
        expect(checkRelayOrder(request, quoteOf(answer), QUOTED_AT)).toEqual({ ok: true, orderId, deadline });
      }
    );

    it('when the order id arrives in upper case, then it still passes and the id is kept in lower case', () => {
      const quote = variant((q) => (q.relayOrder.orderId = q.relayOrder.orderId.toUpperCase().replace('0X', '0x')), {
        resign: false,
      });

      expect(checkRelayOrder(usdcRequest, quote, QUOTED_AT)).toMatchObject({
        ok: true,
        orderId: '0x0de6aaacb71ffd230278e6aa855c6159b4e9e4be35ed782c48d74b1b42193c54',
      });
    });

    it('when the USDC quote is checked for USDC to native ETH, then it fails with route_unsupported', () => {
      expect(codeOf(quoteOf(usdcAnswer), { ...usdcRequest, destinationToken: zeroAddress })).toBe('route_unsupported');
    });

    it('when the prod Relay quote without protocol data is checked, then it fails with order_missing', () => {
      expect(codeOf(quoteOf(prodAnswer), nativeRequest)).toBe('order_missing');
    });
  });

  describe('given a relayOrder that does not match the strict schema', () => {
    it.each([
      ['an unknown key in orderData', (_: RelayQuote, o: Order) => Object.assign(o, { hubType: 'onchain' })],
      ['an unknown key next to orderData', (q: RelayQuote) => Object.assign(q.relayOrder, { paymentDetails: {} })],
      ['an order id of 31 bytes', (q: RelayQuote) => (q.relayOrder.orderId = q.relayOrder.orderId.slice(0, 64))],
      [
        'a base58 output currency',
        (_: RelayQuote, o: Order) => (o.output.payments[0].currency = 'EPjFWdd5AufqSSqeM2q'),
      ],
      [
        'a deadline as a string',
        (_: RelayQuote, o: Order) => Object.assign(o.output, { deadline: String(QUOTED_AT + 60) }),
      ],
      ['a null relayOrder', (q: RelayQuote) => Object.assign(q, { relayOrder: null })],
    ])('when it carries %s, then it fails with order_terms', (_, change) => {
      expect(codeOf(variant(change, { resign: false }))).toBe('order_terms');
    });
  });

  describe('given one field of the USDC order changed and the order id left as Relay signed it', () => {
    it.each([
      ['the payment recipient', (o: Order) => (o.output.payments[0].recipient = ATTACKER)],
      ['the output currency', (o: Order) => (o.output.payments[0].currency = zeroAddress)],
      ['the minimum amount', (o: Order) => (o.output.payments[0].minimumAmount = '9776478')],
      ['the output chain', (o: Order) => (o.output.chainId = 'optimism')],
      ['a refund recipient', (o: Order) => (o.inputs[0].refunds[0].recipient = ATTACKER)],
      ['a refund chain', (o: Order) => (o.inputs[0].refunds[1].chainId = 'optimism')],
      ['the output extraData', (o: Order) => (o.output.extraData = ATTACKER_DATA)],
      ['a refund extraData', (o: Order) => (o.inputs[0].refunds[1].extraData = ATTACKER_DATA)],
      ['the solver', (o: Order) => (o.solver = ATTACKER)],
      ['the output deadline', (o: Order) => (o.output.deadline -= 1)],
      ['the input amount', (o: Order) => (o.inputs[0].payment.amount = '1')],
    ])('when %s differs, then it fails with order_id', (_, change) => {
      expect(codeOf(variant((__, o) => change(o), { resign: false }))).toBe('order_id');
    });
  });

  describe('given one field of the USDC order changed and the order id recomputed for it', () => {
    it.each([
      ['version v2', 'order_terms', (o: Order) => (o.version = 'v2')],
      ['a second input', 'order_terms', (o: Order) => o.inputs.push(structuredClone(o.inputs[0]))],
      [
        'a fee',
        'order_terms',
        (o: Order) =>
          o.fees.push({
            recipientChainId: 'base',
            recipient: ATTACKER,
            currencyChainId: 'base',
            currency: BASE_USDC.toLowerCase(),
            amount: '1',
          }),
      ],
      [
        'a second payment',
        'order_terms',
        (o: Order) => o.output.payments.push({ ...o.output.payments[0], recipient: ATTACKER }),
      ],
      ['the input paid on arbitrum', 'input_amount', (o: Order) => (o.inputs[0].payment.chainId = 'arbitrum')],
      ['the input in another token', 'input_amount', (o: Order) => (o.inputs[0].payment.currency = zeroAddress)],
      ['the input amount 1 lower', 'input_amount', (o: Order) => (o.inputs[0].payment.amount = '9999999')],
      ['no refunds', 'refund_terms', (o: Order) => (o.inputs[0].refunds = [])],
      [
        'three refunds',
        'refund_terms',
        (o: Order) => o.inputs[0].refunds.push({ ...o.inputs[0].refunds[0], chainId: 'optimism' }),
      ],
      [
        'both refunds on the origin chain',
        'refund_terms',
        (o: Order) => (o.inputs[0].refunds[1] = { ...o.inputs[0].refunds[0] }),
      ],
      ['a refund on a third chain', 'refund_terms', (o: Order) => (o.inputs[0].refunds[1].chainId = 'optimism')],
      [
        'the destination refund in native ETH',
        'refund_terms',
        (o: Order) => (o.inputs[0].refunds[1].currency = zeroAddress),
      ],
      [
        'the origin refund in Arbitrum USDC',
        'refund_terms',
        (o: Order) => (o.inputs[0].refunds[0].currency = ARB_USDC),
      ],
      [
        'a refund extraData of another router',
        'router_mismatch',
        (o: Order) => (o.inputs[0].refunds[0].extraData = ATTACKER_DATA),
      ],
      ['an empty refund extraData', 'router_mismatch', (o: Order) => (o.inputs[0].refunds[1].extraData = '0x')],
      ['a refund to another address', 'refund_recipient', (o: Order) => (o.inputs[0].refunds[1].recipient = ATTACKER)],
      ['the output on optimism', 'destination_chain', (o: Order) => (o.output.chainId = 'optimism')],
      ['an output extraData of another router', 'router_mismatch', (o: Order) => (o.output.extraData = ATTACKER_DATA)],
      ['an empty output extraData', 'router_mismatch', (o: Order) => (o.output.extraData = '0x')],
      ['the payment to another recipient', 'recipient', (o: Order) => (o.output.payments[0].recipient = ATTACKER)],
      ['the payment in native ETH', 'output_token', (o: Order) => (o.output.payments[0].currency = zeroAddress)],
      [
        'a minimum above the quote minimum',
        'output_amount',
        (o: Order) => (o.output.payments[0].minimumAmount = '9776478'),
      ],
      [
        'an expected amount below the quote',
        'output_amount',
        (o: Order) => (o.output.payments[0].expectedAmount = '9975995'),
      ],
      ['a solver outside the Base list', 'solver_unknown', (o: Order) => (o.solver = ATTACKER)],
      [
        'the Base Sepolia solver on the mainnet order',
        'order_terms',
        (o: Order) => Object.assign(o, { solverChainId: 'base-sepolia', solver: TESTNET_SOLVER }),
      ],
      ['an Optimism solver, a chain outside the route', 'order_terms', (o: Order) => (o.solverChainId = 'optimism')],
      ['a solver chain with no allowlist entry', 'order_terms', (o: Order) => (o.solverChainId = 'solana')],
      ['a destination call', 'order_calls', (o: Order) => o.output.calls.push('0x12345678')],
      ['an output deadline equal to now', 'deadline', (o: Order) => (o.output.deadline = QUOTED_AT)],
      ['an output deadline past 7 days and 1 hour', 'deadline', (o: Order) => (o.output.deadline = LAST_DEADLINE + 1)],
      ['a refund deadline equal to now', 'deadline', (o: Order) => (o.inputs[0].refunds[1].deadline = QUOTED_AT)],
      [
        'a refund deadline past 7 days and 1 hour',
        'deadline',
        (o: Order) => (o.inputs[0].refunds[0].deadline = LAST_DEADLINE + 1),
      ],
    ])('when it has %s, then it fails with %s', (_, code, change) => {
      expect(codeOf(variant((__, o) => change(o)))).toBe(code);
    });

    it('when every deadline is exactly 7 days and 1 hour away, then it passes', () => {
      const quote = variant((_, o) => {
        o.output.deadline = LAST_DEADLINE;
        for (const refund of o.inputs[0].refunds) refund.deadline = LAST_DEADLINE;
      });

      expect(checkRelayOrder(usdcRequest, quote, QUOTED_AT)).toMatchObject({ ok: true, deadline: LAST_DEADLINE });
    });

    it('when the solver is listed on the destination chain, then it passes', () => {
      expect(codeOf(variant((_, o) => (o.solverChainId = 'arbitrum')))).toBe('passed');
    });

    it('when the request names the account and token in lower case, then it still passes', () => {
      const request = {
        ...usdcRequest,
        account: ACCOUNT.toLowerCase() as typeof ACCOUNT,
        originToken: BASE_USDC.toLowerCase() as typeof BASE_USDC,
      };

      expect(codeOf(quoteOf(usdcAnswer), request)).toBe('passed');
    });
  });

  describe('given a uint256 field of the order at 2^256 or above', () => {
    it.each([
      ['the salt', (o: Order) => (o.salt = NINES_78)],
      ['the input amount', (o: Order) => (o.inputs[0].payment.amount = NINES_78)],
      ['the input weight', (o: Order) => (o.inputs[0].payment.weight = NINES_78)],
      ['a refund minimum', (o: Order) => (o.inputs[0].refunds[0].minimumAmount = NINES_78)],
      ['the output minimum', (o: Order) => (o.output.payments[0].minimumAmount = NINES_78)],
      ['the salt at exactly 2^256', (o: Order) => (o.salt = (2n ** 256n).toString())],
    ])(
      'when %s is out of range, then relayOrderId answers undefined and the check fails with order_terms',
      (_, change) => {
        const quote = variant((__, o) => change(o), { resign: false });

        expect(relayOrderId(quote.relayOrder.orderData)).toBeUndefined();
        expect(codeOf(quote)).toBe('order_terms');
      }
    );

    it('when the salt is 2^256 - 1, then the order still hashes', () => {
      const quote = variant((_, o) => (o.salt = (2n ** 256n - 1n).toString()), { resign: false });

      expect(relayOrderId(quote.relayOrder.orderData)).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe('given the output floor of 300 bps on 10 USDC (9700000 base units)', () => {
    const minimum = (min: string) =>
      variant((q, o) => {
        q.minOutputAmount = min;
        o.output.payments[0].minimumAmount = min;
      });

    it('when quote and order guarantee exactly 9700000, then it passes', () => {
      expect(codeOf(minimum('9700000'))).toBe('passed');
    });

    it.each(['9699999', '1'])('when quote and order guarantee %s, then it fails with output_floor', (min) => {
      expect(codeOf(minimum(min))).toBe('output_floor');
    });

    it('when re_usdc_fee is re-signed for a minimum 1 below the floor, then it fails with output_floor', () => {
      const quote = quoteOf(usdcFeeAnswer);
      quote.minOutputAmount = '9699999';
      quote.relayOrder.orderData.output.payments[0].minimumAmount = '9699999';
      quote.relayOrder.orderId = relayOrderId(quote.relayOrder.orderData)!;

      expect(codeOf(quote)).toBe('output_floor');
    });
  });

  describe('given the shared quote fields', () => {
    it.each([
      ['a quote id that is not relay:<32 bytes>', (q: RelayQuote) => (q.quoteId = 'relay:0x1234')],
      ['an across quote id', (q: RelayQuote) => (q.quoteId = 'across:abc-123')],
      ['a deposit field', (q: RelayQuote) => Object.assign(q, { deposit: { address: ATTACKER } })],
    ])('when it has %s, then it fails with quote_id', (_, change) => {
      expect(codeOf(variant(change, { resign: false }))).toBe('quote_id');
    });

    it('when inputAmount differs from the request, then it fails with input_amount', () => {
      expect(codeOf(variant((q) => (q.inputAmount = '10000001'), { resign: false }))).toBe('input_amount');
    });

    it.each([
      ['a zero minimum', { minOutputAmount: '0' }],
      ['a minimum above the expected output', { minOutputAmount: '9975997' }],
      ['an expected output that is not base units', { expectedOutputAmount: '9975996.5' }],
    ])('when it has %s, then it fails with output_amount', (_, fields) => {
      expect(codeOf(variant((q) => Object.assign(q, fields), { resign: false }))).toBe('output_amount');
    });

    it('when quote and order both put the minimum above the expected output, then it fails with output_amount', () => {
      const quote = variant((q, o) => {
        Object.assign(q, { minOutputAmount: '9800000', expectedOutputAmount: '9790000' });
        Object.assign(o.output.payments[0], { minimumAmount: '9800000', expectedAmount: '9790000' });
      });

      expect(codeOf(quote)).toBe('output_amount');
    });
  });

  describe('given the chains of the request', () => {
    it('when the origin chain has no Relay entry, then it fails with unsupported_chain', () => {
      expect(codeOf(quoteOf(usdcAnswer), { ...usdcRequest, originChainId: 11155420 })).toBe('unsupported_chain');
    });

    it('when the destination chain has no Relay entry, then it fails with destination_chain', () => {
      expect(codeOf(quoteOf(usdcAnswer), { ...usdcRequest, destinationChainId: 999 })).toBe('destination_chain');
    });

    it('when origin and destination are the same chain under an order signed for it, then it fails with destination_chain', () => {
      const quote = variant((_, o) => {
        o.output.chainId = 'base';
        o.output.payments[0].currency = BASE_USDC;
        o.inputs[0].refunds = [o.inputs[0].refunds[0]];
      });
      const request = { ...usdcRequest, destinationChainId: 8453, destinationToken: BASE_USDC };

      expect(codeOf(quote, request)).toBe('destination_chain');
    });

    it('when Base mainnet USDC goes to Base Sepolia USDC under an order signed for it, then it fails with destination_chain', () => {
      const quote = variant((_, o) => {
        o.output.chainId = 'base-sepolia';
        o.output.extraData = BASE_SEPOLIA_ROUTER;
        o.output.payments[0].currency = BASE_SEPOLIA_USDC;
        Object.assign(o.inputs[0].refunds[1], {
          chainId: 'base-sepolia',
          currency: BASE_SEPOLIA_USDC,
          extraData: BASE_SEPOLIA_ROUTER,
        });
      });
      const request = { ...usdcRequest, destinationChainId: 84532, destinationToken: BASE_SEPOLIA_USDC };

      expect(codeOf(quote, request)).toBe('destination_chain');
    });
  });

  describe('given 0.001 ETH from Base Sepolia to Sepolia, both flagged testnet', () => {
    const testnetRequest: QuoteRequest = {
      ...usdcRequest,
      originChainId: 84532,
      originToken: zeroAddress,
      amount: '1000000000000000',
      destinationChainId: 11155111,
      destinationToken: zeroAddress,
    };

    const testnetQuote = (min: string, change: (o: Order) => void = () => {}) =>
      variant((q, o) => {
        Object.assign(q, { inputAmount: testnetRequest.amount, minOutputAmount: min, expectedOutputAmount: min });
        Object.assign(o, { solverChainId: 'base-sepolia', solver: TESTNET_SOLVER });
        Object.assign(o.inputs[0].payment, {
          chainId: 'base-sepolia',
          currency: zeroAddress,
          amount: testnetRequest.amount,
        });
        const [first, second] = o.inputs[0].refunds;
        o.inputs[0].refunds = [
          { ...first, chainId: 'base-sepolia', currency: zeroAddress, extraData: BASE_SEPOLIA_ROUTER },
          { ...second, chainId: 'sepolia', currency: zeroAddress, extraData: '0x' },
        ];
        Object.assign(o.output, { chainId: 'sepolia', extraData: '0x' });
        Object.assign(o.output.payments[0], { currency: zeroAddress, minimumAmount: min, expectedAmount: min });
        change(o);
      });

    it('when the live 22 Oct quote costs 5873 bps and Sepolia carries extraData 0x, then it passes', () => {
      expect(codeOf(testnetQuote('412737624236110'), testnetRequest)).toBe('passed');
    });

    it('when the route costs exactly 9000 bps, then it passes, and 1 unit less fails with output_floor', () => {
      expect(codeOf(testnetQuote('100000000000000'), testnetRequest)).toBe('passed');
      expect(codeOf(testnetQuote('99999999999999'), testnetRequest)).toBe('output_floor');
    });

    it('when the Base Sepolia refund carries extraData 0x, then it passes', () => {
      const quote = testnetQuote('412737624236110', (o) => (o.inputs[0].refunds[0].extraData = '0x'));

      expect(codeOf(quote, testnetRequest)).toBe('passed');
    });

    it.each([
      ['the output', (o: Order) => (o.output.extraData = ATTACKER_DATA)],
      ['a refund', (o: Order) => (o.inputs[0].refunds[1].extraData = ATTACKER_DATA)],
    ])('when %s carries extraData of another router, then it fails with router_mismatch', (_, change) => {
      expect(codeOf(testnetQuote('412737624236110', change), testnetRequest)).toBe('router_mismatch');
    });
  });
});

describe('checkQuote with a Relay answer as the backend sends it', () => {
  const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  const APPROVAL_PROXY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
  const USDC_ORDER = '0x0de6aaacb71ffd230278e6aa855c6159b4e9e4be35ed782c48d74b1b42193c54';
  const NATIVE_ORDER = '0x61fb170c281e35e82af8773e6b9c0cbc065e9f74abe896149ad6a480eaf9536e';
  const OTHER_ORDER = `0x${'ab'.repeat(32)}` as const;
  const EXACT_APPROVE =
    '0x095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000000000989680';
  const USDC_DEPOSIT =
    '0xe80179520000000000000000000000006ca44a56b06869530c953dfa7868973be1456769000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000009896800de6aaacb71ffd230278e6aa855c6159b4e9e4be35ed782c48d74b1b42193c54';
  const NATIVE_DEPOSIT =
    '0x49290c1c0000000000000000000000006ca44a56b06869530c953dfa7868973be145676961fb170c281e35e82af8773e6b9c0cbc065e9f74abe896149ad6a480eaf9536e';

  const depositoryAbi = parseAbi([
    'function depositNative(address depositor, bytes32 id)',
    'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
  ]);
  const threeArgAbi = parseAbi(['function depositErc20(address token, uint256 amount, bytes32 id)']);
  const erc20Deposit = (depositor: Address, token: Address, amount: bigint, id: Hex) =>
    encodeFunctionData({ abi: depositoryAbi, functionName: 'depositErc20', args: [depositor, token, amount, id] });
  const nativeDeposit = (depositor: Address, id: Hex) =>
    encodeFunctionData({ abi: depositoryAbi, functionName: 'depositNative', args: [depositor, id] });

  type Tx = { chainId: number; to: string; data: string; value: string };
  const bodyOf = (answer: { result: { data: unknown } }) =>
    structuredClone(answer.result.data) as RelayQuote & { transactions: Tx[] };
  const usdcBody = (change: (txs: Tx[]) => void = () => {}) => {
    const body = bodyOf(usdcAnswer);
    change(body.transactions);
    return body;
  };
  const nativeBody = (change: (txs: Tx[]) => void = () => {}) => {
    const body = bodyOf(nativeAnswer);
    change(body.transactions);
    return body;
  };

  const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
    isDepositAddressTaken: async () => false,
    isOrderTaken: async () => false,
    now: () => QUOTED_AT,
    ownerWindowSec: 240,
    ...over,
  });

  async function accepted(request: QuoteRequest, body: unknown, d = deps()) {
    const result = await checkQuote(request, body, d);
    if (!result.ok) throw new Error(`expected the quote to pass, got ${result.code}`);
    expect(callsOf({ call: result.calls })).toEqual(result.calls);
    return result;
  }
  const codeFor = async (body: unknown, request = usdcRequest, d = deps()) => {
    const result = await checkQuote(request, body, d);
    return result.ok ? 'passed' : result.code;
  };

  describe('given the live USDC quote from Base to Arbitrum with its approve and deposit', () => {
    it('when checked, then it passes with the approve rebuilt for the Depository and the deposit bytes kept', async () => {
      const result = await accepted(usdcRequest, bodyOf(usdcAnswer));

      expect(result).toEqual({
        ok: true,
        quoteId: 'relay:0x179267678091194c54ad536dcde64b1b8ee801cc22789f7588d81f101cd20226',
        calls: [
          { kind: 'approve', chainId: 8453, to: BASE_USDC, data: EXACT_APPROVE, value: '0' },
          { kind: 'deposit', chainId: 8453, to: getAddress(DEPOSITORY), data: USDC_DEPOSIT, value: '0' },
        ],
        quote: {
          provider: 'relay',
          inputAmount: '10000000',
          expectedOutputAmount: '9975996',
          minOutputAmount: '9776477',
          expectedFillTimeSec: 1,
          orderId: USDC_ORDER,
          deadline: 1793281580,
        },
      });
    });

    it('when the quote approves an unlimited amount, then the stored approve is still exactly the amount', async () => {
      const unlimited = `0x095ea7b3${pad(DEPOSITORY).slice(2)}${'f'.repeat(64)}`;

      const result = await accepted(
        usdcRequest,
        usdcBody((txs) => (txs[0].data = unlimited))
      );

      expect(result.calls[0].data).toBe(EXACT_APPROVE);
    });

    it('when the quote leaves the approve out, then it passes and the MCP still builds the approve first', async () => {
      const result = await accepted(
        usdcRequest,
        usdcBody((txs) => txs.shift())
      );

      expect(result.calls.map(({ kind, data }) => [kind, data])).toEqual([
        ['approve', EXACT_APPROVE],
        ['deposit', USDC_DEPOSIT],
      ]);
    });

    it('when the quote id arrives in upper case, then the stored id is lower case', async () => {
      const body = usdcBody();
      body.quoteId = body.quoteId.toUpperCase().replace('RELAY:0X', 'relay:0x');

      expect((await accepted(usdcRequest, body)).quoteId).toBe(
        'relay:0x179267678091194c54ad536dcde64b1b8ee801cc22789f7588d81f101cd20226'
      );
    });

    it('when re_usdc_fee is checked, then it passes with its own order id', async () => {
      expect((await accepted(usdcRequest, bodyOf(usdcFeeAnswer))).quote.orderId).toBe(
        '0x4aefef577bdf321635a10542aace42bcfaf4cc33be7220c61ca9b24f197c607f'
      );
    });

    it('when no swap holds the order, then the lookup is asked with the order id', async () => {
      const isOrderTaken = vi.fn(async () => false);

      await accepted(usdcRequest, bodyOf(usdcAnswer), deps({ isOrderTaken }));

      expect(isOrderTaken).toHaveBeenCalledWith(USDC_ORDER);
    });
  });

  describe('given the live native ETH quote from Base to mainnet', () => {
    it('when checked, then it passes with the one depositNative call and the amount as value', async () => {
      const result = await accepted(nativeRequest, bodyOf(nativeAnswer));

      expect(result.calls).toEqual([
        {
          kind: 'deposit',
          chainId: 8453,
          to: getAddress(DEPOSITORY),
          data: NATIVE_DEPOSIT,
          value: '10000000000000000',
        },
      ]);
      expect(result.quote).toMatchObject({ provider: 'relay', orderId: NATIVE_ORDER, deadline: 1793281580 });
    });
  });

  describe('given the clock the caller passes, in unix seconds', () => {
    it('when now is one second before the order deadline, then it passes, and at the deadline it fails with deadline', async () => {
      expect(await codeFor(bodyOf(usdcAnswer), usdcRequest, deps({ now: () => 1793281579 }))).toBe('passed');
      expect(await codeFor(bodyOf(usdcAnswer), usdcRequest, deps({ now: () => 1793281580 }))).toBe('deadline');
    });
  });

  describe('given the prod Relay answer without protocol data', () => {
    it('when checked, then it fails with order_missing', async () => {
      expect(await codeFor(bodyOf(prodAnswer), nativeRequest)).toBe('order_missing');
    });
  });

  describe('given one transaction of a passing quote changed', () => {
    const transferAndMulticall = `0xf9e4bab4${'00'.repeat(64)}`;
    const dirtyDepositor = `${USDC_DEPOSIT.slice(0, 10)}ff${USDC_DEPOSIT.slice(12)}`;

    it.each([
      ['the deposit on another chain', 'tx_chain', (txs: Tx[]) => (txs[1].chainId = 42161)],
      ['the approve on another chain', 'tx_chain', (txs: Tx[]) => (txs[0].chainId = 42161)],
      ['no transaction', 'tx_count', (txs: Tx[]) => txs.splice(0)],
      ['a third transaction', 'tx_count', (txs: Tx[]) => txs.push({ ...txs[1] })],
      [
        'the deposit through the ApprovalProxy',
        'route_unsupported',
        (txs: Tx[]) => Object.assign(txs[1], { to: APPROVAL_PROXY, data: transferAndMulticall }),
      ],
      [
        'the 3-argument depositErc20',
        'tx_selector',
        (txs: Tx[]) =>
          (txs[1].data = encodeFunctionData({
            abi: threeArgAbi,
            functionName: 'depositErc20',
            args: [BASE_USDC, 10000000n, USDC_ORDER],
          })),
      ],
      [
        'depositNative on a USDC origin',
        'tx_selector',
        (txs: Tx[]) => (txs[1].data = nativeDeposit(ACCOUNT, USDC_ORDER)),
      ],
      ['an unknown selector', 'tx_selector', (txs: Tx[]) => (txs[1].data = `0x12345678${USDC_DEPOSIT.slice(10)}`)],
      ['the deposit to another contract', 'tx_to', (txs: Tx[]) => (txs[1].to = ATTACKER)],
      ['the deposit to the ApprovalProxy', 'tx_to', (txs: Tx[]) => (txs[1].to = APPROVAL_PROXY)],
      ['the deposit carrying value', 'tx_value', (txs: Tx[]) => (txs[1].value = '1')],
      ['a byte after the deposit', 'tx_data', (txs: Tx[]) => (txs[1].data += '00')],
      ['dirty padding on the depositor word', 'tx_data', (txs: Tx[]) => (txs[1].data = dirtyDepositor)],
      ['the deposit cut short', 'tx_data', (txs: Tx[]) => (txs[1].data = USDC_DEPOSIT.slice(0, -2))],
      [
        'another depositor',
        'depositor',
        (txs: Tx[]) => (txs[1].data = erc20Deposit(ATTACKER, BASE_USDC, 10000000n, USDC_ORDER)),
      ],
      [
        'another token',
        'input_amount',
        (txs: Tx[]) => (txs[1].data = erc20Deposit(ACCOUNT, ARB_USDC, 10000000n, USDC_ORDER)),
      ],
      [
        'an amount 1 lower',
        'input_amount',
        (txs: Tx[]) => (txs[1].data = erc20Deposit(ACCOUNT, BASE_USDC, 9999999n, USDC_ORDER)),
      ],
      [
        'another order id',
        'order_id',
        (txs: Tx[]) => (txs[1].data = erc20Deposit(ACCOUNT, BASE_USDC, 10000000n, OTHER_ORDER)),
      ],
      [
        'an approve to another spender',
        'approve_spender',
        (txs: Tx[]) => (txs[0].data = `0x095ea7b3${pad(ATTACKER).slice(2)}${pad('0x989680').slice(2)}`),
      ],
      ['an approve on another token', 'approve_spender', (txs: Tx[]) => (txs[0].to = ARB_USDC)],
      [
        'a transfer in place of the approve',
        'approve_spender',
        (txs: Tx[]) => (txs[0].data = `0xa9059cbb${EXACT_APPROVE.slice(10)}`),
      ],
    ])('when it has %s, then it fails with %s', async (_, code, change) => {
      expect(await codeFor(usdcBody(change))).toBe(code);
    });

    it.each([
      ['an approve before the deposit', 'tx_count', (txs: Tx[]) => txs.unshift({ ...usdcBody().transactions[0] })],
      [
        'the deposit through the ApprovalProxy',
        'route_unsupported',
        (txs: Tx[]) => Object.assign(txs[0], { to: APPROVAL_PROXY, data: transferAndMulticall }),
      ],
      [
        'depositErc20 on a native origin',
        'tx_selector',
        (txs: Tx[]) => (txs[0].data = erc20Deposit(ACCOUNT, zeroAddress, 10000000000000000n, NATIVE_ORDER)),
      ],
      ['the deposit to another contract', 'tx_to', (txs: Tx[]) => (txs[0].to = ATTACKER)],
      ['a value 1 below the amount', 'tx_value', (txs: Tx[]) => (txs[0].value = '9999999999999999')],
      ['a byte after the deposit', 'tx_data', (txs: Tx[]) => (txs[0].data += '00')],
      ['another depositor', 'depositor', (txs: Tx[]) => (txs[0].data = nativeDeposit(ATTACKER, NATIVE_ORDER))],
      ['another order id', 'order_id', (txs: Tx[]) => (txs[0].data = nativeDeposit(ACCOUNT, OTHER_ORDER))],
    ])('when the native quote has %s, then it fails with %s', async (_, code, change) => {
      expect(await codeFor(nativeBody(change), nativeRequest)).toBe(code);
    });
  });

  describe('given a swap row that already holds the order id', () => {
    it('when the quote is checked, then it fails with order_reused', async () => {
      const isOrderTaken = async (orderId: Hex) => orderId === USDC_ORDER;

      expect(await codeFor(bodyOf(usdcAnswer), usdcRequest, deps({ isOrderTaken }))).toBe('order_reused');
    });

    it('when the quote already failed a transaction check, then the lookup is not asked', async () => {
      const isOrderTaken = vi.fn(async () => true);

      await codeFor(
        usdcBody((txs) => (txs[1].to = ATTACKER)),
        usdcRequest,
        deps({ isOrderTaken })
      );

      expect(isOrderTaken).not.toHaveBeenCalled();
    });
  });
});
