import { describe, expect, it } from 'vitest';
import { readBridgeBatch } from './batch';
import {
  ACROSS_CALLS,
  PROD_RELAY_DEPOSIT,
  RELAY_USDC_APPROVE,
  RELAY_USDC_DEPOSIT,
  RELAY_USDC_FEE_DEPOSIT,
  SIGNER,
} from './fixtures';
import type { BridgeCall } from './view';
import { BridgeContracts } from './table';
import { BRIDGE_CHAINS } from './contracts';

const contracts = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS });

const DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31';
const BASE_SPOKE_POOL = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const BASE_PERIPHERY = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const SIGNER_CHECKSUM = '0x6ca44a56b06869530c953dFa7868973be1456769';
const OTHER = '0x1111111111111111111111111111111111111111';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARB = '0x912CE59144191C1204E64559FE8253a0e49E6548';

const usdc = (chainId: number, address: string, amount: bigint) => ({
  chainId,
  amount,
  token: { address, known: true, symbol: 'USDC', decimals: 6 },
});

const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';
const DOES_MORE = 'This batch does more than the bridge deposit. Review every step.';
const OTHER_CONTRACT = 'This approval is for a different contract than the deposit.';
const OTHER_TOKEN = 'This approval is for a different token than the deposit.';
const notThisAccount = (who: string, address: string) => `${who} is not this account: ${address}.`;
const NOT_SIGNER = notThisAccount('The recipient', OTHER);
const REFUND_NOT_SIGNER = notThisAccount('The refund address', OTHER);
const UNPAIRED = 'This batch has an approval that the deposit does not use. Check its token, amount and spender.';
const FEE_NOT_JAW = 'The fee goes to an address JAW does not know.';
const APPROVE_UNKNOWN = 'This batch approves a token this screen does not know. Check its address before you confirm.';
const CANNOT_READ_RELAY = 'This screen cannot read this Relay call. Check the raw details before you confirm.';
const CANNOT_READ_ACROSS = 'This screen cannot read this Across call. Check the raw details before you confirm.';
const CANNOT_READ = { alert: CANNOT_READ_RELAY };
const PLAIN_STEP = null;

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const approve = (spender: string, amount: string): BridgeCall => ({
  ...RELAY_USDC_APPROVE,
  data: '0x095ea7b3' + word(spender) + word(amount),
});
const transfer: BridgeCall = {
  ...RELAY_USDC_APPROVE,
  data: '0xa9059cbb' + word(OTHER) + word('989680'),
};

describe('given the relay-usdc batch the MCP builds, approve then deposit', () => {
  it('when it is read, then the transfer shows the deposit, both steps carry no alert, and only the Relay warning shows', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.transfer).toMatchObject({ title: 'Deposit to Relay' });
    expect(batch?.steps).toEqual([PLAIN_STEP, PLAIN_STEP]);
    expect(batch?.notices).toEqual([RELAY_HIDDEN]);
  });

  it('when the approve is one unit larger than the deposit, then the batch leaves it to the token approvals card', () => {
    const batch = readBridgeBatch(contracts, [approve(DEPOSITORY, '989681'), RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.notices).toEqual([RELAY_HIDDEN]);
  });

  it('when the approve is one unit smaller than the deposit, then no pairing warning shows', () => {
    const batch = readBridgeBatch(contracts, [approve(DEPOSITORY, '98967f'), RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.notices).toEqual([RELAY_HIDDEN]);
  });

  it('when the approve goes to the Across SpokePool instead of the Depository, then the other-contract warning shows', () => {
    const batch = readBridgeBatch(contracts, [approve(BASE_SPOKE_POOL, '989680'), RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.transfer).toBeDefined();
    expect(batch?.notices).toEqual([RELAY_HIDDEN, OTHER_CONTRACT]);
  });

  it('when the approve is for WETH while the deposit is USDC, then the other-token warning shows', () => {
    const batch = readBridgeBatch(contracts, [{ ...RELAY_USDC_APPROVE, to: BASE_WETH }, RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.notices).toEqual([RELAY_HIDDEN, OTHER_TOKEN]);
  });

  it('when the deposit comes before the approve, then the transfer stays and both does-more and unpaired warnings show', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_DEPOSIT, RELAY_USDC_APPROVE], SIGNER);
    expect(batch?.transfer).toMatchObject({ title: 'Deposit to Relay' });
    expect(batch?.steps).toEqual([PLAIN_STEP, PLAIN_STEP]);
    expect(batch?.notices).toEqual([RELAY_HIDDEN, DOES_MORE, UNPAIRED]);
  });

  it('when the approve runs on another chain, then it does not pair and the batch does more', () => {
    const batch = readBridgeBatch(contracts, [{ ...RELAY_USDC_APPROVE, chainId: 10 }, RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.notices).toEqual([RELAY_HIDDEN, APPROVE_UNKNOWN, DOES_MORE, UNPAIRED]);
  });

  it('when a third call transfers tokens, then the transfer stays and the does-more warning shows', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT, transfer], SIGNER);
    expect(batch?.transfer).toBeDefined();
    expect(batch?.steps).toEqual([PLAIN_STEP, PLAIN_STEP, null]);
    expect(batch?.notices).toEqual([RELAY_HIDDEN, DOES_MORE]);
  });

  it('when a transfer sits between the approve and the deposit, then the approve gets the unpaired wording', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, transfer, RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.transfer).toBeDefined();
    expect(batch?.notices).toEqual([RELAY_HIDDEN, DOES_MORE, UNPAIRED]);
  });

  it('when the depositor is another account, then the not-this-account warning shows', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT], OTHER);
    expect(batch?.notices).toEqual([RELAY_HIDDEN, notThisAccount('The account credited', SIGNER_CHECKSUM)]);
  });
});

