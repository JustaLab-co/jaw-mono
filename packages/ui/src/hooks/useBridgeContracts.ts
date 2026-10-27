import { useEffect, useRef, useState } from 'react';
import { currentContracts, load } from '../utils/bridgeCalls/load';
import type { BridgeContracts } from '../utils/bridgeCalls/table';

// A fresh page opens per request, so the first dialog sees a live table only if it lands right after mount.
// Later than this, the screen could change under the owner's eyes.
export const SWITCH_WINDOW_MS = 1500;

export function useBridgeContracts(apiKey?: string): { contracts: BridgeContracts; settled: boolean } {
  const [contracts, setContracts] = useState(currentContracts);
  const [settled, setSettled] = useState(contracts.source !== 'snapshot');
  const mountedAt = useRef(Date.now());
  const maySwitch = useRef(contracts.source === 'snapshot');
  useEffect(() => {
    let open = true;
    const left = Math.max(SWITCH_WINDOW_MS - (Date.now() - mountedAt.current), 0);
    const windowEnds = setTimeout(() => open && setSettled(true), left);
    void load(apiKey).then(() => {
      if (!open) return;
      const next = currentContracts();
      const inWindow = Date.now() - mountedAt.current <= SWITCH_WINDOW_MS;
      if (maySwitch.current && inWindow && next.source === 'live') {
        maySwitch.current = false;
        setContracts(next);
      }
      setSettled(true);
    });
    return () => {
      open = false;
      clearTimeout(windowEnds);
    };
  }, [apiKey]);
  return { contracts, settled };
}
