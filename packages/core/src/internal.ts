/**
 * Entry point for keys.jaw.id, not for dApps.
 *
 * What it exports is safe only when the caller is keys itself, so it is kept out of
 * the package's public entry point rather than documented as off limits there.
 *
 * ESM only, on purpose. The CJS build is a bundle per entry point, so a second one
 * would carry its own copy of the store: the origin set through it would land in a
 * different instance from the one the request path reads, and the header would go
 * missing with nothing failing. A `require` of this path fails loudly instead.
 */
export { setDappOrigin, dappOriginHeader } from './dappOrigin.js';

// Also used by @jaw.id/ui, which runs on dApp pages in app-specific mode. There it
// adds nothing: only keys sets the origin it reads.
export { jawHttp } from './utils/jawHttp.js';

// Passkey PRF key derivation, cross-platform mode only: in keys the PRF output is
// the same for every app and never leaves keys. Not on the public entry point, so
// app-specific mode (where it would run in the dApp's page) does not offer it.
export { derivePrfKeys, PrfUnavailableError, type EvaluatePrfOptions } from './prf/index.js';
