import { BRIDGE_CHAINS, type BridgeChain, type RelayContracts } from './contracts';

export type BridgeTable = { version: number; chains: Readonly<Record<number, BridgeChain>> };

/** What tokens outside the table answered for `symbol()` and `decimals()`, by `readKey`. */
export type TokenReads = ReadonlyMap<string, { symbol: string; decimals: number }>;

export const readKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

export type RelayChain = { chainId: number; relay: RelayContracts };

export class BridgeContracts {
  readonly version: number;
  readonly source: 'live' | 'snapshot';
  readonly chains: Readonly<Record<number, BridgeChain>>;
  readonly reads: TokenReads;
  readonly #relay = new Map<string, RelayChain>();

  constructor({ version, chains }: BridgeTable, source: 'live' | 'snapshot' = 'live', reads: TokenReads = new Map()) {
    this.version = version;
    this.source = source;
    this.chains = chains;
    this.reads = reads;
    for (const [id, { relay }] of Object.entries(chains)) {
      if (relay && !this.#relay.has(relay.protocolChain))
        this.#relay.set(relay.protocolChain, { chainId: Number(id), relay });
    }
    Object.freeze(this);
  }

  withReads(reads: TokenReads): BridgeContracts {
    return new BridgeContracts({ version: this.version, chains: this.chains }, this.source, reads);
  }

  chain(id: number): BridgeChain | undefined {
    return this.chains[id];
  }

  relayByProtocolChain(name: string): RelayChain | undefined {
    return this.#relay.get(name);
  }
}

let snapshot: BridgeContracts | undefined;

export const snapshotContracts = (): BridgeContracts =>
  (snapshot ??= new BridgeContracts({ version: 3, chains: BRIDGE_CHAINS }, 'snapshot'));
