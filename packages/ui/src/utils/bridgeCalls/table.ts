import { BRIDGE_CHAINS, type BridgeChain, type RelayContracts } from './contracts';

export type BridgeTable = { version: number; chains: Readonly<Record<number, BridgeChain>> };

export type RelayChain = { chainId: number; relay: RelayContracts };

export class BridgeContracts {
  readonly version: number;
  readonly #chains: Readonly<Record<number, BridgeChain>>;
  readonly #relay = new Map<string, RelayChain>();

  constructor({ version, chains }: BridgeTable) {
    this.version = version;
    this.#chains = chains;
    for (const [id, { relay }] of Object.entries(chains)) {
      if (relay && !this.#relay.has(relay.protocolChain))
        this.#relay.set(relay.protocolChain, { chainId: Number(id), relay });
    }
    Object.freeze(this);
  }

  chain(id: number): BridgeChain | undefined {
    return this.#chains[id];
  }

  relayByProtocolChain(name: string): RelayChain | undefined {
    return this.#relay.get(name);
  }
}

let snapshot: BridgeContracts | undefined;

export const snapshotContracts = (): BridgeContracts =>
  (snapshot ??= new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS }));
