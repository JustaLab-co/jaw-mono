import type { AcrossContracts, BridgeChain, RelayContracts } from './contracts';

// What the client accepts from the network. The proxy's sync may touch more; a field it starts
// syncing stays ignored until it is added here on purpose.
const ACROSS_SYNCED = [
  'spokePool',
  'periphery',
  'multicallHandler',
  'eventEmitter',
  'wrappedNative',
] as const satisfies readonly (keyof AcrossContracts)[];
const RELAY_SYNCED = ['depository', 'erc20Routers', 'solvers'] as const satisfies readonly (keyof RelayContracts)[];

function take<T>(base: T, live: T | undefined, keys: readonly (keyof T)[]): T {
  const merged = { ...base };
  for (const key of keys) if (live?.[key] !== undefined) merged[key] = live[key];
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
          across: chain.across && take(chain.across, fresh?.across, ACROSS_SYNCED),
          relay: chain.relay && take(chain.relay, fresh?.relay, RELAY_SYNCED),
        },
      ];
    })
  );
}
