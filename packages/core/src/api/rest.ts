import { backendInstance, controlledAxiosPromise, getBaseUrl } from './axiosController.js';
import { Routes, ROUTES } from './routes/index.js';
import { store } from '../store/index.js';
import qs from 'qs';

/**
 * Makes a REST call to the Backend API.
 * @typeparam T - The type of the route.
 * @param route - The route of the API.
 * @param method - The method of the API.
 * @param request - The request of the API.
 * @param headers - The headers of the API.
 * @param pathParams - Optional path parameters to replace in the URL (e.g., { hash: "abc123" } for /permissions/:hash)
 * @param dev - Whether to use the staging environment.
 * @param serverUrl - Optional custom server URL to override the default.
 * @param queryParams - Optional query parameters to append to the URL (for PATCH/PUT with body + query params)
 * @returns The promise of the data.
 */
export const restCall = <
    T extends keyof ROUTES,
    K extends 'GET' | 'POST' | 'DELETE' | 'PATCH',
    U extends ROUTES[T]['request'],
    V extends ROUTES[T]['headers'],
    P extends ROUTES[T]['pathParams'],
    Q extends ROUTES[T] extends { queryParams: infer QP } ? QP : never,
>(
    route: T,
    method: K,
    request: U,
    headers?: V,
    pathParams?: P,
    dev?: boolean,
    serverUrl?: string,
    queryParams?: Q
): Promise<ROUTES[T]['response']> => {
    // Get the route template
    let url = Routes[route];

    // Replace path parameters if provided
    if (pathParams) {
        Object.entries(pathParams as Record<string, string>).forEach(([key, value]) => {
            url = url.replace(`:${key}`, encodeURIComponent(value));
        });
    }

    // Determine params based on method
    // GET: request goes to params
    // PATCH: queryParams goes to params, request goes to data
    // POST/DELETE: request goes to data
    const params = method === 'GET' ? request : method === 'PATCH' && queryParams ? queryParams : undefined;

    // Any backend of ours is told, whichever host it runs on: the proxy, the wallet
    // API, staging. Analytics lives on the wallet API, and a keyless caller has no
    // key there for its workspace to be credited with. The one url that may belong
    // to somebody else is a `serverUrl` an app-specific dApp points at its own server.
    const serverIsOurs = !serverUrl || serverUrl.startsWith(getBaseUrl()) || serverUrl.startsWith(getBaseUrl(true));
    const dappOrigin = serverIsOurs ? store.config.get().dappOrigin : undefined;

    return controlledAxiosPromise<ROUTES[T]['response']>(
        backendInstance(dev, serverUrl).request({
            url,
            method,
            params,
            paramsSerializer: (params) => {
                return qs.stringify(params, { arrayFormat: 'repeat' });
            },
            data: method === 'POST' || method === 'PATCH' ? request : undefined,
            // Calls made from the keys origin all carry the same `Origin`, so the
            // caller they act on behalf of travels alongside instead of in it.
            headers: { ...(headers ?? {}), ...(dappOrigin ? { 'x-dapp-origin': dappOrigin } : {}) },
        })
    );
};
