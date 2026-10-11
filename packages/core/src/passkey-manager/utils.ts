import { createWebAuthnCredential, toWebAuthnAccount } from 'viem/account-abstraction';
import type * as WebAuthnP256 from 'ox/WebAuthnP256';
import * as PublicKey from 'ox/PublicKey';
import { restCall } from '../api/index.js';
import type { PasskeyRegistrationRequest, PasskeyLookupResponse } from './types.js';
import type { WebAuthnAccount } from 'viem/account-abstraction';

/**
 * Low-level WebAuthn credential creation function (viem-compatible).
 * Type derived from ox's WebAuthnP256.createCredential.Options['createFn'].
 * For React Native, use NativePasskeyCreateFn instead.
 */
export type PasskeyCreateFn = NonNullable<WebAuthnP256.createCredential.Options['createFn']>;

/**
 * Low-level WebAuthn credential retrieval function (viem-compatible).
 * Type derived from ox's WebAuthnP256.sign.Options['getFn'].
 * For React Native, use NativePasskeyGetFn instead.
 */
export type PasskeyGetFn = NonNullable<WebAuthnP256.sign.Options['getFn']>;

/**
 * Result from a native passkey creation (bypasses viem's createWebAuthnCredential entirely).
 * Used internally after wrapping a NativePasskeyCreateFn.
 */
export interface NativeCredentialResult {
    id: string;
    publicKey: `0x${string}`;
}

/**
 * Internal create function shape used by createPasskeyUtils.
 * Returns credential data directly without going through viem's WebAuthn flow.
 */
export type InternalNativeCreateFn = (
    username: string,
    rpId: string,
    rpName: string
) => Promise<NativeCredentialResult>;

/**
 * Response shape for native passkey get operations.
 * Matches what react-native-passkey's Passkey.get() returns (base64url strings).
 */
export interface NativePasskeyGetResponse {
    id: string;
    type?: string;
    response: {
        authenticatorData: string; // base64url
        clientDataJSON: string; // base64url
        signature: string; // base64url
    };
}

/**
 * Options shape for native passkey get operations.
 * All binary fields are base64url-encoded strings (matching RN passkey libraries).
 */
export interface NativePasskeyGetOptions {
    challenge: string; // base64url
    rpId: string;
    allowCredentials?: Array<{
        type: string;
        id: string; // base64url
        transports?: string[];
    }>;
    userVerification?: string;
    timeout?: number;
}

/**
 * Response shape for native passkey create operations.
 * Matches what react-native-passkey's Passkey.create() returns (base64url strings).
 */
export interface NativePasskeyCreateResponse {
    id: string;
    rawId?: string;
    type?: string;
    response: {
        attestationObject: string; // base64url
        clientDataJSON: string; // base64url
    };
}

/**
 * Options shape for native passkey create operations.
 * Matches what react-native-passkey's Passkey.create() accepts (base64url strings).
 */
export interface NativePasskeyCreateOptions {
    challenge: string; // base64url
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: Array<{ type: string; alg: number }>;
    authenticatorSelection?: {
        residentKey?: 'discouraged' | 'preferred' | 'required';
        requireResidentKey?: boolean;
        userVerification?: 'discouraged' | 'preferred' | 'required';
        authenticatorAttachment?: 'platform' | 'cross-platform';
    };
}

/**
 * Native passkey get function for React Native.
 * Pass `Passkey.get` from react-native-passkey directly.
 * JAW handles base64url ↔ ArrayBuffer conversion internally.
 */
export type NativePasskeyGetFn = (options: NativePasskeyGetOptions) => Promise<NativePasskeyGetResponse>;

/**
 * Native passkey create function for React Native.
 * Pass `Passkey.create` from react-native-passkey directly.
 * JAW handles challenge generation, user ID encoding, and public key extraction
 * from the attestationObject internally.
 */
export type NativePasskeyCreateFn = (options: NativePasskeyCreateOptions) => Promise<NativePasskeyCreateResponse>;

