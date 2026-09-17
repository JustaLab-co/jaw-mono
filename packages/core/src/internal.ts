/**
 * Entry point for keys.jaw.id, not for dApps.
 *
 * What it exports is safe only when the caller is keys itself, so it is kept out of
 * the package's public entry point rather than documented as off limits there.
 */
export { setDappOrigin } from './dappOrigin.js';
