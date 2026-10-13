import type {
    PasskeyRegistrationRequest,
    PasskeysByCredIdsResponse,
    LookupPasskeysRequest,
    AccountByCredIdRequest,
} from '../../passkey-manager/types.js';
import type { AccountRecord } from '../../account/accountRecord.js';

/**
 * Passkey API routes
 */
export const PASSKEY_ROUTE = '/wallet/v2/passkeys';

/**
 * Account record API route
 */
export const ACCOUNT_ROUTE = '/wallet/v2/accounts';

/**
 * Route definitions for passkey operations
 */
export interface PasskeyRoutes {
    REGISTER_PASSKEY: {
        request: PasskeyRegistrationRequest;
        response: void;
        headers: Record<string, string>;
        pathParams?: never;
    };
    LOOKUP_PASSKEYS: {
        request: LookupPasskeysRequest;
        response: PasskeysByCredIdsResponse;
        headers: Record<string, string>;
        pathParams?: never;
    };
    GET_ACCOUNT_BY_CREDENTIAL: {
        request: AccountByCredIdRequest;
        response: AccountRecord;
        headers: Record<string, string>;
        pathParams?: never;
    };
}
