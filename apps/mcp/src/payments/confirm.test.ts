import { usdcForNetwork, type ChainClients } from '@jaw.id/agent';
import { encodeEventTopics, pad, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { confirmByReceipt } from './confirm';

const network = 'eip155:84532';
const usdc = usdcForNetwork(network)!;
const payer: Address = '0x1111111111111111111111111111111111111111';
const payTo: Address = '0x2222222222222222222222222222222222222222';
const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

/** A receipt holding a payer-to-payTo transfer of 1000, mined at `minedAt`, and a Permit2 bitmap. */
function chain(minedAt: Date, nonceSpent: boolean): ChainClients {
  const node = {
    waitForTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      logs: [
        {
          address: usdc.address,
          topics: encodeEventTopics({ abi: TRANSFER, eventName: 'Transfer', args: { from: payer, to: payTo } }),
          data: pad(toHex(1000n)),
        },
      ],
    }),
    getBlock: async () => ({ timestamp: BigInt(Math.floor(minedAt.getTime() / 1000)) }),
    readContract: async () => (nonceSpent ? 1n : 0n),
  };
  return { publicClient: () => node as unknown as PublicClient };
}

const attempt = (signedAt: Date) => ({
  payer,
  nonce: '0x0' as Hex,
  scheme: 'upto',
  network,
  payTo,
  authorized: 50_000n,
  signedAt,
});
const TX = `0x${'ab'.repeat(32)}` as Hex;

describe('confirming an upto payment', () => {
  it('refuses an older transfer the seller names for a new authorization', async () => {
    const signedAt = new Date();
    const older = new Date(signedAt.getTime() - 60 * 60_000);
    expect(await confirmByReceipt(attempt(signedAt), TX, chain(older, true), 1000)).toBeUndefined();
  });

  it('refuses a transfer while the authorization nonce is still unspent', async () => {
    const signedAt = new Date(Date.now() - 10_000);
    expect(await confirmByReceipt(attempt(signedAt), TX, chain(new Date(), false), 1000)).toBeUndefined();
  });

  it('settles a transfer mined after signing once the nonce is spent', async () => {
    const signedAt = new Date(Date.now() - 10_000);
    expect(await confirmByReceipt(attempt(signedAt), TX, chain(new Date(), true), 1000)).toMatchObject({
      amount: 1000n,
      txHash: TX,
    });
  });
});
