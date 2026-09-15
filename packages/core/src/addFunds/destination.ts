import { standardErrors } from '../errors/index.js';
import type { Address } from '../provider/interface.js';

/**
 * Where funds shown on the Add Funds screen are sent.
 *
 * This is the single place a destination is decided, and it deliberately takes
 * the session's accounts rather than anything the dapp supplied. Reading
 * `accounts[0]` inline at each call site is what would eventually let a
 * dapp-supplied address in; funnelling it through one named function keeps that
 * impossible to do by accident.
 *
 * It is also the seam for smart routing addresses: when a request can be given
 * its own routing address, this function returns that instead, and every caller
 * — the signers, the dialog, the QR — is already asking the right question.
 */
export function resolveDestination(accounts: readonly Address[]): Address {
    const destination = accounts[0];

    // An Add Funds screen with no account would render a QR pointing nowhere, so
    // this is refused as unauthorized rather than shown as an empty state.
    if (!destination) {
        throw standardErrors.provider.unauthorized('wallet_addFunds: no connected account to receive funds');
    }

    return destination;
}