describe('given an allowance change in place of the plain approve', () => {
  const cases: [string, BridgeCall][] = [
    ['increaseAllowance', { ...RELAY_USDC_APPROVE, data: '0x39509351' + word(DEPOSITORY) + word('989680') }],
    ['an approve with value', { ...RELAY_USDC_APPROVE, value: '1' }],
    [
      'a Permit2 approve',
      {
        ...RELAY_USDC_APPROVE,
        to: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
        data: '0x87517c45' + word(RELAY_USDC_APPROVE.to) + word(DEPOSITORY) + word('989680') + word('ffffffffffff'),
      },
    ],
  ];

  it.each(cases)('when it is %s, then it counts as another call with the cannot-read warning', (_, call) => {
    const batch = readBridgeBatch(contracts, [call, RELAY_USDC_DEPOSIT], SIGNER);
    expect(batch?.transfer).toBeDefined();
    expect(batch?.steps).toEqual([CANNOT_READ, PLAIN_STEP]);
    expect(batch?.alerts).toEqual([CANNOT_READ_RELAY]);
    expect(batch?.notices).toEqual([RELAY_HIDDEN, DOES_MORE]);
  });
});

describe('given batches that are not one bridge deposit', () => {
  it('when two deposits are in one batch, then no transfer shows, no step is labelled, and the batch does more', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT, RELAY_USDC_FEE_DEPOSIT], SIGNER);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.steps).toEqual([PLAIN_STEP, PLAIN_STEP, PLAIN_STEP]);
    expect(batch?.notices).toEqual([RELAY_HIDDEN, DOES_MORE]);
  });

  it('when a native deposit follows an approve, then the approve does not pair and the batch does more', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, PROD_RELAY_DEPOSIT], SIGNER);
    expect(batch?.transfer).toMatchObject({ title: 'Deposit to Relay' });
    expect(batch?.notices).toEqual([RELAY_HIDDEN, DOES_MORE, UNPAIRED]);
  });

  it('when the native deposit is alone, then the transfer shows with only the Relay warning', () => {
    const batch = readBridgeBatch(contracts, [PROD_RELAY_DEPOSIT], SIGNER);
    expect(batch?.transfer).toMatchObject({ title: 'Deposit to Relay' });
    expect(batch?.steps).toEqual([PLAIN_STEP]);
    expect(batch?.notices).toEqual([RELAY_HIDDEN]);
  });

  it('when the only deposit is unreadable, then no transfer shows and its step carries the cannot-read warning', () => {
    const unreadable = { ...RELAY_USDC_DEPOSIT, data: RELAY_USDC_DEPOSIT.data + '00' };
    expect(readBridgeBatch(contracts, [RELAY_USDC_APPROVE, unreadable], SIGNER)).toEqual({
      transfer: undefined,
      steps: [PLAIN_STEP, CANNOT_READ],
      alerts: [CANNOT_READ_RELAY],
      notices: [],
    });
  });

  it('when there is no deposit and a call outside the bridge, then the batch does more', () => {
    const batch = readBridgeBatch(contracts, [RELAY_USDC_APPROVE, transfer], SIGNER);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.steps).toEqual([PLAIN_STEP, null]);
    expect(batch?.notices).toEqual([DOES_MORE]);
  });

  it('when an unreadable deposit sits next to a call outside the bridge, then both warnings show', () => {
    const unreadable = { ...RELAY_USDC_DEPOSIT, data: RELAY_USDC_DEPOSIT.data + '00' };
    const batch = readBridgeBatch(contracts, [unreadable, transfer], SIGNER);
    expect(batch?.alerts).toEqual([CANNOT_READ_RELAY]);
    expect(batch?.notices).toEqual([DOES_MORE]);
  });

  it('when the approve is alone, then its step is labelled and nothing else shows', () => {
    expect(readBridgeBatch(contracts, [RELAY_USDC_APPROVE], SIGNER)).toEqual({
      transfer: undefined,
      steps: [PLAIN_STEP],
      alerts: [],
      notices: [],
    });
  });

  it('when no call touches a bridge contract, then there is nothing to show', () => {
    expect(readBridgeBatch(contracts, [transfer], SIGNER)).toBeNull();
    expect(readBridgeBatch(contracts, [{ ...RELAY_USDC_DEPOSIT, to: OTHER }], SIGNER)).toBeNull();
  });
});

