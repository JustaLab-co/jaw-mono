import * as Base64 from 'ox/Base64';
import { WebAuthnAuthenticationError, type PasskeyGetFn } from '../passkey-manager/utils.js';
import {
    ownershipChallenge,
    ownershipProofFromAssertion,
    type PasskeyOwnershipProof,
} from '../passkey-manager/ownershipProof.js';

/**
 * The PRF input. The authenticator turns (passkey, input) into the same 32 bytes
 * every time, so this must never change: a new value gives every user new keys.
 * Uses are told apart by the HKDF label, not by this input, so one prompt can
 * derive keys for several of them.
 */
export const PRF_SALT_V1 = 'jaw.id/prf/salt/v1';

/** The passkey or its store returned no PRF result, so keys cannot be derived from it. */
export class PrfUnavailableError extends Error {
    constructor(
        message = 'This passkey does not support deriving keys (no PRF result was returned)',
        /** The prompt's assertion, so the missing support can be recorded with a proof (see ownershipProof). */
        readonly proof?: PasskeyOwnershipProof
    ) {
        super(message);
        this.name = 'PrfUnavailableError';
    }
}

export interface PrfEvaluation {
    /** The 32-byte PRF output: zero it after use, never log, store or send it. */
    output: Uint8Array;
    /** The prompt's assertion, as proof of holding the passkey for the passkey server, when it can give one. */
    proof?: PasskeyOwnershipProof;
}

export interface EvaluatePrfOptions {
    /** The relying party the passkey belongs to. In cross-platform mode, keys.jaw.id. */
    rpId: string;
    /** The account's credential (base64url). Only this passkey may answer. */
    credentialId: string;
    /** Custom WebAuthn get function; defaults to navigator.credentials.get. */
    getFn?: PasskeyGetFn;
    timeout?: number;
}

/**
 * Prompt for the account's passkey and evaluate PRF with PRF_SALT_V1.
 * Returns the 32-byte output, which the caller must zero after use and never
 * log, store or send, and the prompt's ownership proof.
 * @throws {PrfUnavailableError} If the passkey returned no PRF result
 * @throws {WebAuthnAuthenticationError} If the prompt failed or was cancelled
 */
export async function evaluatePrf(options: EvaluatePrfOptions): Promise<PrfEvaluation> {
    const { rpId, credentialId, getFn, timeout = 60000 } = options;
    if (!getFn && (typeof window === 'undefined' || !window.PublicKeyCredential)) {
        throw new WebAuthnAuthenticationError('WebAuthn is not supported in this environment');
    }

    const publicKey = {
        // Nothing else checks this challenge, so it doubles as a passkey update
        // proof: recording PRF support then needs no second prompt.
        challenge: ownershipChallenge(),
        rpId,
        allowCredentials: [
            {
                // Copied into an ArrayBuffer-backed array, which the DOM types require.
                id: new Uint8Array(Base64.toBytes(credentialId)),
                type: 'public-key' as const,
                transports: ['internal' as const, 'hybrid' as const],
            },
        ],
        // PRF is only evaluated with user verification; require it rather than
        // let an authenticator skip it and return nothing.
        userVerification: 'required' as const,
        timeout,
        extensions: { prf: { eval: { first: new TextEncoder().encode(PRF_SALT_V1) } } },
    };

    let credential: { id: string; getClientExtensionResults?: () => unknown } | null;
    try {
        credential = (
            getFn ? await getFn({ publicKey }) : await navigator.credentials.get({ publicKey })
        ) as typeof credential;
    } catch (error) {
        throw new WebAuthnAuthenticationError(
            `WebAuthn authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            error
        );
    }
    if (!credential) {
        throw new WebAuthnAuthenticationError('Failed to authenticate with specified passkey');
    }
    if (credential.id !== credentialId) {
        throw new WebAuthnAuthenticationError('A different passkey answered than the one requested');
    }

    const proof = ownershipProofFromAssertion(credential);
    const results = credential.getClientExtensionResults?.() as
        | { prf?: { results?: { first?: ArrayBuffer | Uint8Array } } }
        | undefined;
    const first = results?.prf?.results?.first;
    if (!first) throw new PrfUnavailableError(undefined, proof);

    const source = first instanceof Uint8Array ? first : new Uint8Array(first);
    const output = new Uint8Array(source);
    // Clear the browser's copy so the only one left is the caller's.
    source.fill(0);
    if (output.length !== 32) {
        output.fill(0);
        throw new PrfUnavailableError(`PRF output must be 32 bytes, got ${source.length}`, proof);
    }
    return { output, proof };
}
