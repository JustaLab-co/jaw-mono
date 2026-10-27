import { useEffect, useState } from 'react';
import { currentContracts, load } from '../utils/bridgeCalls/load';
import type { BridgeContracts } from '../utils/bridgeCalls/table';

/** Fixed at mount: a refresh that lands later applies to the next dialog. */
export function useBridgeContracts(apiKey?: string): BridgeContracts {
  const [contracts] = useState(currentContracts);
  useEffect(() => {
    void load(apiKey);
  }, [apiKey]);
  return contracts;
}
