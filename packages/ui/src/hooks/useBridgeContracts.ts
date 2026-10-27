import { useEffect, useRef, useState } from 'react';
import { currentContracts, load } from '../utils/bridgeCalls/load';
import type { BridgeContracts } from '../utils/bridgeCalls/table';

// Each wallet request opens a fresh page, so the first dialog can only see the live table if it
// lands right after the screen opens. Later than this, the table could change under the owner's eyes.
export const SWITCH_WINDOW_MS = 1500;

/** Fixed at mount, except that a dialog that began on the snapshot switches once to a live table that lands within the window. */
export function useBridgeContracts(apiKey?: string): BridgeContracts {
  const [contracts, setContracts] = useState(currentContracts);
  const mountedAt = useRef(Date.now());
  const maySwitch = useRef(contracts.source === 'snapshot');
  useEffect(() => {
    let open = true;
    void load(apiKey).then(() => {
      const next = currentContracts();
      const inWindow = Date.now() - mountedAt.current <= SWITCH_WINDOW_MS;
      if (!open || !maySwitch.current || !inWindow || next.source !== 'live') return;
      maySwitch.current = false;
      setContracts(next);
    });
    return () => {
      open = false;
    };
  }, [apiKey]);
  return contracts;
}
