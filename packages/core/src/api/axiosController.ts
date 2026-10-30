import axios, { AxiosError, AxiosPromise } from 'axios';
import { BaseResponse } from './types.js';
import { JAW_BASE_URL } from '../constants.js';

export function getBaseUrl(dev = false) {
    if (dev) {
        return 'https://api-staging.justaname.id';
    }
    return JAW_BASE_URL;
}

// The fetch adapter, used where there is no XHR (extension service workers, edge
// runtimes), adds `User-Agent: axios/<version>`. Our API does not allow that
// header in CORS, and Firefox sends it, so the preflight would fail there.
const fetchWithoutUserAgent: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    request.headers.delete('user-agent');
    return fetch(request);
};

/**
 * The instance of axios with the base URL of Backend API.
 * @param dev - Whether to use the staging environment
 * @param customBaseUrl - Optional custom base URL to override the default
 */
export const backendInstance = (dev = false, customBaseUrl?: string) =>
    axios.create({
        baseURL: customBaseUrl ?? getBaseUrl(dev),
        env: { fetch: fetchWithoutUserAgent },
    });

/**
 * Represents the Controlled Axios Promise type.
 * @typeparam T - The type of the data to be returned.
 */
export type ControlledAxiosPromise<T> = AxiosPromise<BaseResponse<T>>;

/**
 * Represents the controlled axios promise.
 * @typeparam T - The type of the data to be returned.
 * @param promise
 * @returns The promise of the data.
 */
export const controlledAxiosPromise = <T>(promise: ControlledAxiosPromise<T>): Promise<T> =>
    promise
        .then((res) => {
            if (res.data.result.data === null) {
                throw new Error(res.data.result.error ?? 'Something went wrong');
            }
            return res.data.result.data as T;
        })
        .catch((err: AxiosError<BaseResponse<null>>) => {
            if (err?.response) {
                if (err?.response?.data?.result) {
                    if (err?.response?.data?.result?.error) {
                        throw Object.assign(new Error(err.response.data.result.error), {
                            status: err.response.status,
                        });
                    }
                }
            }
            throw err;
        });
