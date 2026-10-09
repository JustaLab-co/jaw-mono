import type { AccountRecord } from '../account/accountRecord.js';

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

export interface PasskeyAccount {
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

export interface PasskeyRegistrationRequest {
    credentialId: string;
    publicKey: string;
    displayName: string;
}

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
