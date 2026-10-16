// ============================================================================
// Clear-signing (ERC-7730 / EIP-712 + calldata) — public barrel.
// ----------------------------------------------------------------------------
// Split into focused modules so the security-critical resolvers stay isolated
// from the @jaw.id/core-dependent formatter:
//   types    — shared descriptor / display types (no runtime deps)
//   path     — ERC-7730 path resolution (core-free)
//   source   — descriptor source + `includes` merge (core-free)
//   eip712   — typed-data resolver + type hashing (core-free)
//   calldata — calldata resolver + decoding (core-free)
//   format   — DisplayRow formatter + token/native helpers (imports @jaw.id/core)
// Consumers import from '../utils/clearSigning'; this barrel preserves the API.
// ============================================================================

export * from './types';
export * from './path';
export * from './source';
// Named, not `export *`: format.ts also holds read-failure helpers for this package's
// identity cache, which are not part of the public surface.
export { applyFormat, createTokenResolver, getNativeSymbol, getNativeDecimals } from './format';
export * from './eip712';
export * from './calldata';
