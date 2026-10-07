import { usdcForNetwork, X402_UPTO_PROXY_ADDRESS, type ChainClients } from '@jaw.id/agent';
import {
  encodeEventTopics,
  encodeFunctionData,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { confirmByReceipt } from './confirm';

const network = 'eip155:84532';
const usdc = usdcForNetwork(network)!;
const payer: Address = '0x1111111111111111111111111111111111111111';
const payTo: Address = '0x2222222222222222222222222222222222222222';
const facilitator: Address = '0x3333333333333333333333333333333333333333';
const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const SETTLE = parseAbi([
  'struct TokenPermissions { address token; uint256 amount; }',
  'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
  'struct Witness { address to; address facilitator; uint256 validAfter; }',
  'struct EIP2612Permit { uint256 value; uint256 deadline; bytes32 r; bytes32 s; uint8 v; }',
  'function settle(PermitTransferFrom permit, uint256 amount, address owner, Witness witness, bytes signature)',
  'function settleWithPermit(EIP2612Permit permit2612, PermitTransferFrom permit, uint256 amount, address owner, Witness witness, bytes signature)',
]);
const NONCE = 0x77n;

const PERMIT = { permitted: { token: usdc.address, amount: 50_000n }, nonce: NONCE, deadline: 9_999_999_999n };
const WITNESS = { to: payTo, facilitator, validAfter: 0n };

/** The proxy's settle call for this authorization, with what differs from it in `over`. */
function settle(over: { nonce?: bigint; owner?: Address; to?: Address; amount?: bigint } = {}): Hex {
  return encodeFunctionData({
    abi: SETTLE,
    functionName: 'settle',
    args: [
      { ...PERMIT, nonce: over.nonce ?? NONCE },
      over.amount ?? 1000n,
      over.owner ?? payer,
      { ...WITNESS, to: over.to ?? payTo },
      '0x',
    ],
  });
}

/** A successful transaction to `to` with `input` whose receipt moves `moved` from payer to payTo. */
function chain(input: Hex, to: Address = X402_UPTO_PROXY_ADDRESS, moved = 1000n): ChainClients {
  const node = {
    waitForTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      logs: [
        {
          address: usdc.address,
          topics: encodeEventTopics({ abi: TRANSFER, eventName: 'Transfer', args: { from: payer, to: payTo } }),
          data: pad(toHex(moved)),
        },
      ],
    }),
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getTransaction: async () => ({ to, input }),
  };
  return { publicClient: () => node as unknown as PublicClient };
}

const attempt = {
  payer,
  nonce: toHex(NONCE, { size: 32 }),
  scheme: 'upto',
  network,
  payTo,
  authorized: 50_000n,
  signedAt: new Date(Date.now() - 10_000),
};
const TX = `0x${'ab'.repeat(32)}` as Hex;
const confirm = (clients: ChainClients) => confirmByReceipt(attempt, TX, clients, 1000);

describe('confirming an upto payment', () => {
  it('builds its settle calls with the selectors the deployed proxy dispatches on', () => {
    expect(SETTLE.map((f) => toFunctionSelector(f))).toEqual(['0xff11e7b4', '0x016c1748']);
  });

  it('settles the proxy call that spent this payer nonce, at the amount it moved', async () => {
    expect(await confirm(chain(settle()))).toMatchObject({ amount: 1000n, txHash: TX });
  });

  it('settles the proxy call that also ran an EIP-2612 permit', async () => {
    const permit2612 = { value: 50_000n, deadline: 0n, r: pad('0x0'), s: pad('0x0'), v: 27 };
    const input = encodeFunctionData({
      abi: SETTLE,
      functionName: 'settleWithPermit',
      args: [permit2612, PERMIT, 1000n, payer, WITNESS, '0x'],
    });
    expect(await confirm(chain(input))).toMatchObject({ amount: 1000n });
  });

  it('refuses a zero-value transferFrom that carries the nonce in its call data', async () => {
    const zero = (encodeFunctionData({
      abi: parseAbi(['function transferFrom(address,address,uint256)']),
      args: [payer, payTo, 0n],
    }) + pad(toHex(NONCE)).slice(2)) as Hex;
    expect(await confirm(chain(zero, usdc.address, 0n))).toBeUndefined();
  });

  it('refuses the settle call data sent anywhere but the proxy', async () => {
    expect(await confirm(chain(settle(), facilitator))).toBeUndefined();
  });

  it('refuses a settlement of another nonce, owner or recipient', async () => {
    expect(await confirm(chain(settle({ nonce: NONCE + 1n })))).toBeUndefined();
    expect(await confirm(chain(settle({ owner: facilitator })))).toBeUndefined();
    expect(await confirm(chain(settle({ to: facilitator })))).toBeUndefined();
  });

  it('refuses when the transfer differs from the amount the proxy settled', async () => {
    expect(await confirm(chain(settle({ amount: 1n })))).toBeUndefined();
  });
});
