import { standardErrors } from '../errors/index.js';
import { isRecord, optionalChainId, optionalChainIdList } from './paramUtils.js';

const METHOD = 'wallet_addFunds';

/**
 * A wallet_addFunds request after validation, with the chain in hex like every
 * other normalized request.
 *
 * Every field is a hint about what to show. Nothing here can name where the
 * funds go: the destination is the connected account, resolved by the wallet
 * (see `resolveDestination`). A dapp that could name the destination could point
 * the QR at an address the user does not own, while the user is looking at
 * wallet chrome — so an `address` key in the params is ignored rather than
 * honoured.
 *
 * `chainId` and `chains` answer two different questions and are both kept:
 * `chainId` is where the QR points (EIP-681 pins exactly one chain), `chains` is
 * the set the screen offers to deposit on. A dapp that accepts funds on several
 * chains sends `chains`; one that wants a specific chain led sends both.
 */
export interface NormalizedAddFundsParams {
    /** Hex chainId, or undefined when the dapp left the chain to the wallet. */
    chainId?: `0x${string}`;
    /**
     * Hex chainIds the dapp accepts deposits on, deduplicated in order, or
     * undefined when the dapp expressed no preference.
     *
     * Undefined is not the same as a one-entry list. Absent means "the wallet
     * decides what to show", which is every chain the account works on; a list
     * means the dapp is narrowing that, even to one.
     */
    chains?: `0x${string}`[];
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
        chains: optionalChainIdList(params[0].chains, METHOD, 'chains'),
    };
}
