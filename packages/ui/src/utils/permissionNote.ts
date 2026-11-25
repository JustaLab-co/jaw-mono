import { normalizePermissionNote, type GrantPermissionsOptions, type SpenderPrefund } from '@jaw.id/core';

/**
 * The note to show on a revoke screen, from the permission as the relay stored it: trimmed, or
 * undefined when there is none or it breaks the rule. The relay refuses such a note, so the last
 * case only guards the screen against a record written some other way.
 */
export function storedPermissionNote(note: unknown): string | undefined {
  try {
    return normalizePermissionNote(note);
  } catch {
    return undefined;
  }
}

/** The options a grant screen hands `Account.grantPermissions`: the prefund it showed and the note. */
export function grantOptions(
  prefund: SpenderPrefund | null | undefined,
  note: string | undefined
): GrantPermissionsOptions | undefined {
  if (!prefund && !note) return undefined;
  return { ...(prefund ? { prefund } : {}), ...(note ? { note } : {}) };
}
