import { Message } from './message.js';

export interface ConfigMessage extends Message {
    event: ConfigEvent;
}

export type ConfigEvent =
    | 'PopupLoaded'
    | 'PopupUnload'
    | 'PopupReady'
    | 'selectSignerType'
    /** keys -> SDK: embedded flow completed/cancelled; replaces window.close() (no-op in iframes) */
    | 'DialogClose'
    /** keys -> SDK: user or visibility guard requests escaping the iframe to a popup */
    | 'SwitchTransport'
    /** keys -> SDK: connected account hint, persisted dApp-side to survive partitioned/ephemeral iframe storage */
    | 'AccountHint'
    /** SDK -> keys: embedded dialog shown/hidden; drives the keys app's enter animation (mobile bottom sheet) */
    | 'DialogVisibility'
    /** SDK -> keys: carries nothing; lets a popup opened without a referrer learn the opener's origin from the event */
    | 'OpenerPing';

/** Payload of a DialogClose config message. */
export type DialogCloseData = {
    reason: 'completed' | 'cancelled';
};

/**
 * Payload of a DialogVisibility config message (SDK -> keys).
 *
 * The SDK reveals/hides the embedded iframe with a plain visibility flip the
 * keys app cannot observe from inside the frame. This event mirrors those
 * flips so the keys UI can animate its entrance (slide the mobile bottom
 * sheet up) at the moment the user actually sees it. Purely presentational:
 * the keys app must default to "visible" so an older SDK that never sends
 * the event still shows the UI (statically, without the animation).
 */
export type DialogVisibilityData = {
    visible: boolean;
};

/** Payload of a SwitchTransport config message. */
export type SwitchTransportData = {
    to: 'popup';
    reason: 'user' | 'visibility' | 'webauthn-unsupported';
};

/**
 * Payload of an AccountHint config message (keys -> SDK), and the shape the
 * SDK sends back on the handshake as `lastAccount`.
 *
 * Cross-site iframe storage is partitioned everywhere and *ephemeral* in
 * Brave/Safari, so the embedded keys app forgets its accounts between visits.
 * The dApp's own first-party storage is not — so after the user approves a
 * connection, keys sends this hint, the SDK persists it, and the next
 * embedded handshake carries it back so keys can seed its "Continue as"
 * screen. It is a UI hint only: it seeds the account *list*, never auth
 * state, and continuing always runs the full passkey ceremony — which is
 * what derives and stores the address, so no address travels here.
 */
export type AccountHintData = {
    /**
     * Passkey credential ID used for authentication — deliberately the ONLY
     * field. The hint transits dApp-controlled storage, so nothing in it may
     * influence what the keys UI shows or derives: the public key (which
     * derives the smart account address in Account.get) and the display name
     * are resolved from the backend passkey registry at seed time, the same
     * source of truth the sign-in/import path uses. A tampered hint can
     * therefore only point at a different credential — whose passkey
     * ceremony the user cannot complete.
     */
    credentialId: string;
};

/**
 * Validate an account hint from the wire. Both sides gate on this: the SDK
 * before persisting into dApp-side storage, the keys app before resolving it
 * against the backend on a handshake. Extra fields are tolerated here but
 * never propagated — both consumers pick `credentialId` only.
 */
export function isValidAccountHint(hint: unknown): hint is AccountHintData {
    if (!hint || typeof hint !== 'object') return false;
    const h = hint as Record<string, unknown>;
    // Length cap: WebAuthn allows credential IDs up to 1023 bytes, which is
    // exactly 1364 base64url characters (real ones run ~20-64 bytes). Without
    // a cap a broken or hostile keys origin could blow the localStorage quota
    // on both sides of the wire.
    return (
        typeof h.credentialId === 'string' && h.credentialId.length <= 1364 && /^[A-Za-z0-9_-]+$/.test(h.credentialId)
    );
}

/**
 * Sentinel set on a response `failure` (in `failure.data.reason`) when the keys
 * iframe has no usable session and the SDK should re-establish one against the
 * iframe and retry — instead of surfacing a hard "reconnect" error. Carries no
 * secret. Shared by the keys app (emits) and the SDK signer (detects).
 */
export const RECONNECT_REQUIRED = 'JAW_RECONNECT_REQUIRED' as const;

/** True when a thrown protocol failure is the reconnect-required sentinel. */
export function isReconnectRequiredFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const data = (error as { data?: { reason?: unknown } }).data;
    return data?.reason === RECONNECT_REQUIRED;
}

export type SignerType = 'crossPlatform' | 'appSpecific';
