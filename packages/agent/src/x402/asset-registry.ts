// USDC asset registry, mirrored from the backend's
// `apps/ens/src/external/payment/asset-registry.ts`. Keep this in sync when the
// server adds a chain. `wireNetwork` is the CAIP-2 id used on the x402 v2 wire.
//
// USDC existing on a chain is not enough to list it here. The permission manager
// has to be deployed there too, because a session pays through a permission and
// there is nothing to grant against otherwise. Polygon Amoy was listed and had
// no manager: `eth_getCode` on 0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8
// answers 0x on 80002 and returns the bytecode on 8453 and 137. Check the chain
// before adding an entry, not the token.

export interface UsdcAsset {
  address: `0x${string}`;
  chainId: number;
  wireNetwork: string;
  /** EIP-712 domain `name` for this deployment's USDC. */
  usdcName: string;
  /** EIP-712 domain `version`. */
  usdcVersion: string;
  /**
   * Token decimals. Every USDC deployment here is 6, but carrying it on the
   * registry entry (rather than a literal `6` at the format site) keeps the
   * source of truth in one place and is ready for a non-6-decimal asset when
   * the registry grows past USDC. Reading it off-chain from the contract is
   * deliberately avoided: the registry is a controlled allowlist, so an extra
   * RPC round-trip and trusting a token's self-reported decimals buy nothing.
   */
  decimals: number;
}

export const USDC_BY_NETWORK = {
  'eip155:8453': {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId: 8453,
    wireNetwork: 'eip155:8453',
    usdcName: 'USD Coin',
    usdcVersion: '2',
    decimals: 6,
  },
  'eip155:84532': {
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    chainId: 84532,
    wireNetwork: 'eip155:84532',
    usdcName: 'USDC',
    usdcVersion: '2',
    decimals: 6,
  },
  'eip155:137': {
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    chainId: 137,
    wireNetwork: 'eip155:137',
    usdcName: 'USD Coin',
    usdcVersion: '2',
    decimals: 6,
  },
} as const satisfies Record<string, UsdcAsset>;

/**
 * The chains the registry carries, derived rather than written again.
 *
 * `balance.ts` needs a viem chain for each, and `permit2.ts` allows a subset for
 * `upto`. Stating their key sets by hand leaves the registry and the viem map in
 * step only by a loop that throws at import time, and only in one direction.
 * Deriving makes the compiler hold both directions instead.
 */
type RegisteredAsset = (typeof USDC_BY_NETWORK)[keyof typeof USDC_BY_NETWORK];
export type UsdcChainId = RegisteredAsset['chainId'];

/**
 * Look up USDC metadata by CAIP-2 network id, or `undefined` if unsupported.
 *
 * Own keys only. The network reaches here from a 402 challenge and from the
 * Bazaar catalogue, both untrusted, and a plain index answers `constructor` or
 * `toString` with something off the prototype: callers then read `.address` off
 * a function and throw where they expected an unsupported network.
 */
export function usdcForNetwork(network: string): RegisteredAsset | undefined {
  // The one place an untrusted string meets the closed table, so the widening
  // lives here and nowhere else: the parameter stays `string` because the network
  // arrives from a 402 challenge and from the Bazaar catalogue, while the return
  // carries the registry's own chain id so callers keep it.
  const registry: Record<string, RegisteredAsset> = USDC_BY_NETWORK;
  return Object.hasOwn(registry, network) ? registry[network] : undefined;
}