describe('given the prod Across batch, approve to the SpokePool then deposit', () => {
  const acrossApprove = approve(BASE_SPOKE_POOL, '989680');

  it('when it is read, then the transfer has every term of the deposit and no warning shows', () => {
    const batch = readBridgeBatch(contracts, [acrossApprove, ACROSS_CALLS.prod], SIGNER);
    expect(batch).toEqual({
      transfer: {
        provider: 'across',
        title: 'Bridge to Arbitrum',
        send: usdc(8453, BASE_USDC, 10_000_000n),
        origin: { name: 'Base', nativeSymbol: 'ETH' },
        receive: { kind: 'minimum', amount: usdc(42161, ARB_USDC, 9_960_900n) },
        destination: { name: 'Arbitrum', nativeSymbol: 'ETH' },
        details: [
          { label: 'Recipient', value: 'This account', copy: SIGNER_CHECKSUM },
          { label: 'Fee', value: '0.024964 USDC to JAW' },
          { label: 'Refund to', value: 'This account', copy: SIGNER_CHECKSUM },
          { label: 'Fill by', value: 'Thu, 22 Oct 2026 00:30:35 GMT' },
        ],
      },
      steps: [PLAIN_STEP, PLAIN_STEP],
      alerts: [],
      notices: [],
    });
  });

  it('when the approve is one unit larger than the deposit, then the batch leaves it to the token approvals card', () => {
    const batch = readBridgeBatch(contracts, [approve(BASE_SPOKE_POOL, '989681'), ACROSS_CALLS.prod], SIGNER);
    expect(batch?.notices).toEqual([]);
  });

  it('when the approve goes to the periphery instead of the SpokePool, then the other-contract warning shows', () => {
    const batch = readBridgeBatch(contracts, [approve(BASE_PERIPHERY, '989680'), ACROSS_CALLS.prod], SIGNER);
    expect(batch?.notices).toEqual([OTHER_CONTRACT]);
  });

  it('when the approve is for WETH while the deposit is USDC, then the other-token warning shows', () => {
    const batch = readBridgeBatch(contracts, [{ ...acrossApprove, to: BASE_WETH }, ACROSS_CALLS.prod], SIGNER);
    expect(batch?.notices).toEqual([OTHER_TOKEN]);
  });

  it('when two prod deposits are in one batch, then no transfer shows and the batch does more', () => {
    const batch = readBridgeBatch(contracts, [acrossApprove, ACROSS_CALLS.prod, ACROSS_CALLS.prod], SIGNER);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.steps).toEqual([PLAIN_STEP, PLAIN_STEP, PLAIN_STEP]);
    expect(batch?.notices).toEqual([DOES_MORE]);
  });
});

