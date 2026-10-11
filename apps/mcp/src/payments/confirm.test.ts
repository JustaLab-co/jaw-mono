import { usdcForNetwork, X402_UPTO_PROXY_ADDRESS, type ChainClients } from '@jaw.id/agent';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import receiptJson from './fixtures/upto-bundle-receipt.json';
import txJson from './fixtures/upto-bundle-tx.json';
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
      to,
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

type RpcLog = (typeof receiptJson.logs)[number];
type World = { receipt: typeof receiptJson; others: RpcLog[]; nonceSetAt: bigint; blockHash: string; down?: string };

const N = BigInt(receiptJson.blockNumber);
const BLOCK_TIME = '0x6ac9991e';
const BUNDLE_NONCE = 18899003587150008777749060612176507154056406888323159840139766848196094455960n;
const owner: Address = '0xB021ED7538F02693C5d3f3bad7f85714E9C702f6';
const [settledLog] = receiptJson.logs.filter((l) => l.address === X402_UPTO_PROXY_ADDRESS.toLowerCase());
const payerTransfer = receiptJson.logs.find((l) => l.topics[1] === pad(owner.toLowerCase() as Hex))!;
const SETTLED_WITH_PERMIT = keccak256(toHex('SettledWithPermit()'));
const NONCE_BITMAP = parseAbi(['function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)']);
const otherTx = `0x${'cd'.repeat(32)}`;
const earlier = {
  ...settledLog,
  blockHash: `0x${'ee'.repeat(32)}`,
  blockNumber: toHex(N - 1n),
  transactionHash: otherTx,
};

/** The real Base Sepolia bundle as a node serves it, with `over` applied. Another block holds another settle. */
function served(over: Partial<World> = {}): ChainClients {
  const world: World = {
    receipt: receiptJson,
    others: [earlier],
    nonceSetAt: N,
    blockHash: receiptJson.blockHash,
    ...over,
  };
  const request = async ({ method, params }: { method: string; params: unknown[] }) => {
    if (method === world.down) throw new Error(`${method} unavailable`);
    if (method === 'eth_getTransactionReceipt') return world.receipt;
    if (method === 'eth_getTransactionByHash') return txJson;
    if (method === 'eth_blockNumber') return toHex(N);
    if (method === 'eth_getBlockByNumber') {
      return { number: params[0], hash: world.blockHash, timestamp: BLOCK_TIME, transactions: [] };
    }
    if (method === 'eth_getLogs') {
      const [{ address, blockHash, topics }] = params as [
        { address: string; blockHash?: string; topics?: (string | string[])[] },
      ];
      return [...world.receipt.logs, ...world.others].filter(
        (l) =>
          l.address === address.toLowerCase() &&
          (!blockHash || l.blockHash === blockHash) &&
          (!topics?.[0] || [topics[0]].flat().includes(l.topics[0]))
      );
    }
    if (method === 'eth_call') {
      const [call, block] = params as [{ data: Hex }, Hex];
      const { args } = decodeFunctionData({ abi: NONCE_BITMAP, data: call.data });
      const used = args[0] === owner && args[1] === BUNDLE_NONCE >> 8n && BigInt(block) >= world.nonceSetAt;
      return pad(toHex(used ? 1n << (BUNDLE_NONCE & 0xffn) : 0n));
    }
    throw new Error(`unserved ${method}`);
  };
  const client = createPublicClient({ transport: custom({ request }) });
  return { publicClient: () => client };
}

const bundled = {
  payer: owner,
  nonce: toHex(BUNDLE_NONCE, { size: 32 }),
  scheme: 'upto',
  network,
  payTo: '0x68b2C058720eB5A54DF7fC2dAb53bBc4327764Cb' as Address,
  authorized: 25_000n,
  signedAt: new Date(Date.now() - 10_000),
};
const confirmBundle = (clients: ChainClients) =>
  confirmByReceipt(bundled, receiptJson.transactionHash as Hex, clients, 5000);
