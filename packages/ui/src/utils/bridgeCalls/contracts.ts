import type { Address } from 'viem';

export type AcrossContracts = {
  spokePool: Address;
  periphery: Address;
  multicallHandler: Address;
  eventEmitter?: Address;
  /** SpokePool.wrappedNativeToken(); Arc has none, its gas token is USDC. */
  wrappedNative?: Address;
};

/**
 * protocolChain is Relay's name for the chain in an order, such as `base`. An order is filled
 * through erc20Router by one of the solvers; testnet orders may leave the router out.
 */
export type RelayContracts = {
  depository: Address;
  protocolChain: string;
  erc20Router: Address;
  solvers: readonly Address[];
  testnet?: true;
};

export type BridgeToken = { symbol: string; decimals: number };

export type BridgeChain = {
  name: string;
  /** Native amounts always have 18 decimals. */
  nativeSymbol: string;
  across?: AcrossContracts;
  relay?: RelayContracts;
  tokens: Readonly<Record<Address, BridgeToken>>;
};

const ACROSS_PERIPHERY = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';
const ACROSS_TESTNET_PERIPHERY = '0x10D8b8DaA26d307489803e10477De69C0492B610';
const ACROSS_HANDLER = '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E';
const ACROSS_EMITTER = '0xBF75133b48b0a42AB9374027902E83C5E2949034';
const OP_WETH = '0x4200000000000000000000000000000000000006';
const RELAY_DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31';
const RELAY_TESTNET_DEPOSITORY = '0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3';

const RELAY_ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f';
const RELAY_SOLVER = '0xf70da97812CB96acDF810712Aa562db8dfA3dbEF';

const ETHEREUM_SOLVERS = [
  RELAY_SOLVER,
  '0x56c262027e0De4aeA31d2489529CB25D23E58a8B',
  '0xabb2aCD3BE814a80e502575d6c1Dc5F789e9cd10',
  '0xa67D7Eb4dc68fa6ce8e34Ef8CaDaF075b9893FBb',
  '0xadA5bb90d0de0bD1b6F3938708F49295A8D1F7CB',
  '0xA5a5491bCa93dD4C076e4906e79E7673F4A5A142',
  '0x370A7E2d300c14D79d4A7ee07aACA46c4B3012cF',
  '0xca7ded7e4F4Ba8aB3B10009236Ae6d1b95094589',
  '0x331D9a049D496385998067ABF6CBb6371C8D2466',
  '0x18DD3C14e34c1BC379F7538068c59160D9F68e25',
] as const;

