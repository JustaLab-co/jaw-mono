import { usdcForNetwork, type Call, type GasQuote } from '@jaw.id/agent';
import {
  buildErc20PaymasterContext,
  estimateErc20PaymasterCosts,
  JAW_RPC_URL,
  jawPaymasterUrl,
  toJustanAccount,
} from '@jaw.id/core';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { createBundlerClient, UserOperationReceiptNotFoundError } from 'viem/account-abstraction';
import { config, SUPPORTED_CHAINS } from '@/connections/config';

// JAW's RPC proxy, which serves the bundler methods too.
function rpcUrl(chainId: number) {
  const key = config().paymasterApiKey;
  return `${JAW_RPC_URL}?chainId=${chainId}${key ? `&api-key=${key}` : ''}`;
}

// The owner is named by address only, so this account can estimate and decode
// but never sign: the server prepares, the passkey on the page sends.
async function accountFor(account: Address, chainId: number) {
  const client = createPublicClient({ chain: SUPPORTED_CHAINS[chainId], transport: http(rpcUrl(chainId)) });
  return { client, smart: await toJustanAccount({ client, owners: [account], address: account }) };
}

/** What the ERC-20 paymaster would charge the account in USDC to run these calls. Throws when it cannot say. */
export async function quoteGas(account: Address, chainId: number, calls: Call[]): Promise<GasQuote> {
  const usdc = usdcForNetwork(`eip155:${chainId}`);
  if (!usdc) throw new Error(`no USDC on chain ${chainId}`);
  const { smart } = await accountFor(account, chainId);
  const [estimate] = await estimateErc20PaymasterCosts(
    smart,
    calls.map((c) => ({ to: c.to, data: c.data, value: BigInt(c.value) })),
    { id: chainId, rpcUrl: rpcUrl(chainId) },
    jawPaymasterUrl(chainId, config().paymasterApiKey),
    [{ address: usdc.address, symbol: 'USDC', decimals: usdc.decimals, balance: 0n }]
  );
  if (!estimate) throw new Error('the paymaster returned no estimate');
  return { estimate: estimate.tokenCost.toString(), context: buildErc20PaymasterContext(estimate) };
}

export type UserOpOutcome =
  | { status: 'pending' }
  | {
      status: 'included';
      success: boolean;
      sender: Address;
      txHash: Hex;
      calls: { to: Address; value: bigint; data: Hex }[];
    };

export type ReadUserOp = (target: { chainId: number; account: Address; callsId: Hex }) => Promise<UserOpOutcome>;

/** What the bundler says a `wallet_sendCalls` id ran, decoded through the account's execute and executeBatch. */
export const readUserOp: ReadUserOp = async ({ chainId, account, callsId }) => {
  const { client, smart } = await accountFor(account, chainId);
  const bundler = createBundlerClient({ client, transport: http(rpcUrl(chainId)) });
  const receipt = await bundler.getUserOperationReceipt({ hash: callsId }).catch((err: unknown) => {
    if (err instanceof UserOperationReceiptNotFoundError) return undefined;
    throw err;
  });
  if (!receipt) return { status: 'pending' };
  const { userOperation } = await bundler.getUserOperation({ hash: callsId });
  // A userOp that is not an execute or executeBatch ran none of the stored calls.
  const decoded = await smart.decodeCalls!(userOperation.callData).catch(() => []);
  return {
    status: 'included',
    success: receipt.success,
    sender: receipt.sender,
    txHash: receipt.receipt.transactionHash,
    calls: decoded.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? '0x' })),
  };
};
