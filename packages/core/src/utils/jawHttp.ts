import { http, HttpTransportConfig } from 'viem';

import { store } from '../store/index.js';

/**
 * An http transport that names the dApp this instance acts for, when it was told
 * one. Read per request rather than baked into the transport, because the clients
 * are built before the dApp is known.
 *
 * Only for hosts of ours. A third-party paymaster is a different company's server
 * and has no business learning which dApp the user is on, so callers that may be
 * pointing at one check the url before reaching for this.
 *
 * `onFetchRequest` is this transport's whole point, so it is not a caller's to set.
 */
export function jawHttp(url?: string, config?: Omit<HttpTransportConfig, 'onFetchRequest'>) {
    return http(url, {
        ...config,
        onFetchRequest: (_request, init) => {
            const dappOrigin = store.config.get().dappOrigin;
            if (!dappOrigin) return undefined;

            // viem uses whatever comes back here in place of `init` rather than
            // merging it, so it goes back whole.
            return { ...init, headers: { ...init.headers, 'x-dapp-origin': dappOrigin } };
        },
    });
}
