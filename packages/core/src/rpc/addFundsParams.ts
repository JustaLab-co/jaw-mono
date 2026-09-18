import { standardErrors } from '../errors/index.js';
import { isRecord, optionalChainId } from './paramUtils.js';

const METHOD = 'wallet_addFunds';

/**
 * A wallet_addFunds request after validation, with the chain in hex like every
 * other normalized request.
 *
 * The only field is a hint about what to show. Nothing here can name where the
 * funds go: the destination is the connected account, resolved by the wallet
 * (see `resolveDestination`). A dapp that could name the destination could point
 * the QR at an address the user does not own, while the user is looking at
 * wallet chrome — so an `address` key in the params is ignored rather than
 * honoured.
 */
export interface NormalizedAddFundsParams {
    /** Hex chainId, or undefined when the dapp left the chain to the wallet. */
    chainId?: `0x${string}`;
}

/**
 * Validates the dapp's params. Runs in `validateSigningRequest`, so a malformed
 * request is refused with -32602 before any dialog opens, in both modes.
 *
 * Absent params are legal, unlike the other normalizers: `wallet_addFunds` with
 * no arguments is the common case and means "show the connected account on the
 * connected chain". That is why this does not use `requireParamsObject`, which
 * refuses an empty envelope.
 */
export function normalizeAddFundsParams(params: unknown): NormalizedAddFundsParams {
    if (params === undefined || params === null) return {};
    if (!Array.isArray(params)) {
        throw standardErrors.rpc.invalidParams(`${METHOD}: expected a single object parameter`);
    }
    if (params.length === 0 || params[0] === undefined || params[0] === null) return {};
    if (!isRecord(params[0])) {
        throw standardErrors.rpc.invalidParams(`${METHOD}: expected a single object parameter`);
    }

    return {
        chainId: optionalChainId(params[0].chainId, METHOD),
    };
}
