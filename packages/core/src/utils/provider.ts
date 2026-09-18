import { standardErrors } from '../errors/index.js';
import { RequestArguments } from '../provider/index.js';
import { store } from '../store/index.js';

/**
 * Constructs the JAW RPC URL, appending the API key as a query parameter when
 * there is one. The parameter is dropped rather than sent empty, since
 * `api-key=` with nothing after it reaches the proxy as a malformed key.
 * @param baseUrl The base RPC URL
 * @param apiKey The API key to append to the URL, if the caller has one
 * @returns The constructed URL
 */
export function buildHandleJawRpcUrl(baseUrl: string, apiKey?: string): string {
    return apiKey ? `${baseUrl}/handle?api-key=${apiKey}` : `${baseUrl}/handle`;
}

export async function fetchRPCRequest(request: RequestArguments, rpcUrl: string) {
    const requestBody = {
        ...request,
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
    };
    // Calls made from the keys origin all carry the same `Origin`, so the caller
    // they act on behalf of travels alongside instead of in it.
    const dappOrigin = store.config.get().dappOrigin;

    const res = await fetch(rpcUrl, {
        method: 'POST',
        body: JSON.stringify(requestBody),
        mode: 'cors',
        headers: {
            'Content-Type': 'application/json',
            ...(dappOrigin ? { 'x-dapp-origin': dappOrigin } : {}),
        },
    });

    // Read the body before looking at the status: an error status can still carry
    // a JSON-RPC envelope, and that envelope is the only place a revert reason
    // reaches the dApp. viem's own http transport does the same.
    const body = await res.text().catch(() => '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the result is whatever the method returns, as before
    let envelope: { result?: any; error?: { code?: unknown; message?: unknown } } | undefined;
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') envelope = parsed;
    } catch {
        // Not JSON at all. Either the status below explains it, or the envelope check does.
    }

    // Whether the backend turned this caller down, which is the one failure that
    // answering again cannot change. Carried on the error rather than left to be
    // read off its code: a refusal that arrives inside a JSON-RPC envelope keeps
    // that envelope's own code, so a caller matching on the code alone would see
    // the same refusal as a blip depending on what the backend wrapped it in.
    const refused = res.status === 401 || res.status === 403;

    // A well-formed JSON-RPC error is the answer whatever the status says.
    const rpcError = envelope?.error;
    if (rpcError && typeof rpcError.code === 'number' && typeof rpcError.message === 'string') {
        throw refused ? Object.assign(rpcError, { refused }) : rpcError;
    }

    // A refusal from the proxy is not a JSON-RPC envelope, so destructuring it
    // hands back two undefineds and the call resolves to `undefined` instead of
    // failing. Callers that memoize their result then cache that silence, which
    // is how a rejected wallet_getCapabilities reads as "no capabilities".
    if (!res.ok) {
        const message = `JAW RPC request failed with ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
        throw refused
            ? Object.assign(standardErrors.provider.unauthorized(message), { refused })
            : standardErrors.rpc.internal(message);
    }

    // On a 2xx, anything sitting in `error` is still a failure, however malformed.
    if (rpcError) throw rpcError;

    // A 2xx whose body is not an envelope is the same silence as a refusal: returning
    // undefined here is what wallet_getCapabilities would memoize for a minute. `{}`
    // and `[]` parse as objects and carry no `result`, so the key is what decides.
    if (!envelope || !('result' in envelope)) {
        throw standardErrors.rpc.internal(
            `JAW RPC request returned a body that is not a JSON-RPC response${body ? `: ${body.slice(0, 200)}` : ''}`
        );
    }

    return envelope.result;
}
/**
 * Validates the arguments for an invalid request and returns an error if any validation fails.
 * Valid request args are defined here: https://eips.ethereum.org/EIPS/eip-1193#request
 * @param args The request arguments to validate.
 * @returns An error object if the arguments are invalid, otherwise undefined.
 */
export function checkErrorForInvalidRequestArgs(args: unknown): asserts args is RequestArguments {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw standardErrors.rpc.invalidParams({
            message: 'Expected a single, non-array, object argument.',
            data: args,
        });
    }

    const { method, params } = args as RequestArguments;

    if (typeof method !== 'string' || method.length === 0) {
        throw standardErrors.rpc.invalidParams({
            message: "'args.method' must be a non-empty string.",
            data: args,
        });
    }

    if (params !== undefined && !Array.isArray(params) && (typeof params !== 'object' || params === null)) {
        throw standardErrors.rpc.invalidParams({
            message: "'args.params' must be an object or array if provided.",
            data: args,
        });
    }

    switch (method) {
        case 'eth_sign':
        case 'eth_signTypedData_v2':
        case 'eth_subscribe':
        case 'eth_unsubscribe':
            throw standardErrors.provider.unsupportedMethod();
    }
}
