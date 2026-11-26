/**
 * What a passkey's authenticator reported about itself at creation. Every field
 * is optional: undefined means the authenticator or platform did not say, which
 * is different from saying no.
 */
export interface PasskeyAuthenticatorInfo {
    /**
     * Whether the authenticator supports the WebAuthn PRF extension for this
     * credential (`prf.enabled` from the client extension results).
     */
    prfSupported?: boolean;
    /**
     * The authenticator's AAGUID as a lowercase UUID, which identifies the
     * passkey store (e.g. Google Password Manager, iCloud Keychain). Undefined
     * when the platform zeroed it out, which it may do with `attestation: 'none'`.
     */
    aaguid?: string;
    /** BE flag: the credential is allowed to be backed up (synced). */
    backupEligible?: boolean;
    /** BS flag: the credential is currently backed up (synced). */
    backupState?: boolean;
}

// Authenticator data layout (WebAuthn §6.1):
//   rpIdHash (32) | flags (1) | signCount (4) | [attestedCredentialData: aaguid (16) | ...]
const FLAGS_OFFSET = 32;
const AAGUID_OFFSET = 37;
const AAGUID_LENGTH = 16;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKUP_STATE = 0x10;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

/**
 * Read the backup flags and AAGUID from raw authenticator data.
 * @throws If the data is too short to hold the fields it claims to have
 */
export function parseAuthenticatorData(authData: Uint8Array): Omit<PasskeyAuthenticatorInfo, 'prfSupported'> {
    if (authData.length < AAGUID_OFFSET) {
        throw new Error(`Authenticator data too short: ${authData.length} bytes`);
    }
    const flags = authData[FLAGS_OFFSET];
    const info: Omit<PasskeyAuthenticatorInfo, 'prfSupported'> = {
        backupEligible: (flags & FLAG_BACKUP_ELIGIBLE) !== 0,
        backupState: (flags & FLAG_BACKUP_STATE) !== 0,
    };

    if (flags & FLAG_ATTESTED_CREDENTIAL_DATA) {
        if (authData.length < AAGUID_OFFSET + AAGUID_LENGTH) {
            throw new Error(`Authenticator data too short for AAGUID: ${authData.length} bytes`);
        }
        const aaguid = authData.slice(AAGUID_OFFSET, AAGUID_OFFSET + AAGUID_LENGTH);
        if (aaguid.some((byte) => byte !== 0)) info.aaguid = formatUuid(aaguid);
    }
    return info;
}

function formatUuid(bytes: Uint8Array): string {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Get the `authData` byte string out of a CBOR-encoded attestationObject
 * (a map of `fmt`, `attStmt` and `authData`). Walks the top-level map instead
 * of searching for bytes, so content inside `attStmt` cannot be mistaken for it.
 * Supports definite lengths only, which is what CTAP2 canonical CBOR uses.
 * @throws If the object is not a CBOR map or has no `authData` byte string
 */
export function authDataFromAttestationObject(attestationObject: Uint8Array): Uint8Array {
    const reader = new CborReader(attestationObject);
    const head = reader.readHead();
    if (head.major !== 5) throw new Error('attestationObject is not a CBOR map');

    for (let i = 0; i < head.value; i++) {
        const keyHead = reader.readHead();
        if (keyHead.major === 3) {
            const key = new TextDecoder().decode(reader.readBytes(keyHead.value));
            if (key === 'authData') {
                const valueHead = reader.readHead();
                if (valueHead.major !== 2) throw new Error('attestationObject authData is not a byte string');
                return reader.readBytes(valueHead.value);
            }
        } else {
            reader.skipBody(keyHead);
        }
        reader.skipItem();
    }
    throw new Error('attestationObject has no authData');
}

class CborReader {
    private offset = 0;
    constructor(private readonly data: Uint8Array) {}

    readHead(): { major: number; value: number } {
        const initial = this.readByte();
        const major = initial >> 5;
        const info = initial & 0x1f;
        if (info < 24) return { major, value: info };
        if (info === 24) return { major, value: this.readUint(1) };
        if (info === 25) return { major, value: this.readUint(2) };
        if (info === 26) return { major, value: this.readUint(4) };
        if (info === 27) return { major, value: this.readUint(8) };
        throw new Error(`Unsupported CBOR additional info ${info}`);
    }

    readBytes(length: number): Uint8Array {
        if (this.offset + length > this.data.length) throw new Error('CBOR data truncated');
        const bytes = this.data.slice(this.offset, this.offset + length);
        this.offset += length;
        return bytes;
    }

    /** Skip what follows a head already read. */
    skipBody(head: { major: number; value: number }): void {
        switch (head.major) {
            case 0: // unsigned int
            case 1: // negative int
            case 7: // simple / float: value already consumed by readHead
                return;
            case 2: // byte string
            case 3: // text string
                this.readBytes(head.value);
                return;
            case 4: // array
                for (let i = 0; i < head.value; i++) this.skipItem();
                return;
            case 5: // map
                for (let i = 0; i < head.value * 2; i++) this.skipItem();
                return;
            case 6: // tag
                this.skipItem();
                return;
        }
    }

    skipItem(): void {
        this.skipBody(this.readHead());
    }

    private readByte(): number {
        if (this.offset >= this.data.length) throw new Error('CBOR data truncated');
        return this.data[this.offset++];
    }

    private readUint(length: number): number {
        let value = 0;
        for (const byte of this.readBytes(length)) value = value * 256 + byte;
        return value;
    }
}

/**
 * Read the backup flags from the authenticator data of a login (assertion).
 * Logins carry no AAGUID and no PRF support flag, so only the two backup flags
 * are learned here. Never throws: unreadable data gives nothing.
 */
export function readAssertionAuthenticatorInfo(authData: Uint8Array | undefined): PasskeyAuthenticatorInfo {
    if (!authData) return {};
    try {
        const { backupEligible, backupState } = parseAuthenticatorData(authData);
        return { backupEligible, backupState };
    } catch {
        return {};
    }
}

/**
 * Collect what the authenticator reported at creation. Never throws: a
 * credential is still usable without this information, so a parse failure
 * leaves the fields undefined rather than failing account creation.
 */
export function readAuthenticatorInfo(
    attestationObject: Uint8Array | undefined,
    clientExtensionResults: { prf?: { enabled?: boolean } } | undefined
): PasskeyAuthenticatorInfo {
    const info: PasskeyAuthenticatorInfo = {};
    const prfEnabled = clientExtensionResults?.prf?.enabled;
    if (typeof prfEnabled === 'boolean') info.prfSupported = prfEnabled;

    if (attestationObject) {
        try {
            Object.assign(info, parseAuthenticatorData(authDataFromAttestationObject(attestationObject)));
        } catch {
            // Leave aaguid and backup flags unknown.
        }
    }
    return info;
}
