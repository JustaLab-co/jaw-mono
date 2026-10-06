import { usdcForNetwork, firstOperationCost, gasReserve, formatUsdc } from '@jaw.id/agent';
import { usdcBalance } from './balance.js';

/**
 * Why a session cannot be set up yet, or null when it can.
 *
 * The grant carries a small transfer to the session account, so its first
 * operation can pay its own fee instead of needing someone to sponsor it, and
 * that transfer comes out of the account approving the permission. Granting
 * anyway leaves a permission that cannot be used until the account is funded and
 * the whole setup is run again, which revokes and re-grants.
 *
 * The account is only knowable here: it is whichever one the user connects with
 * in the browser, and the grant response is what would otherwise report it.
 */
export interface OwnerFundingCheck {
  chainId: number;
  /** The open browser bridge, asked for the connected account. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Injected for tests. */
  readBalance?: (network: string, owner: `0x${string}`) => Promise<bigint>;
}

export async function whyOwnerCannotFundSession(check: OwnerFundingCheck): Promise<string | null> {
  const asset = usdcForNetwork(`eip155:${check.chainId}`);
  // No USDC on this chain is no x402 grant to fund, and the preset would not
  // have built one either.
  if (!asset) return null;

  const accounts = (await check.request('eth_requestAccounts')) as string[] | undefined;
  const owner = accounts?.[0];
  if (!owner) return null;

  const read =
    check.readBalance ??
    (async (network: string, address: `0x${string}`) => BigInt((await usdcBalance(network, address)).raw));

  let held: bigint;
  try {
    held = await read(asset.wireNetwork, owner as `0x${string}`);
  } catch {
    // An unreachable RPC is not a reason to refuse a grant. This check exists to
    // fail early with a readable message; the wallet makes the same one against
    // its own node before building the transfer, and skips it when the account
    // cannot cover it. Losing the early warning costs a clearer error, not the
    // guarantee.
    return null;
  }

  const needed = gasReserve(asset);
  if (held >= needed) return null;

  return (
    `${owner} holds ${formatUsdc(held.toString(), asset.decimals)} on chain ${check.chainId}, and setting up a ` +
    `session needs at least ${formatUsdc(needed.toString(), asset.decimals)} there. That much rides along in the ` +
    'grant so the session can pay for its own first transaction. Fund the account and run this again.'
  );
}

/**
 * Why the session cannot pay for anything yet, or null when it can.
 *
 * The counterpart to the check above, on the other side of the grant. That one
 * refuses to grant when the account could not afford to seed the session; this
 * one runs after a grant it could afford, and catches a session that came out
 * unable to send anything.
 *
 * Scoped to the x402 preset by its caller, and it has to be. The wallet seeds in
 * whatever token the permission names, picking the first ERC-20 spend in it, and
 * a permission that authorises no spend at all is correctly seeded with nothing.
 * Reading USDC would then be reading the wrong token, or the wrong question. The
 * preset is the one grant that always names USDC.
 *
 * What it does NOT do is diagnose. `buildSpenderPrefundCall` declines for eight
 * different reasons, of which a wallet not implementing the capability is only
 * one: no exchange rate for the token, a granted allowance too small to price
 * against, a paymaster context without gas, an owner balance that no longer
 * covers the seed plus the grant's own fee. So the message states what is true
 * and observable, that the session cannot pay, and offers the causes rather than
 * asserting the one that is most often right.
 */
export interface SpenderFundingCheck {
  chainId: number;
  /** The session account, which is the one that will send and be charged. */
  spender: `0x${string}`;
  /** Injected for tests. */
  readBalance?: (network: string, address: `0x${string}`) => Promise<bigint>;
  /**
   * How long to wait on the node. The session is already created and saved by
   * the time this runs, so a stalled RPC must not hold the command open after
   * its work is done: viem retries three times at ten seconds, which is most of
   * a minute of silence for a warning nobody is waiting on.
   */
  timeoutMs?: number;
}

export async function whySpenderCannotPay(check: SpenderFundingCheck): Promise<string | null> {
  const asset = usdcForNetwork(`eip155:${check.chainId}`);
  // No USDC on this chain means no ERC-20 paymaster to charge, so gas comes
  // from the native balance and an empty USDC balance says nothing.
  if (!asset) return null;

  const read =
    check.readBalance ??
    (async (network: string, address: `0x${string}`) => BigInt((await usdcBalance(network, address)).raw));

  let held: bigint;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), check.timeoutMs ?? 5_000);
    });
    held = await Promise.race([read(asset.wireNetwork, check.spender), expired]);
  } catch {
    // An unreachable or slow node is not a reason to end a successful setup
    // with an alarm.
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Not "holds nothing": a session key is reused by default, so the address can
  // carry dust from a previous life. What matters is whether it can pay for one
  // operation, and a wallet that seeded it priced that operation to do so.
  const needed = firstOperationCost(asset);
  if (held >= needed) return null;

  return (
    `${check.spender} holds ${formatUsdc(held.toString(), asset.decimals)} on chain ${check.chainId}, which is ` +
    `not enough to pay for its first operation. The session pays its own gas, and the grant asked this wallet ` +
    `to send it a little along with the permission. Nothing usable arrived: the wallet may not implement that ` +
    `yet, or it could not price the transfer, or the granted allowance was too small to cover one. Send ` +
    `${formatUsdc(needed.toString(), asset.decimals)} to that address and the session works from there.`
  );
}
