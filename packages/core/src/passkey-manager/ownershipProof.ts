/**
 * Proof that the caller holds a passkey, for the passkey server's update route.
 *
 * Sign-in, import and PRF derivation already ask the passkey to sign a
 * challenge nobody checks. They sign `ownershipChallenge()` instead, and the
 * assertion they get back doubles as the proof: no extra prompt.
 *
 * The server checks the signature against the stored public key, that the
 * challenge carries this prefix and is at most 5 minutes old, the origin, and
 * user presence. The prefix keeps every other assertion of the passkey out:
 * userOps and messages are signed over a 32-byte hash, and those assertions are
 * public on-chain.
 */

export const PASSKEY_UPDATE_CHALLENGE_PREFIX = 'jaw.id/passkey-update/v1';

/** A WebAuthn assertion of the passkey, as the passkey server's update route takes it. Every part is base64url. */
export interface PasskeyOwnershipProof {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
}

/**
 * The challenge for a sign-in, import or PRF prompt: UTF-8
 * `jaw.id/passkey-update/v1:<unix ms>:<16 random bytes, hex>`.
 */
export function ownershipChallenge(): Uint8Array<ArrayBuffer> {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
    return new TextEncoder().encode(
        `${PASSKEY_UPDATE_CHALLENGE_PREFIX}:${Date.now()}:${random}`
    ) as Uint8Array<ArrayBuffer>;
}

type Bytes = ArrayBuffer | Uint8Array;

/**
 * The proof carried by a sign-in, import or PRF assertion, or undefined when
 * there is none to give: a custom getFn that returns no signature, or an origin
 * the server cannot verify (anything but https, such as a native Android app's
 * `android:apk-key-hash:...`). Such an update is sent without a proof.
 *
 * Never throws, so a sign-in never fails over this bookkeeping: an extension
 * that proxies the credential can block reading it (see authenticatorInfoFromAssertion).
 */
export function ownershipProofFromAssertion(credential: unknown): PasskeyOwnershipProof | undefined {
    try {
        const response = (
            credential as {
                response?: { authenticatorData?: Bytes; clientDataJSON?: Bytes; signature?: Bytes };
            } | null
        )?.response;
        if (!response?.authenticatorData || !response.clientDataJSON || !response.signature) {
            return undefined;
        }

        const clientDataJSON = toBytes(response.clientDataJSON);
        const { origin } = JSON.parse(new TextDecoder().decode(clientDataJSON)) as { origin?: unknown };
        if (typeof origin !== 'string' || !origin.startsWith('https://')) {
            return undefined;
        }

        return {
            authenticatorData: toBase64Url(toBytes(response.authenticatorData)),
            clientDataJSON: toBase64Url(clientDataJSON),
            signature: toBase64Url(toBytes(response.signature)),
        };
    } catch {
        return undefined;
    }
}

function toBytes(value: Bytes): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
