import { errorMessage } from '../lib/errors.js';
import type { UsdcAsset } from './asset-registry.js';
import { within } from '../lib/within.js';

/**
 * Check the token the CLI names in the paymaster context against what the wallet
 * says the paymaster actually takes on that chain.
 *
 * The CLI has always assumed the two are the same: `session-bridge` puts the
 * registry's USDC in the paymaster context, and `gasReserve` denominates the
 * refill in that same token. Nothing ever checked it. The registry is a hand
 * mirror of the backend's own list, so the day they disagree the userOp goes out
 * naming a token the paymaster does not take, and the error the user sees is
 * about the paymaster rather than about the list.
 *
 * `wallet_getCapabilities` already answers the question per chain, with decimals,
 * so the answer costs one request the dialogs make anyway.
 */

/**
 * Bound the capabilities read, because this runs inside the payment lock.
 *
 * `fetchRPCRequest` in core calls `fetch` with no timeout, and Node's fetch has
 * none by default, which `http.ts` in this package already documents as the
 * reason `FETCH_TIMEOUT_MS` exists. Unbounded here is worse than elsewhere: the
 * heartbeat in `payment-lock.ts` keeps a hung holder looking alive, so nothing
 * would ever break the lock.
 *
 * Short, because this decides nothing. It produces a warning, so it has no
 * business making a payment wait, and a timeout lands in the catch below as one
 * more reason the check could not be made.
 */
const CAPABILITIES_TIMEOUT_MS = 3_000;

/**
 * What is wrong, or null when the wallet and the registry agree.
 *
 * A message rather than a corrected token, and that is the finding rather than a
 * shortcut. Swapping in whatever the paymaster prefers would name a token the
 * payer does not hold: an x402 session is funded in the token it pays in, and
 * `gasReserve`, `firstOperationCost` and every cap in the policy are denominated
 * in it. When the two lists disagree the session is broken whichever token is
 * named, so the useful thing to produce is the disagreement.
 */
export async function whyFeeTokenDisagrees(asset: UsdcAsset, apiKey: string): Promise<string | null> {
  let accepted;
  try {
    // Lazy, like every other core import in the CLI. Core memoises the response
    // for a minute per api key, so repeated sessions in one process pay once.
    const { handleGetCapabilitiesRequest } = await import('@jaw.id/core');
    const capabilities = await within(
      handleGetCapabilitiesRequest(
        { method: 'wallet_getCapabilities', params: [] },
        apiKey,
        true // testnets: a session on Base Sepolia needs its fee token too
      ),
      CAPABILITIES_TIMEOUT_MS
    );
    const feeToken = capabilities[`0x${asset.chainId.toString(16)}`]?.feeToken;
    accepted = feeToken?.supported ? feeToken.tokens.filter((token) => token.feeToken) : [];
  } catch (err) {
    // A proxy blip must not stop a payment. Today's behaviour is the fallback,
    // and it is what every session before this ran on.
    return `Could not check the paymaster's fee tokens (${errorMessage(err)}).`;
  }

  if (accepted.length === 0) {
    return (
      `The wallet lists no ERC-20 fee token for chain ${asset.chainId}, and this session pays its gas in ` +
      `${asset.usdcName}. Its operations will fail at the paymaster until that is resolved.`
    );
  }

  const match = accepted.find((token) => token.address.toLowerCase() === asset.address.toLowerCase());
  if (!match) {
    return (
      `The paymaster takes ${accepted.map((token) => token.symbol).join(', ')} on chain ${asset.chainId}, ` +
      `and this session names ${asset.address}. The x402 asset registry has drifted from the backend's.`
    );
  }

  if (match.decimals !== asset.decimals) {
    return (
      `The wallet reports ${match.decimals} decimals for ${match.symbol} on chain ${asset.chainId} and the ` +
      `registry says ${asset.decimals}. Every gas figure this session sizes is off by that factor.`
    );
  }

  return null;
}