const withLogs = (logs: RpcLog[]) => ({ ...receiptJson, logs });
const rewritten = (change: Partial<RpcLog>) =>
  withLogs(receiptJson.logs.map((l) => (l === payerTransfer ? { ...l, ...change } : l)));

describe('confirming an upto payment settled inside a bundle', () => {
  it('settles the EntryPoint bundle at what the payer moved', async () => {
    expect(await confirmBundle(served())).toMatchObject({ amount: 20_000n, txHash: receiptJson.transactionHash });
  });

  it('refuses a receipt with a second settle', async () => {
    const second = { ...settledLog, logIndex: '0xb2' };
    expect(await confirmBundle(served({ receipt: withLogs([...receiptJson.logs, second]) }))).toBeUndefined();
  });

  it('refuses when another transaction in the block also settled', async () => {
    const other = { ...settledLog, transactionHash: otherTx, logIndex: '0x01' };
    expect(await confirmBundle(served({ others: [earlier, other] }))).toBeUndefined();
  });

  it('refuses when another transaction in the block settled with a permit', async () => {
    const other = { ...settledLog, topics: [SETTLED_WITH_PERMIT], transactionHash: otherTx, logIndex: '0x01' };
    expect(await confirmBundle(served({ others: [earlier, other] }))).toBeUndefined();
  });

  it('settles when the block only settle is a permit settle in this transaction', async () => {
    const receipt = withLogs(
      receiptJson.logs.map((l) => (l === settledLog ? { ...l, topics: [SETTLED_WITH_PERMIT] } : l))
    );
    expect(await confirmBundle(served({ receipt }))).toMatchObject({ amount: 20_000n });
  });

  it('refuses when the block only settle is another transaction', async () => {
    const other = { ...settledLog, transactionHash: otherTx, logIndex: '0x01' };
    const unsettled = withLogs(receiptJson.logs.filter((l) => l !== settledLog));
    expect(await confirmBundle(served({ receipt: unsettled, others: [earlier, other] }))).toBeUndefined();
  });

  it('refuses when the block at that height is no longer the receipt block', async () => {
    expect(await confirmBundle(served({ blockHash: `0x${'ff'.repeat(32)}` }))).toBeUndefined();
  });

  it('refuses when the nonce was already used before the block', async () => {
    expect(await confirmBundle(served({ nonceSetAt: N - 1n }))).toBeUndefined();
  });

  it('refuses when the nonce is still unused at the block', async () => {
    expect(await confirmBundle(served({ nonceSetAt: N + 1n }))).toBeUndefined();
  });

  it('refuses when no transfer comes from the payer', async () => {
    const from = pad(facilitator.toLowerCase() as Hex);
    const receipt = rewritten({ topics: [payerTransfer.topics[0], from, payerTransfer.topics[2]] });
    expect(await confirmBundle(served({ receipt }))).toBeUndefined();
  });

  it('refuses when the payer transfer is of another token', async () => {
    expect(await confirmBundle(served({ receipt: rewritten({ address: facilitator.toLowerCase() }) }))).toBeUndefined();
  });

  it('caps payer transfers to any recipient at the authorized amount', async () => {
    const elsewhere = {
      ...payerTransfer,
      topics: [payerTransfer.topics[0], payerTransfer.topics[1], pad(payTo)],
      logIndex: '0xb2',
    };
    const receipt = withLogs([...receiptJson.logs, { ...elsewhere, data: pad(toHex(10_000n)) }]);
    expect(await confirmBundle(served({ receipt }))).toMatchObject({ amount: 25_000n });
  });

  it('refuses when the nonce cannot be read', async () => {
    expect(await confirmBundle(served({ down: 'eth_call' }))).toBeUndefined();
  });

  it('refuses when the block logs cannot be read', async () => {
    expect(await confirmBundle(served({ down: 'eth_getLogs' }))).toBeUndefined();
  });

  it('refuses a reverted bundle', async () => {
    expect(await confirmBundle(served({ receipt: { ...receiptJson, status: '0x0' } }))).toBeUndefined();
  });
});
