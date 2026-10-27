import { describe, expect, it } from 'vitest';
import { BRIDGE_CHAINS } from './contracts';
import { BridgeContracts, snapshotContracts } from './table';

const contracts = snapshotContracts();
const relayChains = Object.entries(BRIDGE_CHAINS).flatMap(([id, chain]) =>
  chain.relay ? [{ id: Number(id), relay: chain.relay }] : []
);

describe('given the table compiled into the build', () => {
  it('when it is snapshotted twice, then the same table comes back at version 2', () => {
    expect(snapshotContracts()).toBe(contracts);
    expect(contracts.version).toBe(2);
  });

  it('when a pinned chain id is asked for, then its entry comes back', () => {
    expect(contracts.chain(8453)).toBe(BRIDGE_CHAINS[8453]);
  });

  it('when an unknown chain id is asked for, then nothing comes back', () => {
    expect(contracts.chain(999)).toBeUndefined();
  });

  it.each(relayChains)('when Relay chain $id is asked for by its protocol name, then it resolves', ({ id, relay }) => {
    const found = contracts.relayByProtocolChain(relay.protocolChain);
    expect(found?.chainId).toBe(id);
    expect(found?.relay).toBe(relay);
  });

  it('when a name no chain uses is asked for, then nothing comes back', () => {
    expect(contracts.relayByProtocolChain('nowhere')).toBeUndefined();
    expect(contracts.relayByProtocolChain('')).toBeUndefined();
  });

  it('when two chains share a protocol name, then the first one in table order wins', () => {
    const { 1: first, 10: second } = BRIDGE_CHAINS;
    const shared = { ...first.relay!, protocolChain: 'twin' };
    const table = new BridgeContracts({
      version: 7,
      chains: { 1: { ...first, relay: shared }, 10: { ...second, relay: { ...shared } } },
    });
    expect(table.version).toBe(7);
    expect(table.relayByProtocolChain('twin')?.chainId).toBe(1);
  });
});
