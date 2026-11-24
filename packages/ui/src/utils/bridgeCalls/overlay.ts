import { isAddressEqual } from 'viem';
import type { AcrossContracts, BridgeChain, RelayContracts } from './contracts';

// What the client accepts from the network. The proxy's sync may touch more; a field it starts
// syncing stays ignored until it is added here on purpose.
const ACROSS_SYNCED = [
  'spokePool',
  'periphery',
  'multicallHandler',
  'eventEmitter',
  'wrappedNative',
  'prefundedStore',
] as const satisfies readonly (keyof AcrossContracts)[];
const RELAY_SYNCED = ['depository', 'erc20Routers', 'solvers'] as const satisfies readonly (keyof RelayContracts)[];

function take<T>(base: T, live: T | undefined, keys: readonly (keyof T)[]): T {
  const merged = { ...base };
  for (const key of keys) if (live?.[key] !== undefined) merged[key] = live[key];
  return merged;
}

// A live table that still names the previous periphery as `periphery` leaves one periphery, where
// keeping both would put one address in two roles and reject the whole table.
function takeAcross(base: AcrossContracts, live: AcrossContracts | undefined): AcrossContracts {
  const merged = take(base, live, ACROSS_SYNCED);
  if (merged.previousPeriphery && isAddressEqual(merged.previousPeriphery, merged.periphery)) {
    delete merged.previousPeriphery;
  }
  return merged;
}

export function overlay(
  snapshot: Readonly<Record<number, BridgeChain>>,
  live: Readonly<Record<number, BridgeChain>>
): Record<number, BridgeChain> {
  return Object.fromEntries(
    Object.entries(snapshot).map(([id, chain]) => {
      const fresh = live[Number(id)];
      return [
        id,
        {
          ...chain,
          across: chain.across && takeAcross(chain.across, fresh?.across),
          relay: chain.relay && take(chain.relay, fresh?.relay, RELAY_SYNCED),
        },
      ];
    })
  );
}