describe('given the periphery depositNative of across-native-eth', () => {
  it('when it is alone, then the transfer reads 0.01 ETH to Arbitrum with no fee and no warning', () => {
    const batch = readBridgeBatch(contracts, [ACROSS_CALLS.nativeEth], SIGNER);
    expect(batch?.transfer).toMatchObject({
      title: 'Bridge to Arbitrum',
      receive: { kind: 'minimum', amount: { chainId: 42161, amount: 9_991_147_824_020_099n } },
      details: [
        { label: 'Recipient', value: 'This account', copy: SIGNER_CHECKSUM },
        { label: 'Refund to', value: 'This account', copy: SIGNER_CHECKSUM },
        { label: 'Fill by', value: 'Thu, 22 Oct 2026 15:41:35 GMT' },
      ],
    });
    expect(batch?.steps).toEqual([PLAIN_STEP]);
    expect(batch?.notices).toEqual([]);
  });

  it('when an approve comes before it, then the approve does not pair since nothing is pulled, and the batch does more', () => {
    const batch = readBridgeBatch(contracts, [approve(BASE_PERIPHERY, '989680'), ACROSS_CALLS.nativeEth], SIGNER);
    expect(batch?.transfer).toMatchObject({ title: 'Bridge to Arbitrum' });
    expect(batch?.notices).toEqual([DOES_MORE, UNPAIRED]);
  });
});

describe('given an Across deposit that swaps on one side', () => {
  it('when it swaps on the destination, then the transfer names the bought token with no amount', () => {
    const batch = readBridgeBatch(contracts, [approve(BASE_SPOKE_POOL, '989680'), ACROSS_CALLS.usdcToArb], SIGNER);
    expect(batch?.transfer?.receive).toEqual({ kind: 'swap', chainId: 42161, token: { address: ARB, known: false } });
    expect(batch?.steps).toEqual([PLAIN_STEP, PLAIN_STEP]);
    expect(batch?.alerts).toEqual([]);
    expect(batch?.notices).toEqual([`This screen does not know the token ${ARB}. Check it before you confirm.`]);
  });

  it('when a byte trails the deposit, then its step and the batch carry the red Across alert', () => {
    const call = { ...ACROSS_CALLS.usdcToArb, data: ACROSS_CALLS.usdcToArb.data + '00' };
    const batch = readBridgeBatch(contracts, [approve(BASE_SPOKE_POOL, '989680'), call], SIGNER);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.steps).toEqual([PLAIN_STEP, { alert: CANNOT_READ_ACROSS }]);
    expect(batch?.alerts).toEqual([CANNOT_READ_ACROSS]);
  });

  it('when it swaps on the origin, then the approve to the periphery pairs with the USDC it pulls', () => {
    const batch = readBridgeBatch(contracts, [approve(BASE_PERIPHERY, '989680'), ACROSS_CALLS.usdcToWeth], SIGNER);
    expect(batch?.transfer).toMatchObject({
      title: 'Bridge to Arbitrum',
      send: usdc(8453, BASE_USDC, 10_000_000n),
    });
    expect(batch?.notices).toEqual([]);
  });
});