/**
 * Minimal credential shape returned by both browser WebAuthn and React Native adapters.
 * Matches ox's internal Credential type ({ id, type }) — the minimal contract that
 * both navigator.credentials.get() and custom getFn adapters satisfy.
 */
export interface WebAuthnCredentialResult {
    readonly id: string;
    readonly type: string;
}

/**
 * WebAuthn authentication result
 */
export interface WebAuthnAuthenticationResult {
    credential: WebAuthnCredentialResult;
    challenge: Uint8Array;
}

export interface ImportWebAuthnAuthenticationResult {
    name: string;
    credential: {
        id: string;
        publicKey: `0x${string}`;
    };
}

/**
 * Convert an ArrayBuffer or Uint8Array to a base64url-encoded string.
 * Accepts both because viem/ox may pass either type for challenge and credential IDs.
 */
function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Convert a base64url-encoded string to an ArrayBuffer
 */
function toBuffer(base64url: string): ArrayBuffer {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/**
 * Convert a base64url-encoded string to a Uint8Array
 */
function toBytes(base64url: string): Uint8Array {
    return new Uint8Array(toBuffer(base64url));
}

/**
 * Extract the P-256 public key from a CBOR-encoded attestationObject.
 *
 * Uses the same byte-level COSE key extraction pattern as ox's internal fallback
 * (ox/core/internal/webauthn.ts). Searches for COSE key markers 0x21 (x) and
 * 0x22 (y) with CBOR byte-string prefix [key, 0x58, 0x20] and extracts the
 * 32-byte coordinates to construct the uncompressed P-256 point (0x04 + x + y).
 */
function extractPublicKeyFromAttestation(attestationObjectBase64url: string): `0x${string}` {
    const data = toBytes(attestationObjectBase64url);
    const coordinateLength = 0x20; // 32 bytes per coordinate
    const cborPrefix = 0x58; // CBOR byte string prefix

    const findStart = (key: number): number => {
        const marker = new Uint8Array([key, cborPrefix, coordinateLength]);
        for (let i = 0; i < data.length - marker.length; i++) {
            if (marker.every((byte, j) => data[i + j] === byte)) {
                return i + marker.length;
            }
        }
        throw new PasskeyRegistrationError(
            `Failed to extract public key from attestationObject: COSE key marker 0x${key.toString(16)} not found`
        );
    };

    const xStart = findStart(0x21);
    const yStart = findStart(0x22);

    const publicKey = PublicKey.from(
        new Uint8Array([
            0x04,
            ...data.slice(xStart, xStart + coordinateLength),
            ...data.slice(yStart, yStart + coordinateLength),
        ])
    );

    // The JAW factory's MultiOwnable expects a raw 64-byte P-256 key (x || y),
    // not the 65-byte SEC1 uncompressed form (0x04 || x || y). viem's browser
    // path uses { includePrefix: false } for the same reason — keep them in sync
    // or the factory's _initializeOwners reverts and the bundler returns AA13.
    return PublicKey.toHex(publicKey, { includePrefix: false });
}

/**
 * Wrap a native get function (e.g. Passkey.get) into a viem-compatible PasskeyGetFn.
 * Bridges base64url strings (native) to ArrayBuffers (viem/ox).
 */
export function wrapNativeGetFn(nativeGetFn: NativePasskeyGetFn): PasskeyGetFn {
    return (async (options?: CredentialRequestOptions) => {
        const pk = options?.publicKey;
        if (!pk) {
            throw new Error('publicKey options are required for native passkey get');
        }

        const result = await nativeGetFn({
            challenge: toBase64Url(pk.challenge as ArrayBuffer | Uint8Array),
            rpId: pk.rpId ?? '',
            allowCredentials: pk.allowCredentials?.map((c) => ({
                type: c.type,
                id: toBase64Url(c.id as ArrayBuffer | Uint8Array),
                transports: c.transports as string[] | undefined,
            })),
            userVerification: pk.userVerification,
            timeout: pk.timeout,
        });

        return {
            id: result.id,
            type: result.type ?? 'public-key',
            response: {
                authenticatorData: toBuffer(result.response.authenticatorData),
                clientDataJSON: toBuffer(result.response.clientDataJSON),
                signature: toBuffer(result.response.signature),
            },
        };
    }) as PasskeyGetFn;
}

/**
 * Wrap a native create function (e.g. Passkey.create) into an InternalNativeCreateFn.
 * Handles challenge generation, user ID encoding, and public key extraction
 * from the attestationObject internally.
 */
export function wrapNativeCreateFn(nativeCreateFn: NativePasskeyCreateFn): InternalNativeCreateFn {
    return async (username: string, rpId: string, rpName: string): Promise<NativeCredentialResult> => {
        const result = await nativeCreateFn({
            challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
            rp: { id: rpId, name: rpName },
            user: {
                // 16 random bytes — avoids collisions when two users pick the same username
                id: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
                name: username,
                displayName: username,
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            // Force a discoverable, synced credential so it shows in Google
            // Password Manager / iCloud Keychain. Without this, Android
            // Credential Manager may create a non-discoverable credential
            // (still authenticates via allowCredentials but never appears
            // in the password-manager UI).
            authenticatorSelection: {
                residentKey: 'required',
                requireResidentKey: true,
                userVerification: 'preferred',
            },
        });

        const publicKey = extractPublicKeyFromAttestation(result.response.attestationObject);

        return { id: result.id, publicKey };
    };
}

/**
 * Resolve native passkey functions into viem-compatible getFn and internalNativeCreateFn.
 * nativeGetFn and nativeCreateFn accept the raw RN library functions (base64url-based)
 * and JAW wraps them internally.
 */
export function resolvePasskeyOptions(options: {
    nativeGetFn?: NativePasskeyGetFn;
    nativeCreateFn?: NativePasskeyCreateFn;
}): { getFn?: PasskeyGetFn; internalNativeCreateFn?: InternalNativeCreateFn } {
    const { nativeGetFn, nativeCreateFn } = options;

    return {
        getFn: nativeGetFn ? wrapNativeGetFn(nativeGetFn) : undefined,
        internalNativeCreateFn: nativeCreateFn ? wrapNativeCreateFn(nativeCreateFn) : undefined,
    };
}

/**
 * Custom error for WebAuthn authentication failures
 */
export class WebAuthnAuthenticationError extends Error {
    constructor(
        message: string,
        public override readonly cause?: unknown
    ) {
        super(message);
        this.name = 'WebAuthnAuthenticationError';
    }
}

/**
 * Authenticate with a WebAuthn passkey
 * @param credentialId - The base64url encoded credential ID
 * @param rpId - The relying party identifier (e.g., domain name)
 * @param options - Optional authentication options
 * @returns WebAuthn authentication result with credential and challenge
 * @throws {WebAuthnAuthenticationError} If authentication fails
 */
export async function authenticateWithWebAuthnUtils(
    rpId: string,
    credentialId: string,
    options?: {
        userVerification?: UserVerificationRequirement;
        timeout?: number;
        transports?: AuthenticatorTransport[];
    },
    getFn?: PasskeyGetFn
): Promise<WebAuthnAuthenticationResult> {
    // Check if WebAuthn is supported (skip when custom getFn provided, e.g. React Native)
    if (!getFn && (typeof window === 'undefined' || !window.PublicKeyCredential)) {
        throw new WebAuthnAuthenticationError('WebAuthn is not supported in this environment');
    }
    try {
        // Convert credentialId from base64url to binary format
        const credentialIdBuffer = toBuffer(credentialId);

        // Generate challenge
        const challenge = crypto.getRandomValues(new Uint8Array(32));

        const publicKeyOptions = {
            challenge: challenge,
            rpId: rpId,
            allowCredentials: [
                {
                    id: credentialIdBuffer,
                    type: 'public-key' as const,
                    transports: options?.transports ?? ['internal' as const, 'hybrid' as const],
                },
            ],
            userVerification: options?.userVerification ?? ('preferred' as const),
            timeout: options?.timeout ?? 60000,
        };

        // Perform WebAuthn authentication (use custom getFn if provided)
        const credential = getFn
            ? await getFn({ publicKey: publicKeyOptions })
            : ((await navigator.credentials.get({
                  publicKey: publicKeyOptions,
              })) as WebAuthnCredentialResult | null);

        if (!credential) {
            throw new WebAuthnAuthenticationError('Failed to authenticate with specified passkey');
        }

        return {
            credential,
            challenge,
        };
    } catch (error) {
        if (error instanceof WebAuthnAuthenticationError) {
            throw error;
        }
        throw new WebAuthnAuthenticationError(
            `WebAuthn authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            error
        );
    }
}

/**
 * Create a passkey credential and WebAuthn account.
 * NOTE: This does NOT register the passkey with the backend.
 * Callers must separately call `registerPasskeyInBackend()` or use
 * `PasskeyManager.storePasskeyAccount()` to complete registration.
 */
export async function createPasskeyUtils(
    username: string,
    rpId: string,
    rpName: string,
    createFn?: PasskeyCreateFn,
    nativeCreateFn?: InternalNativeCreateFn,
    getFn?: PasskeyGetFn
): Promise<{
    credentialId: string;
    publicKey: `0x${string}`;
    webAuthnAccount: WebAuthnAccount;
}> {
    // Native create path: bypasses crypto.subtle entirely (React Native)
    if (nativeCreateFn) {
        const nativeResult = await nativeCreateFn(username, rpId, rpName);

        const webAuthnAccount = toWebAuthnAccount({
            credential: {
                id: nativeResult.id,
                publicKey: nativeResult.publicKey,
            },
            getFn,
            rpId,
        });

        return {
            credentialId: nativeResult.id,
            publicKey: nativeResult.publicKey,
            webAuthnAccount,
        };
    }

    // Standard web path
    if (!createFn && (typeof window === 'undefined' || !window.PublicKeyCredential)) {
        throw new PasskeyRegistrationError('WebAuthn is not supported in this environment');
    }

    const credential = await createWebAuthnCredential({
        name: username,
        rp: {
            id: rpId,
            name: rpName,
        },
        createFn,
    });

    const webAuthnAccount = toWebAuthnAccount({
        credential,
        getFn,
        rpId,
    });

    return {
        credentialId: credential.id,
        publicKey: credential.publicKey,
        webAuthnAccount,
    };
}

/**
 * Resolve rpId: uses the explicit value, falls back to window.location.hostname,
 * or throws in non-browser environments (e.g., React Native).
 */
export function resolveRpId(rpId?: string): string {
    if (rpId) return rpId;
    if (typeof window !== 'undefined') return window.location.hostname;
    throw new Error('rpId is required in non-browser environments (e.g., React Native). Pass rpId explicitly.');
}

export async function importPasskeyUtils(
    getFn?: PasskeyGetFn,
    rpId?: string,
    apiKey?: string,
    serverUrl?: string
): Promise<ImportWebAuthnAuthenticationResult> {
    // Early guard: surface a clear error before the try/catch wraps it as PasskeyLookupError
    const resolvedRpId = resolveRpId(rpId);

    try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));

        const publicKeyOptions = {
            challenge: challenge,
            userVerification: 'preferred' as const,
            timeout: 60000,
            rpId: resolvedRpId,
        };

        const credential = getFn
            ? await getFn({ publicKey: publicKeyOptions })
            : ((await navigator.credentials.get({
                  publicKey: publicKeyOptions,
              })) as WebAuthnCredentialResult);

        if (!credential) {
            throw new Error('No credential selected');
        }

        // credential.id is already the base64url-encoded version of rawId
        const passkeyData = await lookupPasskeyFromBackend(credential.id, apiKey, undefined, serverUrl);

        return {
            name: passkeyData.displayName || 'Passkey',
            credential: {
                id: credential.id,
                publicKey: passkeyData.publicKey,
            },
        };
    } catch (error) {
        throw new PasskeyLookupError(
            `Failed to import passkey: ${error instanceof Error ? error.message : 'Unknown error'}`,
            error
        );
    }
}

/**
 * Custom error for passkey registration failures
 */
export class PasskeyRegistrationError extends Error {
    constructor(
        message: string,
        public override readonly cause?: unknown
    ) {
        super(message);
        this.name = 'PasskeyRegistrationError';
    }
}

/**
 * Custom error for passkey lookup failures
 */
export class PasskeyLookupError extends Error {
    constructor(
        message: string,
        public override readonly cause?: unknown
    ) {
        super(message);
        this.name = 'PasskeyLookupError';
    }
}

/**
 * The origin and path to call for a passkeys URL. The `serverUrl` preference is
 * the passkeys endpoint itself, so a custom server is called exactly at the URL
 * it was configured with: GET and POST at that path.
 */
export function passkeysEndpoint(passkeysUrl: string): { baseUrl: string; path: string } {
    const url = new URL(passkeysUrl);
    return { baseUrl: url.origin, path: url.pathname.replace(/\/+$/, '') || '/' };
}

/**
 * Register a passkey with the backend
 * @param request - The passkey registration request
 * @param apiKey - Optional API key for authentication
 * @param dev - Whether to use the staging environment (ignored when serverUrl is given)
 * @param serverUrl - Optional passkeys endpoint URL (defaults to https://api.justaname.id/wallet/v2/passkeys)
 * @throws {PasskeyRegistrationError} If registration fails
 */
export async function registerPasskeyInBackend(
    request: PasskeyRegistrationRequest,
    apiKey?: string,
    dev?: boolean,
    serverUrl?: string
): Promise<void> {
    const endpoint = serverUrl ? passkeysEndpoint(serverUrl) : undefined;
    try {
        await restCall(
            'REGISTER_PASSKEY',
            'POST',
            request,
            apiKey ? { 'x-api-key': apiKey } : {},
            undefined,
            dev,
            endpoint?.baseUrl,
            undefined,
            endpoint?.path
        );
    } catch (error) {
        throw new PasskeyRegistrationError(
            `Failed to register passkey: ${error instanceof Error ? error.message : 'Unknown error'}`,
            error
        );
    }
}

/**
 * Lookup a single passkey by credential ID from the backend
 * @param credentialId - The credential ID to lookup
 * @param apiKey - Optional API key for authentication
 * @param dev - Whether to use the staging environment (ignored when serverUrl is given)
 * @param serverUrl - Optional passkeys endpoint URL (defaults to https://api.justaname.id/wallet/v2/passkeys)
 * @throws {PasskeyLookupError} If lookup fails or passkey not found
 */
export async function lookupPasskeyFromBackend(
    credentialId: string,
    apiKey?: string,
    dev?: boolean,
    serverUrl?: string
): Promise<PasskeyLookupResponse> {
    const endpoint = serverUrl ? passkeysEndpoint(serverUrl) : undefined;
    try {
        const response = await restCall(
            'LOOKUP_PASSKEYS',
            'GET',
            { credentialIds: [credentialId] },
            apiKey ? { 'x-api-key': apiKey } : {},
            undefined,
            dev,
            endpoint?.baseUrl,
            undefined,
            endpoint?.path
        );

        if (!response.passkeys || response.passkeys.length === 0) {
            throw new PasskeyLookupError(`Passkey not found for credential ID: ${credentialId}`);
        }

        const passkey = response.passkeys[0];
        if (!passkey) {
            throw new PasskeyLookupError(`Passkey not found for credential ID: ${credentialId}`);
        }

        return passkey;
    } catch (error) {
        if (error instanceof PasskeyLookupError) {
            throw error;
        }
        throw new PasskeyLookupError(
            `Failed to lookup passkey: ${error instanceof Error ? error.message : 'Unknown error'}`,
            error
        );
    }
}
