/**
 * Key derivation from a passkey PRF output. Kept apart from signing: nothing
 * here touches the account's signatures, and nothing in signing reads these keys.
 *
 * Each key is HKDF-SHA256(ikm = PRF output, salt = PRF_HKDF_SALT_V1, info = label).
 * A label names one use and carries its version (`jaw.id/<use>/v<N>`), so two
 * uses never share a key and a use can move to new keys by bumping its version.
 * Changing the salt or an existing label changes every key derived with it.
 */

const encoder = new TextEncoder();

/** HKDF salt for every PRF-derived key. Never change it: a new value gives new keys. */
export const PRF_HKDF_SALT_V1 = 'jaw.id/prf/hkdf/v1';

/** `jaw.id/` then one or more lowercase path segments, ending in a version `v<N>`. */
const LABEL_PATTERN = /^jaw\.id\/(?:[a-z0-9][a-z0-9-]*\/)+v[1-9][0-9]*$/;

export function assertPrfLabel(label: string): void {
    if (!LABEL_PATTERN.test(label)) {
        throw new Error(
            `Invalid PRF key label "${label}": expected jaw.id/<use>/v<N>, e.g. jaw.id/backup-encryption/v1`
        );
    }
}

/**
 * HKDF-SHA256 (RFC 5869) through WebCrypto.
 *
 * The copy of `ikm` handed to WebCrypto is zeroed once imported, so this leaves
 * no copy of its own behind. Zeroing stays best effort: the CryptoKey holds the
 * key material internally, where JavaScript cannot clear it.
 */
export async function hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number
): Promise<Uint8Array> {
    // Copied into an ArrayBuffer-backed array, which the WebCrypto types require.
    const ikmCopy = new Uint8Array(ikm);
    let key: CryptoKey;
    try {
        key = await crypto.subtle.importKey('raw', ikmCopy, 'HKDF', false, ['deriveBits']);
    } finally {
        ikmCopy.fill(0);
    }
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: new Uint8Array(info) },
        key,
        length * 8
    );
    return new Uint8Array(bits); // a view over the derived bits, not a copy
}

/**
 * Derive one key for `label` from a 32-byte PRF output. Does not zero the
 * input: the caller owns it.
 * @throws If the PRF output is not 32 bytes or the label is not versioned
 */
export async function deriveKeyFromPrf(prfOutput: Uint8Array, label: string, length = 32): Promise<Uint8Array> {
    if (prfOutput.length !== 32) {
        throw new Error(`PRF output must be 32 bytes, got ${prfOutput.length}`);
    }
    assertPrfLabel(label);
    return hkdfSha256(prfOutput, encoder.encode(PRF_HKDF_SALT_V1), encoder.encode(label), length);
}