describe('given an Across deposit whose terms are not plain', () => {
  const prod = ACROSS_CALLS.prod;
  const feeTransfer = 'a9059cbb' + word('0xc529edd6d47c60923902514c7c0b3993ae42c2ec') + word('6184');
  const withFee = (recipient: string, amount: string) => ({
    ...prod,
    data: prod.data.replace(feeTransfer, 'a9059cbb' + word(recipient) + word(amount)),
  });
  const ATTACKER = '0x2222222222222222222222222222222222222222';

  it('when the fee goes to an address other than the pinned JAW one, then the fee detail names it and a notice shows', () => {
    const batch = readBridgeBatch(contracts, [withFee(ATTACKER, '6184')], SIGNER);
    expect(batch?.transfer?.details[1]).toEqual({
      label: 'Fee',
      value: `0.024964 USDC to ${ATTACKER}`,
      copy: ATTACKER,
    });
    expect(batch?.notices).toEqual([FEE_NOT_JAW]);
  });

  it('when the JAW fee is any share of the input, then nothing warns about its size', () => {
    const batch = readBridgeBatch(contracts, [withFee('0xc529edd6d47c60923902514c7c0b3993ae42c2ec', '61a9')], SIGNER);
    expect(batch?.transfer?.details[1]).toEqual({ label: 'Fee', value: '0.025001 USDC to JAW' });
    expect(batch?.notices).toEqual([]);
  });

  it('when the recipient is another address, then it shows in full and the not-this-account warning shows', () => {
    const batch = readBridgeBatch(contracts, [ACROSS_CALLS.usdcOtherRecipient], SIGNER);
    expect(batch?.transfer?.details[0]).toEqual({ label: 'Recipient', value: OTHER, copy: OTHER });
    expect(batch?.notices).toEqual([NOT_SIGNER]);
  });

  it('when the refund goes to another address, then it shows in full and the refund warning shows', () => {
    const depositor = '0xad5425c6' + word(SIGNER);
    const batch = readBridgeBatch(
      contracts,
      [{ ...prod, data: prod.data.replace(depositor, '0xad5425c6' + word(OTHER)) }],
      SIGNER
    );
    expect(batch?.transfer?.details[2]).toEqual({ label: 'Refund to', value: OTHER, copy: OTHER });
    expect(batch?.notices).toEqual([REFUND_NOT_SIGNER]);
  });

  it('when the signer comes lowercase, then the recipient and refund still read This account', () => {
    expect(readBridgeBatch(contracts, [prod], SIGNER.toLowerCase() as typeof SIGNER)?.notices).toEqual([]);
  });

  it('when the signer is another account, then both the recipient and the refund warnings show', () => {
    expect(readBridgeBatch(contracts, [prod], OTHER)?.notices).toEqual([
      notThisAccount('The recipient', SIGNER_CHECKSUM),
      notThisAccount('The refund address', SIGNER_CHECKSUM),
    ]);
  });

  it('when the deposit comes before its approve, then the transfer stays with both does-more and unpaired warnings', () => {
    const batch = readBridgeBatch(contracts, [prod, approve(BASE_SPOKE_POOL, '989680')], SIGNER);
    expect(batch?.transfer).toMatchObject({ title: 'Bridge to Arbitrum' });
    expect(batch?.notices).toEqual([DOES_MORE, UNPAIRED]);
  });
});

describe('given an approve the owner must check', () => {
  const USDBC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
  const UNLIMITED = '8' + '0'.repeat(63);

  it.each([
    ['Across', BASE_SPOKE_POOL, ACROSS_CALLS.prod],
    ['Relay', DEPOSITORY, RELAY_USDC_DEPOSIT],
  ])('when an %s approve is for a token not in the table, then a notice shows', (_provider, spender, deposit) => {
    const batch = readBridgeBatch(contracts, [{ ...approve(spender, '989680'), to: USDBC }, deposit], SIGNER);
    expect(batch?.notices).toContain(APPROVE_UNKNOWN);
  });

  it('when the approve is unlimited, then the batch leaves it to the token approvals card', () => {
    const batch = readBridgeBatch(contracts, [approve(BASE_SPOKE_POOL, UNLIMITED), ACROSS_CALLS.prod], SIGNER);
    expect(batch?.notices).toEqual([]);
  });

  it('when the table in use is the snapshot, then an unknown token adds the refresh line, and a live table does not', () => {
    const calls = [{ ...approve(BASE_SPOKE_POOL, '989680'), to: USDBC }, ACROSS_CALLS.prod];
    const snapshot = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS }, 'snapshot');
    const stale = 'This screen could not refresh its list of bridge contracts.';
    expect(readBridgeBatch(snapshot, calls, SIGNER)?.notices).toContain(stale);
    expect(readBridgeBatch(contracts, calls, SIGNER)?.notices).not.toContain(stale);
  });
});
