import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, zeroAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { QUOTE_TYPES, readAcrossAttestation } from './acrossAttestation';
import { ACROSS_ATTESTED_QUOTES, ACROSS_QUOTES_LIVE_AT, ACROSS_QUOTE_DEPOSITOR } from './acrossAttestation.fixtures';
import type { BridgeCall } from './view';

const { erc20, native, robinhood } = ACROSS_ATTESTED_QUOTES;
const ACCOUNT = ACROSS_QUOTE_DEPOSITOR;
const STORE = '0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const OTHER = '0x2222222222222222222222222222222222222222';
const ANVIL_FIRST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const STRANGER = privateKeyToAccount(ANVIL_FIRST_KEY);

const read = (input: unknown, calls: BridgeCall[], account: Address = ACCOUNT, now = ACROSS_QUOTES_LIVE_AT) =>
  readAcrossAttestation(input, calls, account, now);

type Attestation = typeof erc20.attestation;
const capability = (attestation: Attestation) => ({ optional: true, attestation });
const edited = (edit: (attestation: Attestation) => void, quote = erc20) => {
  const attestation = structuredClone(quote.attestation);
  edit(attestation);
  return capability(attestation);
};
const approveCall = (spender: string, amount: bigint, token = BASE_USDC): BridgeCall => ({
  chainId: 8453,
  to: token,
  value: '0',
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as `0x${string}`, amount] }),
});
const [APPROVE, STORE_CALL] = erc20.calls;
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
const storeWithAmount = (amount: bigint) => ({
  ...STORE_CALL,
  data: STORE_CALL.data.slice(0, 2 + 8 + 128) + word(amount.toString(16)),
});

describe('given a live Across quote and the calls it signed', () => {
  it('when the USDC to Arbitrum quote is read, then the order is what Across signed, with no refund', async () => {
    expect(await read(capability(erc20.attestation), erc20.calls)).toEqual({
      orderId: '0xc9e948ec69724498f977735755b35b79f27c735002cc60ba92a3f6a5b80931f1',
      destinationChainId: 42161,
      token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      recipient: ACCOUNT,
      minAmount: 9_910_089n,
      refund: null,
      expiresAt: 1_795_182_104,
    });
  });

  it('when the ETH to Arbitrum quote is read, then the refund goes to the account in ETH or WETH on Base', async () => {
    expect(await read(capability(native.attestation), native.calls)).toEqual({
      orderId: '0x2b32c6471a1e46b24a0fbe567df91db0efc99864cf9cedab6fce8870cee239be',
      destinationChainId: 42161,
      token: zeroAddress,
      recipient: ACCOUNT,
      minAmount: 4_972_917_598_016_540n,
      refund: {
        recipient: ACCOUNT,
        tokens: [
          { chainId: 8453, address: zeroAddress },
          { chainId: 8453, address: '0x4200000000000000000000000000000000000006' },
        ],
      },
      expiresAt: 1_795_182_105,
    });
  });

  it('when the USDC to Robinhood Chain stock quote is read, then the order names the stock token there', async () => {
    expect(await read(capability(robinhood.attestation), robinhood.calls)).toEqual({
      orderId: '0x11b6c567ecf89c9e72d5c9895687acd961d0c4ca7c5c0be1c8e28000eedd17a4',
      destinationChainId: 4663,
      token: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
      recipient: ACCOUNT,
      minAmount: 334_882_914_395_428_028n,
      refund: { recipient: ACCOUNT, tokens: [{ chainId: 8453, address: BASE_USDC }] },
      expiresAt: 1_795_182_106,
    });
  });

  it('when the batch resets the allowance to zero before the signed approve, then it still verifies', async () => {
    const calls = [approveCall(STORE, 0n), ...erc20.calls];
    expect(await read(capability(erc20.attestation), calls)).not.toBeNull();
  });

  it('when the attestation names another signer, then the field is ignored and it still verifies', async () => {
    const attestation = edited((a) => (a.signer = STRANGER.address));
    expect(await read(attestation, erc20.calls)).not.toBeNull();
  });

  it('then every quote is laid out exactly as the screen hashes it', () => {
    for (const quote of [erc20, native, robinhood]) expect(quote.attestation.typedData.types).toEqual(QUOTE_TYPES);
  });
});

describe('given a live Across quote, when the signature does not come from Across over this message', () => {
  it('when a key other than the pinned one signed it, then it is not verified', async () => {
    const { typedData } = erc20.attestation;
    const signature = await STRANGER.signTypedData(typedData as Parameters<typeof STRANGER.signTypedData>[0]);
    const attestation = edited((a) => {
      a.signer = STRANGER.address;
      a.signature = signature;
    });
    expect(await read(attestation, erc20.calls)).toBeNull();
  });

  it.each([
    ['the minimum', (a: Attestation) => (a.typedData.message.destination.minAmount = '99100890')],
    ['the destination chain', (a: Attestation) => (a.typedData.message.destination.token.chainId = '10')],
    ['the recipient', (a: Attestation) => (a.typedData.message.destination.recipient = `0x${word(OTHER)}`)],
    ['the refund recipient', (a: Attestation) => (a.typedData.message.refundPolicy.recipient = `0x${word(OTHER)}`)],
  ])('when %s is changed after signing, then it is not verified', async (_, edit) => {
    expect(await read(edited(edit, robinhood), robinhood.calls)).toBeNull();
  });
});

