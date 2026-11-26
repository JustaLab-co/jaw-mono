import { useEffect, useRef } from 'react';

/**
 * Hands `refusal` to `onRefuse` once per screen. A refusal answers the dapp, so the callback is
 * held in a ref (a new one each render does not refuse again) and a latch keeps a second effect
 * run (Strict Mode in development) from refusing twice.
 */
export function useRefuseOnce(refusal: string | undefined, onRefuse: (reason: string) => void): void {
  const onRefuseRef = useRef(onRefuse);
  onRefuseRef.current = onRefuse;
  const refused = useRef(false);
  useEffect(() => {
    if (refusal === undefined || refused.current) return;
    refused.current = true;
    onRefuseRef.current(refusal);
  }, [refusal]);
}
