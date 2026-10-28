/** Code points a bridge app name may hold on the owner's screens. */
export const BRIDGE_APP_NAME_MAX_LENGTH = 64;

const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Cleans the name a bridge client asks to be shown under on the owner's
 * screens: whitespace is flattened, invisible characters are removed and the
 * cap counts code points, so a surrogate pair is never split. Returns '' when
 * nothing is left, so each caller picks its own fallback.
 */
export function sanitizeBridgeAppName(raw: string, maxLength = BRIDGE_APP_NAME_MAX_LENGTH): string {
    // A second collapse stops a removed zero-width character from leaving two spaces.
    const clean = raw.replace(/\s+/g, ' ').replace(UNSEEN, '').replace(/\s+/g, ' ').trim();
    return Array.from(clean).slice(0, maxLength).join('').trim();
}
