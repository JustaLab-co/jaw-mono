/**
 * Where the suites find the two apps. Over plain http the SDK routes every
 * dialog to a popup, since the iframe needs an https origin, so the embedded
 * transport is only exercised with JAW_E2E_HTTPS=1.
 */
export const HTTPS = process.env.JAW_E2E_HTTPS === '1';

const scheme = HTTPS ? 'https' : 'http';
export const KEYS_URL = process.env.JAW_E2E_KEYS_URL ?? `${scheme}://localhost:3001`;
export const PLAYGROUND_URL = process.env.JAW_E2E_PLAYGROUND_URL ?? `${scheme}://localhost:3002`;