const BASE_SOLVERS = [
  RELAY_SOLVER,
  '0x56c262027e0De4aeA31d2489529CB25D23E58a8B',
  '0xabb2aCD3BE814a80e502575d6c1Dc5F789e9cd10',
  '0xa67D7Eb4dc68fa6ce8e34Ef8CaDaF075b9893FBb',
  '0xf42b73d2e4D3912EAdE2A5f7AB39b54064c2acEc',
  '0xd782268F600403843484b70710dAeE6846FC0DB8',
  '0xA5a5491bCa93dD4C076e4906e79E7673F4A5A142',
  '0x370A7E2d300c14D79d4A7ee07aACA46c4B3012cF',
  '0xca7ded7e4F4Ba8aB3B10009236Ae6d1b95094589',
  '0x331D9a049D496385998067ABF6CBb6371C8D2466',
  '0xadA5bb90d0de0bD1b6F3938708F49295A8D1F7CB',
  '0x18DD3C14e34c1BC379F7538068c59160D9F68e25',
  '0x2bB27B73c602643F42471D4751Fe4fC4EeBEFBd1',
  '0x6085932878d587332419ac976fC13D98EBa6FdaB',
  '0xD9497B53abCD6972B6370Cb195B6Bfd6B280e607',
  '0xd460B4182ED80992d498290BCBC6b60e95dE181b',
  '0x1cd9D560440aaB96f7b0A007ceD7C2191CaC5baf',
  '0x4381045063b19A615a272733fa6b5F169B622646',
  '0x9BC462bCe2Acd6FBE2EF5470d55B439453451083',
  '0xE209E0047731Aa494289E1Af9a0d03DA19c5EF08',
  '0xCC4bc7882D5ec4a3716e589aB3d816b61Ae47a1A',
  '0x0EC4e45f9ce3020024c0418a74cd31FBC487038F',
  '0x69374f8233a4069D48f8994D84052eCae6277ef5',
  '0x67D698A325F29e17a9477F28Ba4FE50F1cec60E4',
  '0x919968A4238A54B381f022a360260eF5D7E015aC',
  '0x344daADDE53A81F95bCc46A99d39107A509251A1',
  '0x698dd6c03b50c3D4aF12932A0388338bCdD3AAeD',
  '0x511808449bE470EfaF4131838B2D4998500A6F72',
  '0x728f51950FF096DC03a48F5e83f45aC8Bb75F500',
  '0x8583297605d996Da21b5F47D69bf56A0f7Fb74F4',
  '0x53939cB0B8b5d8EBc8f8208273A04A12F21c7346',
  '0x81ADF99fcc6073157008E25010967D307875c13C',
  '0x059df16Bdcf8a6bd20BB4814518ff6A2Df3C7B11',
  '0xF57519ebc17347af5a6EB3Df2eAb68204B1df4e1',
  '0x59A2c9bD639226012D59bba67B6990743193Af78',
  '0xfDeE58Cc140E170d72ABA75f29B23D7BCc05Da0c',
  '0x6d0a66Df5F4A32BE3656f63750e0253Eb59D9399',
  '0x035239DD57a4716E14e4a00F84b8FA7Ee03E152e',
  '0x850aE73E224780aFF70D46157e7aCc1038d9CeB6',
  '0xEb81dA7AC500267F62D9F93A03a0a5fB86864b2a',
  '0x744dCe9A9e94AC1d124bec9f2a02A9B3ec68507D',
] as const;

const BNB_SOLVERS = [
  RELAY_SOLVER,
  '0xa67D7Eb4dc68fa6ce8e34Ef8CaDaF075b9893FBb',
  '0x56c262027e0De4aeA31d2489529CB25D23E58a8B',
  '0xabb2aCD3BE814a80e502575d6c1Dc5F789e9cd10',
  '0xadA5bb90d0de0bD1b6F3938708F49295A8D1F7CB',
  '0xA5a5491bCa93dD4C076e4906e79E7673F4A5A142',
  '0x370A7E2d300c14D79d4A7ee07aACA46c4B3012cF',
  '0xca7ded7e4F4Ba8aB3B10009236Ae6d1b95094589',
  '0x331D9a049D496385998067ABF6CBb6371C8D2466',
  '0x18DD3C14e34c1BC379F7538068c59160D9F68e25',
  '0x2bB27B73c602643F42471D4751Fe4fC4EeBEFBd1',
  '0xCC4bc7882D5ec4a3716e589aB3d816b61Ae47a1A',
  '0x0EC4e45f9ce3020024c0418a74cd31FBC487038F',
] as const;

const POLYGON_SOLVERS = [
  RELAY_SOLVER,
  '0xC1A6E71C0f69aD498AA4029BDF9F8CDBa79f9678',
  '0xadA5bb90d0de0bD1b6F3938708F49295A8D1F7CB',
  '0xabb2aCD3BE814a80e502575d6c1Dc5F789e9cd10',
  '0x56c262027e0De4aeA31d2489529CB25D23E58a8B',
  '0xA5a5491bCa93dD4C076e4906e79E7673F4A5A142',
  '0x370A7E2d300c14D79d4A7ee07aACA46c4B3012cF',
  '0xca7ded7e4F4Ba8aB3B10009236Ae6d1b95094589',
  '0x331D9a049D496385998067ABF6CBb6371C8D2466',
  '0x18DD3C14e34c1BC379F7538068c59160D9F68e25',
  '0x2bB27B73c602643F42471D4751Fe4fC4EeBEFBd1',
  '0xa67D7Eb4dc68fa6ce8e34Ef8CaDaF075b9893FBb',
] as const;

