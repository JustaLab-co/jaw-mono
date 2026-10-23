import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { BRIDGE_CHAINS, JAW_FEE_RECIPIENT } from './contracts';

const chains = Object.entries(BRIDGE_CHAINS).map(([id, chain]) => ({ id: Number(id), ...chain }));

function addressesOf(chain: (typeof chains)[number]): string[] {
  return [
    ...Object.values(chain.across ?? {}),
    ...(chain.relay ? [chain.relay.depository, chain.relay.erc20Router, ...chain.relay.solvers] : []),
    ...Object.keys(chain.tokens),
  ];
}

describe('given the pinned bridge table of the signing screen', () => {
  it('then it lists every chain a swap can start or end on, testnets included', () => {
    expect(chains.map((c) => c.id).sort((a, b) => a - b)).toEqual([
      1, 10, 56, 100, 130, 137, 143, 1868, 4663, 5042, 8453, 42161, 42220, 43114, 57073, 59144, 84532, 421614, 11155111,
      11155420,
    ]);
  });

  it('then Base reads to the reviewed SpokePool, periphery, handler, emitter, depository and tokens', () => {
    expect(BRIDGE_CHAINS[8453]).toEqual({
      name: 'Base',
      nativeSymbol: 'ETH',
      across: {
        spokePool: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
        periphery: '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4',
        multicallHandler: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
        eventEmitter: '0xBF75133b48b0a42AB9374027902E83C5E2949034',
        wrappedNative: '0x4200000000000000000000000000000000000006',
      },
      relay: {
        depository: '0x4cD00E387622C35bDDB9b4c962C136462338BC31',
        protocolChain: 'base',
        erc20Router: '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f',
        solvers: expect.arrayContaining(['0xf70da97812CB96acDF810712Aa562db8dfA3dbEF']),
      },
      tokens: {
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': { symbol: 'USDC', decimals: 6 },
        '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
      },
    });
  });

  it('then each SpokePool is pinned to its own chain, so the Base address is not the Optimism one', () => {
    expect(BRIDGE_CHAINS[1]?.across?.spokePool).toBe('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5');
    expect(BRIDGE_CHAINS[10]?.across?.spokePool).toBe('0x6f26Bf09B1C792e3228e5467807a900A503c0281');
    expect(BRIDGE_CHAINS[42161]?.across?.spokePool).toBe('0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A');
    expect(BRIDGE_CHAINS[130]?.across?.spokePool).toBe('0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64');
    expect(BRIDGE_CHAINS[84532]?.across?.spokePool).toBe('0x82B564983aE7274c86695917BBf8C99ECb6F0F8F');
  });

  it('then the Relay depository is the production one on mainnets and the testnet one on Sepolia', () => {
    expect(BRIDGE_CHAINS[42161]?.relay?.depository).toBe('0x4cD00E387622C35bDDB9b4c962C136462338BC31');
    expect(BRIDGE_CHAINS[59144]?.relay?.depository).toBe('0x59916DA825D2D2eC1BF878D71c88826F6633ecca');
    expect(BRIDGE_CHAINS[11155111]?.relay?.depository).toBe('0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3');
  });

  it('then each Relay chain carries the protocol chain name Relay uses in its orders', () => {
    const names = Object.fromEntries(chains.flatMap((c) => (c.relay ? [[c.id, c.relay.protocolChain]] : [])));
    expect(names).toEqual({
      1: 'ethereum',
      10: 'optimism',
      56: 'bnb',
      100: 'gnosis',
      130: 'unichain',
      137: 'polygon',
      143: 'monad',
      1868: 'soneium',
      4663: 'robinhood',
      5042: 'arc',
      8453: 'base',
      42161: 'arbitrum',
      42220: 'celo',
      43114: 'avalanche',
      57073: 'ink',
      59144: 'linea',
      84532: 'base-sepolia',
      11155111: 'sepolia',
    });
  });

  it('then every Relay chain fills through its router by solvers listed once, Linea and testnets on their own router', () => {
    for (const chain of chains) {
      const relay = chain.relay;
      if (!relay) continue;
      const solvers = relay.solvers.map((s) => s.toLowerCase());
      expect(solvers.length, `chain ${chain.id}`).toBeGreaterThan(0);
      expect(new Set(solvers).size, `chain ${chain.id}`).toBe(solvers.length);
    }
    expect(BRIDGE_CHAINS[59144]?.relay?.erc20Router).toBe('0x9EF6d3c2F60d7b9008D74CAb1FC0F899c957C819');
    expect(BRIDGE_CHAINS[11155111]?.relay).toMatchObject({
      erc20Router: '0xA1BEa5fe917450041748Dbbbe7E9AC57A4bBEBaB',
      solvers: ['0x3e34b27a9bf37D8424e1a58aC7fc4D06914B76B9'],
      testnet: true,
    });
    expect(BRIDGE_CHAINS[8453]?.relay?.testnet).toBeUndefined();
  });

  it('then BSC USDC has 18 decimals and Arc pays gas in USDC with no wrapped native', () => {
    expect(BRIDGE_CHAINS[56]?.tokens['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d']).toEqual({
      symbol: 'USDC',
      decimals: 18,
    });
    expect(BRIDGE_CHAINS[5042]?.nativeSymbol).toBe('USDC');
    expect(BRIDGE_CHAINS[5042]?.across?.wrappedNative).toBeUndefined();
  });

  it('then the JAW fee recipient is the address the backend sends fees to', () => {
    expect(JAW_FEE_RECIPIENT).toBe('0xC529EDD6D47C60923902514C7C0B3993ae42C2ec');
  });

  it('then every address is checksummed', () => {
    for (const address of [...chains.flatMap(addressesOf), JAW_FEE_RECIPIENT]) {
      expect(address).toBe(getAddress(address));
    }
  });

  it('then no address holds two roles on the same chain', () => {
    for (const chain of chains) {
      const contracts = [...Object.values(chain.across ?? {}), ...(chain.relay ? [chain.relay.depository] : [])];
      for (const list of [contracts, Object.keys(chain.tokens)]) {
        const lower = list.map((a) => a.toLowerCase());
        expect(new Set(lower).size, `chain ${chain.id}`).toBe(lower.length);
      }
    }
  });

  it('then USDC has 6 decimals except on BSC, and every wrapped native token has 18', () => {
    for (const chain of chains) {
      for (const [address, token] of Object.entries(chain.tokens)) {
        const expected = token.symbol === 'USDC' ? (chain.id === 56 ? 18 : 6) : 18;
        expect(token.decimals, `${chain.id} ${address}`).toBe(expected);
        expect(['USDC', 'WETH'], `${chain.id} ${address}`).toContain(token.symbol);
      }
    }
  });

  it('then the wrapped native of an ETH chain is a known WETH token', () => {
    for (const chain of chains.filter((c) => c.nativeSymbol === 'ETH')) {
      const wrapped = chain.across?.wrappedNative;
      if (wrapped) expect(chain.tokens[wrapped], `chain ${chain.id}`).toEqual({ symbol: 'WETH', decimals: 18 });
    }
  });

  it('then bridged USDC variants are left out, so they read as unknown tokens instead of USDC', () => {
    const bridged = {
      8453: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
      10: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
      42161: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
      137: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      43114: '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664',
    };
    for (const [id, address] of Object.entries(bridged)) {
      expect(BRIDGE_CHAINS[Number(id)]?.tokens, `chain ${id}`).not.toHaveProperty([address]);
    }
  });

  it('then the table matches the reviewed digest, so any changed literal updates this test', () => {
    const digest = createHash('sha256').update(JSON.stringify({ BRIDGE_CHAINS, JAW_FEE_RECIPIENT })).digest('hex');
    expect(digest).toBe('c8ee9a873351bccac8c5b6ce1f255125bf6b4966e9e0a2878cf2e9c2102ce500');
  });
});
