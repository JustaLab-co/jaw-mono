import { hashDomain, parseAbiItem } from 'viem';
import { publicClientFor } from './balance.js';
import type { UsdcAsset } from './asset-registry.js';
import { within } from '../lib/within.js';

/**
 * Check the EIP-712 domain the registry carries against the one the token
 * actually verifies against.
 *
 * `scheme-exact-evm` signs over `usdcName` and `usdcVersion` whenever a
 * challenge does not advertise its own, and those two strings are a hand mirror
 * of a property of the contract. Getting one wrong is the only mistake in the
 * registry that is silent where it is made: the signature is rejected by the
 * token, which comes back as a failed payment and reserves its whole ceiling
 * against the cap until the authorization expires. Nothing in the CLI ever
 * looked.
 *
 * They are also not guessable. USDC reads `USDC` on three of our testnets and
 * `USD Coin` on Arbitrum Sepolia, and `USD//C on xDai` at version 1 on Gnosis,
 * so the next chain someone adds by pattern is one edit from wrong.
 *
 * A warning, not a correction, and the same reasoning as `whyFeeTokenDisagrees`
 * next door: the registry decides what this session signs for, so replacing its
 * values with whatever the chain reports would move the decision somewhere the
 * user never approved. When the two disagree the useful output is the
 * disagreement.
 */

/**
 * Compared against the separator rather than against `name()` and `version()`.
 *
 * The separator is the only thing a signature depends on, and the two are not
 * always the same question: a FiatToken V2 computes its separator once at
 * initialisation and stores it, so a deployment renamed afterwards reports a
 * `name()` its own verifier does not use. Bridged USDC on Polygon is that case,
 * `USD Coin (PoS)` against a separator built from `USD Coin`. Comparing
 * separators asks the question the payment actually turns on.
 */
const DOMAIN_SEPARATOR = [parseAbiItem('function DOMAIN_SEPARATOR() view returns (bytes32)')] as const;

const EIP712_DOMAIN_TYPE = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const;

/**
 * Bounds the retries, and deliberately above one attempt.
 *
 * The transport under `publicClientFor` allows `RPC_TIMEOUT_MS` (5s) per
 * attempt across three of them, so roughly 15s before a read gives up, which is
 * too long for a check that decides nothing. Anything under 5s is worse than
 * too long: it aborts mid-first-attempt, so a healthy but slow node makes this
 * return null forever, which looks exactly like a check that was never wired.
 */
const READ_TIMEOUT_MS = 7_000;

/** What is wrong, or null when the registry and the token agree. */
export async function whyEip712DomainDisagrees(asset: UsdcAsset): Promise<string | null> {
  let fromRegistry: `0x${string}`;
  let onChain: `0x${string}`;
  try {
    // Inside the try with the read: `hashDomain` throws on an address viem
    // cannot parse, and a typo in a new registry entry would otherwise take
    // `x402 status` down with it, losing the local half of the report that the
    // command exists to print when the network is the thing that is broken.
    fromRegistry = hashDomain({
      domain: {
        name: asset.usdcName,
        version: asset.usdcVersion,
        chainId: BigInt(asset.chainId),
        verifyingContract: asset.address,
      },
      types: EIP712_DOMAIN_TYPE,
    });
    onChain = await within(
      publicClientFor(asset.chainId).readContract({
        address: asset.address,
        abi: DOMAIN_SEPARATOR,
        functionName: 'DOMAIN_SEPARATOR',
      }),
      READ_TIMEOUT_MS
    );
  } catch {
    // Deliberately without the error text. The transport url carries the proxy
    // api key, and viem puts the whole url in its messages, so a reason built
    // from one would reach the MCP client and the ledger's `reason` column.
    // Nothing here is worth that: the check is advisory and a node that did not
    // answer is not a finding.
    return null;
  }

  if (onChain === fromRegistry) return null;

  return (
    `The EIP-712 domain in the x402 asset registry does not match ${asset.address} on chain ${asset.chainId}. ` +
    `A payment this session signs on a challenge that does not advertise its own domain will be rejected by the ` +
    `token, and a rejected payment reserves its whole ceiling against the caps. Fix usdcName and usdcVersion ` +
    `for ${asset.wireNetwork} in asset-registry.ts.`
  );
}