const ROBINHOOD_SOLVERS = [
  RELAY_SOLVER,
  '0xabb2aCD3BE814a80e502575d6c1Dc5F789e9cd10',
  '0xA5a5491bCa93dD4C076e4906e79E7673F4A5A142',
  '0xca7ded7e4F4Ba8aB3B10009236Ae6d1b95094589',
  '0x331D9a049D496385998067ABF6CBb6371C8D2466',
  '0x18DD3C14e34c1BC379F7538068c59160D9F68e25',
  '0x2bB27B73c602643F42471D4751Fe4fC4EeBEFBd1',
  '0x0EC4e45f9ce3020024c0418a74cd31FBC487038F',
  '0xE209E0047731Aa494289E1Af9a0d03DA19c5EF08',
  '0x344daADDE53A81F95bCc46A99d39107A509251A1',
  '0x698dd6c03b50c3D4aF12932A0388338bCdD3AAeD',
  '0xCC4bc7882D5ec4a3716e589aB3d816b61Ae47a1A',
  '0x919968A4238A54B381f022a360260eF5D7E015aC',
  '0xa67D7Eb4dc68fa6ce8e34Ef8CaDaF075b9893FBb',
  '0x56c262027e0De4aeA31d2489529CB25D23E58a8B',
  '0x728f51950FF096DC03a48F5e83f45aC8Bb75F500',
  '0xadA5bb90d0de0bD1b6F3938708F49295A8D1F7CB',
  '0x511808449bE470EfaF4131838B2D4998500A6F72',
  '0x370A7E2d300c14D79d4A7ee07aACA46c4B3012cF',
  '0xf42b73d2e4D3912EAdE2A5f7AB39b54064c2acEc',
  '0xd782268F600403843484b70710dAeE6846FC0DB8',
  '0xD9497B53abCD6972B6370Cb195B6Bfd6B280e607',
  '0x69374f8233a4069D48f8994D84052eCae6277ef5',
  '0x6085932878d587332419ac976fC13D98EBa6FdaB',
  '0x9BC462bCe2Acd6FBE2EF5470d55B439453451083',
  '0x059df16Bdcf8a6bd20BB4814518ff6A2Df3C7B11',
  '0x4381045063b19A615a272733fa6b5F169B622646',
  '0x81ADF99fcc6073157008E25010967D307875c13C',
  '0xd460B4182ED80992d498290BCBC6b60e95dE181b',
  '0x67D698A325F29e17a9477F28Ba4FE50F1cec60E4',
  '0x1cd9D560440aaB96f7b0A007ceD7C2191CaC5baf',
] as const;

const ARC_SOLVERS = [
  RELAY_SOLVER,
  '0xa67D7Eb4dc68fa6ce8e34Ef8CaDaF075b9893FBb',
  '0x56c262027e0De4aeA31d2489529CB25D23E58a8B',
  '0xabb2aCD3BE814a80e502575d6c1Dc5F789e9cd10',
  '0xadA5bb90d0de0bD1b6F3938708F49295A8D1F7CB',
  '0xA5a5491bCa93dD4C076e4906e79E7673F4A5A142',
  '0x370A7E2d300c14D79d4A7ee07aACA46c4B3012cF',
  '0xca7ded7e4F4Ba8aB3B10009236Ae6d1b95094589',
  '0x331D9a049D496385998067ABF6CBb6371C8D2466',
  '0x18DD3C14e34c1BC379F7538068c59160D9F68e25',
  '0x2bB27B73c602643F42471D4751Fe4fC4EeBEFBd1',
  '0xCC4bc7882D5ec4a3716e589aB3d816b61Ae47a1A',
  '0x0EC4e45f9ce3020024c0418a74cd31FBC487038F',
  '0xE209E0047731Aa494289E1Af9a0d03DA19c5EF08',
  '0x919968A4238A54B381f022a360260eF5D7E015aC',
  '0x344daADDE53A81F95bCc46A99d39107A509251A1',
] as const;

