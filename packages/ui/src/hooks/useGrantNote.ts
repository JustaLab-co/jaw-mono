import { useEffect, useMemo, useRef } from 'react';
import { normalizePermissionNote } from '@jaw.id/core';

export interface GrantNote {
  /** The note as the grant will store it, for the screen to show and the grant to send. */
  note?: string;
  /** Why the note was refused, when it breaks the rule. The host shows nothing then. */
  refusal?: string;
}

/**
 * The note of a grant request, checked once for both grant screens. A note that breaks the rule
 * is refused as soon as the screen opens, through `onRefuse`, rather than shown: the grant would
 * refuse it on Confirm anyway, and an SDK from before notes does not check it first.
 *
 * `enabled: false` (a revoke on the same screen) checks nothing.
 */
export function useGrantNote(note: unknown, onRefuse: (reason: string) => void, enabled = true): GrantNote {
  const result = useMemo((): GrantNote => {
    if (!enabled) return {};
    try {
      return { note: normalizePermissionNote(note) };
    } catch (error) {
      return { refusal: error instanceof Error ? error.message : String(error) };
    }
  }, [note, enabled]);

  // A refusal answers the dapp, so it goes out once per screen: the callback is held in a ref so a
  // new one each render does not refuse again, and `refused` keeps the effect from refusing twice
  // when it runs twice (Strict Mode in development).
  const onRefuseRef = useRef(onRefuse);
  onRefuseRef.current = onRefuse;
  const refused = useRef(false);
  useEffect(() => {
    if (result.refusal === undefined || refused.current) return;
    refused.current = true;
    onRefuseRef.current(result.refusal);
  }, [result]);

  return result;
}