describe('given a live Across quote, when the clock reaches the time the quote expires', () => {
  const { expiresAt, originValidUntil } = erc20.attestation.typedData.message;
  const expiry = Number(expiresAt) * 1000;

  it('when a second remains, then it verifies', async () => {
    expect(await read(capability(erc20.attestation), erc20.calls, ACCOUNT, expiry - 1000)).not.toBeNull();
  });

  it.each([
    ['at that second', expiry],
    ['a second later', expiry + 1000],
    ['a second before Across stops picking the deposit up', Number(originValidUntil) * 1000 - 1000],
  ])('when it is %s, then it is not verified', async (_, now) => {
    expect(await read(capability(erc20.attestation), erc20.calls, ACCOUNT, now)).toBeNull();
  });
});

describe('given a live Across quote, when the calls are not the ones it signed', () => {
  it.each<[string, BridgeCall[]]>([
    ['the store moves another amount', [APPROVE, storeWithAmount(20_000_000n)]],
    ['the store carries value', [APPROVE, { ...STORE_CALL, value: '1' }]],
    ['the store goes to another address', [APPROVE, { ...STORE_CALL, to: OTHER }]],
    ['the approve is for another amount', [approveCall(STORE, 20_000_000n), STORE_CALL]],
    ['the approve names another spender', [approveCall(OTHER, 10_000_000n), STORE_CALL]],
    ['the approve is on another token', [approveCall(STORE, 10_000_000n, OTHER), STORE_CALL]],
    ['the approve is missing', [STORE_CALL]],
    ['the calls run in another order', [STORE_CALL, APPROVE]],
    ['a call follows the store', [...erc20.calls, approveCall(OTHER, 1n)]],
    ['a call comes before the approve that is not a reset', [approveCall(STORE, 1n), ...erc20.calls]],
    ['the reset is for another spender', [approveCall(OTHER, 0n), ...erc20.calls]],
    ['two resets come first', [approveCall(STORE, 0n), approveCall(STORE, 0n), ...erc20.calls]],
    ['a call is on another chain', [APPROVE, { ...STORE_CALL, chainId: 10 }]],
  ])('when %s, then it is not verified', async (_, calls) => {
    expect(await read(capability(erc20.attestation), calls)).toBeNull();
  });

  it('when the native store sends less value than signed, then it is not verified', async () => {
    const [store] = native.calls;
    const calls = [{ ...store, value: (BigInt(store.value) - 1n).toString() }];
    expect(await read(capability(native.attestation), calls)).toBeNull();
  });

  it('when another account sends the batch, then it is not verified, since Across funds from the depositor', async () => {
    expect(await read(capability(erc20.attestation), erc20.calls, OTHER)).toBeNull();
  });
});

describe('given a live Across quote, when its domain is not the one for this chain', () => {
  it.each([
    ['chain id is another chain', (a: Attestation) => (a.typedData.domain.chainId = 10)],
    ['name is another name', (a: Attestation) => (a.typedData.domain.name = 'Across')],
    ['version is another version', (a: Attestation) => (a.typedData.domain.version = '2')],
    ['verifying contract is set', (a: Attestation) => (a.typedData.domain.verifyingContract = STORE)],
    ['primary type is another type', (a: Attestation) => (a.typedData.primaryType = 'Origin')],
    ['scheme is another scheme', (a: Attestation) => (a.scheme = 'eip191')],
  ])('when the %s, then it is not verified', async (_, edit) => {
    expect(await read(edited(edit), erc20.calls)).toBeNull();
  });
});

describe('given a capability that is missing or malformed', () => {
  const huge = edited((a) => ((a as { padding?: string }).padding = 'x'.repeat(40_000)));
  it.each<[string, unknown]>([
    ['it is absent', undefined],
    ['it is null', null],
    ['it has no attestation', { optional: true }],
    ['the attestation is empty', { optional: true, attestation: {} }],
    ['the signature is cut short', edited((a) => (a.signature = a.signature.slice(0, 66)))],
    [
      'the message carries a field the signature does not cover',
      edited((a) => Object.assign(a.typedData.message, { note: 'x' })),
    ],
    ['an amount is not a decimal string', edited((a) => (a.typedData.message.destination.minAmount = '0x10'))],
    ['it is too large to read', huge],
  ])('when %s, then it is not verified', async (_, input) => {
    expect(await read(input, erc20.calls)).toBeNull();
  });

  it('when there are no calls, then it is not verified', async () => {
    expect(await read(capability(erc20.attestation), [])).toBeNull();
  });

  it('when the calls and the domain name a chain id that is not a whole number, then it is not verified', async () => {
    const attestation = edited((a) => (a.typedData.domain.chainId = 8453.5));
    const calls = erc20.calls.map((call) => ({ ...call, chainId: 8453.5 }));
    await expect(read(attestation, calls)).resolves.toBeNull();
  });

  it('when a call has no address, then it is not verified', async () => {
    const calls = [{ ...APPROVE, to: undefined as unknown as string }, STORE_CALL];
    await expect(read(capability(erc20.attestation), calls)).resolves.toBeNull();
  });
});