const usdc = { symbol: 'USDC', decimals: 6 };
const weth = { symbol: 'WETH', decimals: 18 };

/**
 * Across addresses come from across-protocol/contracts (broadcast/deployed-addresses.json and
 * deployments/<network>/AcrossEventEmitter.json). Relay's depository, erc20Router and solvers
 * come from api.relay.link/chains and api.testnets.relay.link/chains. USDC comes from Circle's
 * USDC contract address list.
 */
export const BRIDGE_CHAINS: Readonly<Record<number, BridgeChain>> = {
  1: {
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'ethereum',
      erc20Router: RELAY_ROUTER,
      solvers: ETHEREUM_SOLVERS,
    },
    tokens: {
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': usdc,
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': weth,
    },
  },
  8453: {
    name: 'Base',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: OP_WETH,
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'base',
      erc20Router: RELAY_ROUTER,
      solvers: BASE_SOLVERS,
    },
    tokens: { '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': usdc, [OP_WETH]: weth },
  },
  10: {
    name: 'Optimism',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: OP_WETH,
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'optimism',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: { '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': usdc, [OP_WETH]: weth },
  },
  42161: {
    name: 'Arbitrum',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'arbitrum',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: {
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': usdc,
      '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': weth,
    },
  },
  59144: {
    name: 'Linea',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: '0xdF1C940487574EEfa79989a79a4936A0F979cDa2',
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
    },
    relay: {
      depository: '0x59916DA825D2D2eC1BF878D71c88826F6633ecca',
      protocolChain: 'linea',
      erc20Router: '0x9EF6d3c2F60d7b9008D74CAb1FC0F899c957C819',
      solvers: [RELAY_SOLVER],
    },
    tokens: {
      '0x176211869cA2b568f2A7D4EE941E073a821EE1ff': usdc,
      '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f': weth,
    },
  },
  43114: {
    name: 'Avalanche',
    nativeSymbol: 'AVAX',
    across: {
      spokePool: '0xFE9D541c92E4e90437C7152A00244886dE37a658',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: '0x9610954AcDCA5FF7905f051A040ce33fe613c60e',
      eventEmitter: '0x25b15Fc38d6A2C13FEDdD9cb51f184F7Cf0D4C11',
      wrappedNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'avalanche',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: { '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E': usdc },
  },
  56: {
    name: 'BNB Chain',
    nativeSymbol: 'BNB',
    across: {
      spokePool: '0x4e8E101924eDE233C13e2D8622DC8aED2872d505',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'bnb',
      erc20Router: RELAY_ROUTER,
      solvers: BNB_SOLVERS,
    },
    // Binance-Peg USDC, not Circle's: 18 decimals.
    tokens: { '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d': { symbol: 'USDC', decimals: 18 } },
  },
  42220: {
    name: 'Celo',
    nativeSymbol: 'CELO',
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'celo',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: { '0xcebA9300f2b948710d2653dD7B07f33A8B32118C': usdc },
  },
  137: {
    name: 'Polygon',
    nativeSymbol: 'POL',
    across: {
      spokePool: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'polygon',
      erc20Router: RELAY_ROUTER,
      solvers: POLYGON_SOLVERS,
    },
    tokens: { '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': usdc },
  },
  57073: {
    name: 'Ink',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0xeF684C38F94F48775959ECf2012D7E864ffb9dd4',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: OP_WETH,
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'ink',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: { '0x2D270e6886d130D724215A266106e6832161EAEd': usdc, [OP_WETH]: weth },
  },
  100: {
    name: 'Gnosis',
    nativeSymbol: 'xDAI',
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'gnosis',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: {},
  },
  4663: {
    name: 'Robinhood Chain',
    nativeSymbol: 'ETH',
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'robinhood',
      erc20Router: RELAY_ROUTER,
      solvers: ROBINHOOD_SOLVERS,
    },
    // No Across SpokePool here to read it from; checked on chain by symbol and decimals.
    tokens: { '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73': weth },
  },
  1868: {
    name: 'Soneium',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: OP_WETH,
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'soneium',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: { [OP_WETH]: weth },
  },
  5042: {
    name: 'Arc',
    nativeSymbol: 'USDC',
    across: {
      spokePool: '0x9b4A302A548c7e313c2b74C461db7b84d3074A84',
      periphery: '0xE791A2669bef779Ff7A4A9CF789F8Ee2CA20a32c',
      multicallHandler: '0xA07480456C4EbaD7626e4FdF4a180709E238547b',
      eventEmitter: '0x446Fe2Be6a8D90fA89F30f3d0A686aAFfe621237',
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'arc',
      erc20Router: RELAY_ROUTER,
      solvers: ARC_SOLVERS,
    },
    tokens: { '0x3600000000000000000000000000000000000000': usdc },
  },
  130: {
    name: 'Unichain',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: OP_WETH,
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'unichain',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: { '0x078D782b760474a361dDA0AF3839290b0EF57AD6': usdc, [OP_WETH]: weth },
  },
  143: {
    name: 'Monad',
    nativeSymbol: 'MON',
    across: {
      spokePool: '0xd2ecb3afe598b746F8123CaE365a598DA831A449',
      periphery: ACROSS_PERIPHERY,
      multicallHandler: '0xeC41F75c686e376Ab2a4F18bde263ab5822c4511',
      eventEmitter: ACROSS_EMITTER,
      wrappedNative: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    },
    relay: {
      depository: RELAY_DEPOSITORY,
      protocolChain: 'monad',
      erc20Router: RELAY_ROUTER,
      solvers: [RELAY_SOLVER],
    },
    tokens: { '0x754704Bc059F8C67012fEd69BC8A327a5aafb603': usdc },
  },
  11155111: {
    name: 'Sepolia',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662',
      periphery: ACROSS_TESTNET_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      wrappedNative: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    },
    relay: {
      depository: RELAY_TESTNET_DEPOSITORY,
      protocolChain: 'sepolia',
      erc20Router: '0xA1BEa5fe917450041748Dbbbe7E9AC57A4bBEBaB',
      solvers: ['0x3e34b27a9bf37D8424e1a58aC7fc4D06914B76B9'],
      testnet: true,
    },
    tokens: {
      '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': usdc,
      '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14': weth,
    },
  },
  84532: {
    name: 'Base Sepolia',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x82B564983aE7274c86695917BBf8C99ECb6F0F8F',
      periphery: ACROSS_TESTNET_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      wrappedNative: OP_WETH,
    },
    relay: {
      depository: RELAY_TESTNET_DEPOSITORY,
      protocolChain: 'base-sepolia',
      erc20Router: '0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222',
      solvers: ['0x3e34b27a9bf37D8424e1a58aC7fc4D06914B76B9'],
      testnet: true,
    },
    tokens: { '0x036CbD53842c5426634e7929541eC2318f3dCF7e': usdc, [OP_WETH]: weth },
  },
  11155420: {
    name: 'OP Sepolia',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x4e8E101924eDE233C13e2D8622DC8aED2872d505',
      periphery: ACROSS_TESTNET_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      wrappedNative: OP_WETH,
    },
    tokens: { '0x5fd84259d66Cd46123540766Be93DFE6D43130D7': usdc, [OP_WETH]: weth },
  },
  421614: {
    name: 'Arbitrum Sepolia',
    nativeSymbol: 'ETH',
    across: {
      spokePool: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75',
      periphery: ACROSS_TESTNET_PERIPHERY,
      multicallHandler: ACROSS_HANDLER,
      wrappedNative: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    },
    tokens: {
      '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d': usdc,
      '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73': weth,
    },
  },
};

/** Copied from production Across quotes; the backend sets it through MOVE_ASSET_FEE_RECIPIENT. */
export const JAW_FEE_RECIPIENT: Address = '0xC529EDD6D47C60923902514C7C0B3993ae42C2ec';
