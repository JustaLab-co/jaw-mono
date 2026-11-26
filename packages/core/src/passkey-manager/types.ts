import type { AccountRecord } from '../account/accountRecord.js';
import type { PasskeyAuthenticatorInfo } from './authenticatorData.js';

export type { PasskeyAuthenticatorInfo } from './authenticatorData.js';

export interface PasskeyCredential {
    id: string;
    name: string;
    credential: {
        id: string;
        publicKey: `0x${string}`;
        raw?: unknown;
        [key: string]: unknown;
    };
}

/**
 * A stored passkey account. The authenticator fields (`prfSupported`, `aaguid`,
 * `backupEligible`, `backupState`) are recorded at creation and absent on
 * imported accounts and on entries stored before they existed.
 */
export interface PasskeyAccount extends PasskeyAuthenticatorInfo {
    creationDate: string;
    credentialId: string;
    isImported: boolean;
    username: string;
    publicKey: `0x${string}`;
    address?: `0x${string}`;
    /** What the account was created from; absent on entries stored before records existed. */
    account?: AccountRecord;
}

export interface AuthCheckResult {
    isAuthenticated: boolean;
    address?: string;
}

export interface AuthState {
    isLoggedIn: boolean;
    address: string;
    credentialId: string;
}

export interface PasskeyRegistrationRequest extends PasskeyAuthenticatorInfo {
    credentialId: string;
    publicKey: string;
    displayName: string;
}

/**
 * What became known about a registered passkey after it was created: the
 * fields that changed, sent to `PATCH <passkeys>/:credentialId`.
 */
export type PasskeyUpdateRequest = PasskeyAuthenticatorInfo;

export interface LookupPasskeysRequest {
    credentialIds: string[];
}

export interface PasskeyLookupResponse {
    credentialId: string;
    publicKey: `0x${string}`;
    displayName: string;
}

export interface BackendResponse<T> {
    statusCode: number;
    result: {
        data: T;
        error: null | string;
    };
}

export interface PasskeysByCredIdsResponse {
    passkeys: PasskeyLookupResponse[];
}

export interface AccountByCredIdRequest {
    credentialId: string;
}
