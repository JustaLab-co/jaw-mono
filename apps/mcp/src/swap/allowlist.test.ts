import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { isProxyChain } from '@/lib/chain';
import { ALLOWLIST, APP_FEE, ASSETS, MAX_ROUTE_COST_BPS, SOURCES } from './allowlist';
import acrossQuote from './fixtures/prod-across-quote.json';
import relayQuote from './fixtures/prod-relay-quote.json';

const spokePoolAbi = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
]);
const instructionsAbi = [
  {
    type: 'tuple',
    components: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'data', type: 'bytes' },
          { name: 'value', type: 'uint256' },
        ],
      },
      { name: 'fallbackRecipient', type: 'address' },
    ],
  },
] as const;
const erc20Abi = parseAbi(['function transfer(address to, uint256 amount)']);

const MULTICALL_HANDLER = '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E';
const DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31';
const ERC20_ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f';
const MAIN_CHAINS = {
  1: {
    spokePool: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
  },
  8453: {
    spokePool: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  42161: {
    spokePool: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    decimals: 6,
  },
  10: {
    spokePool: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    decimals: 6,
  },
  137: {
    spokePool: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    decimals: 6,
  },
  56: {
    spokePool: '0x4e8E101924eDE233C13e2D8622DC8aED2872d505',
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    decimals: 18,
  },
};

const allowlisted = Object.entries(ALLOWLIST).map(([id, entry]) => ({ chainId: Number(id), ...entry }));
const assets = Object.entries(ASSETS).map(([id, tokens]) => ({ chainId: Number(id), tokens: Object.entries(tokens) }));

function everyAddress(): Address[] {
  const fromAllowlist = allowlisted.flatMap(({ across, relay }) => [
    ...(across ? Object.values(across) : []),
    ...(relay ? [relay.depository, relay.erc20Router, ...relay.solvers] : []),
  ]);
  const fromAssets = assets.flatMap(({ tokens }) => tokens.map(([token]) => token as Address));
  return [...fromAllowlist, ...fromAssets, APP_FEE.recipient];
}

describe('given the pinned swap allowlist', () => {
  it('then every chain it names is a chain the server serves', () => {
    const chains = [...allowlisted, ...assets].map(({ chainId }) => chainId);
    expect(chains.filter((chainId) => !isProxyChain(chainId))).toEqual([]);
  });

  it('then every address is written in its checksummed form', () => {
    expect(everyAddress().filter((address) => getAddress(address) !== address)).toEqual([]);
  });

  it('then USDC has 6 decimals except on BNB Chain, where it has 18, and ETH has 18', () => {
    const wrong = assets.flatMap(({ chainId, tokens }) =>
      tokens
        .filter(([, { asset, decimals }]) => decimals !== (asset === 'USDC' && chainId !== 56 ? 6 : 18))
        .map(([token]) => `${chainId}:${token}`)
    );
    expect(wrong).toEqual([]);
  });

  it('then no chain lists a token, a solver or an Across contract twice', () => {
    for (const { chainId, tokens } of assets) {
      const lower = tokens.map(([token]) => token.toLowerCase());
      expect(new Set(lower).size, `assets on ${chainId}`).toBe(lower.length);
    }
    for (const { chainId, across, relay } of allowlisted) {
      if (relay) expect(new Set(relay.solvers).size, `solvers on ${chainId}`).toBe(relay.solvers.length);
      if (across) expect(new Set(Object.values(across)).size, `across on ${chainId}`).toBe(Object.keys(across).length);
    }
  });

  it('then each Relay protocol chain name maps back to one chain id', () => {
    const names = allowlisted.flatMap(({ relay }) => (relay ? [relay.protocolChain] : []));
    expect(new Set(names).size).toBe(names.length);
  });

  it('then every Relay chain has at least one solver', () => {
    expect(allowlisted.filter(({ relay }) => relay && relay.solvers.length === 0)).toEqual([]);
  });

  it('then where native ETH is an asset, the Across wrapped native token is ETH with 18 decimals', () => {
    for (const { chainId, across } of allowlisted) {
      if (!across || !ASSETS[chainId]?.[zeroAddress]) continue;
      expect(across.wrappedNative && ASSETS[chainId][across.wrappedNative], `wrapped native on ${chainId}`).toEqual({
        asset: 'ETH',
        decimals: 18,
      });
    }
  });

  it('then the contracts of the prod Across and Relay quotes are the Base entries', () => {
    const { across, relay } = ALLOWLIST[8453];
    const [approve, deposit] = acrossQuote.result.data.transactions;
    const [relayDeposit] = relayQuote.result.data.transactions;
    expect(approve.data.slice(34, 74)).toBe(across?.spokePool.slice(2).toLowerCase());
    expect(deposit.to.toLowerCase()).toBe(across?.spokePool.toLowerCase());
    expect(relayDeposit.to.toLowerCase()).toBe(relay?.depository.toLowerCase());
  });

  it('then the route cost floor is 300 bps and the app fee is 25 bps to the backend fee recipient', () => {
    expect(MAX_ROUTE_COST_BPS).toBe(300n);
    expect(APP_FEE).toEqual({ recipient: '0xC529EDD6D47C60923902514C7C0B3993ae42C2ec', maxBps: 25n });
  });

  it('then the app fee recipient is the one the prod Across quote pays its fee to', () => {
    const [, deposit] = acrossQuote.result.data.transactions;
    const { args } = decodeFunctionData({ abi: spokePoolAbi, data: deposit.data as Hex });
    const [{ calls }] = decodeAbiParameters(instructionsAbi, args[11]);
    const fee = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(fee.functionName).toBe('transfer');
    expect(fee.args[0]).toBe(APP_FEE.recipient);
  });

  it('then the testnets are exactly Sepolia, Base Sepolia, OP Sepolia and Arbitrum Sepolia', () => {
    const testnets = allowlisted.filter(({ testnet }) => testnet).map(({ chainId }) => chainId);
    expect(testnets.sort((a, b) => a - b)).toEqual([84532, 421614, 11155111, 11155420]);
  });

  it('then no Across wrapped native token is the zero address', () => {
    const zero = allowlisted
      .filter(({ across }) => across?.wrappedNative === zeroAddress)
      .map(({ chainId }) => chainId);
    expect(zero).toEqual([]);
  });

  it.each(Object.entries(MAIN_CHAINS))(
    'then the critical contracts and USDC on chain %s are the pinned ones',
    (id, pin) => {
      const { across, relay } = ALLOWLIST[Number(id)];
      expect({
        spokePool: across?.spokePool,
        multicallHandler: across?.multicallHandler,
        depository: relay?.depository,
        erc20Router: relay?.erc20Router,
      }).toEqual({
        spokePool: pin.spokePool,
        multicallHandler: MULTICALL_HANDLER,
        depository: DEPOSITORY,
        erc20Router: ERC20_ROUTER,
      });
      const usdc = Object.entries(ASSETS[Number(id)]).filter(([, { asset }]) => asset === 'USDC');
      expect(usdc).toEqual([[pin.usdc, { asset: 'USDC', decimals: pin.decimals }]]);
    }
  );

  it('then every source is an https URL', () => {
    const urls = Object.values(SOURCES).flatMap((source) =>
      typeof source === 'string' ? [source] : Object.values(source)
    );
    expect(urls.filter((url) => !url.startsWith('https://'))).toEqual([]);
  });

  it('then every Across event emitter names the file it was read from', () => {
    const unsourced = allowlisted.filter(
      ({ chainId, across }) => across?.eventEmitter && !SOURCES.acrossEventEmitter[chainId]
    );
    expect(unsourced.map(({ chainId }) => chainId)).toEqual([]);
  });

  it('then the tables match the reviewed digest, so any change to an address or token updates this test', () => {
    const digest = createHash('sha256').update(JSON.stringify({ ALLOWLIST, ASSETS, SOURCES })).digest('hex');
    expect(digest).toBe('1f63516d18d761f3df99b2cf2e4d9dddada2a3515b301a2ba04c0c2c320f8d24');
  });
});
