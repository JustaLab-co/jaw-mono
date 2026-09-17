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
export { setDappOrigin } from './dappOrigin.js';
