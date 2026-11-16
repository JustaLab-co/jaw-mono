// ERC-3009 test fixtures shared by the hook, matcher and dialog tests.
//
// CIRCLE_TRANSFER_DESCRIPTOR is copied verbatim from the ERC-7730 registry
// (ethereum/clear-signing-erc7730-registry, registry/circle/eip712-TransferWithAuthorization.json),
// and the type hash is FiatTokenV2's published constant, so neither is derived from this codebase.

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE = 8453;
export const PAYER = '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F';
export const PAYEE = '0x1111111111111111111111111111111111111111';

/** FiatTokenV2 `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`. */
export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
  '0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267';

/** The standard's struct: TransferWithAuthorization and ReceiveWithAuthorization share it. */
export const AUTH_FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

export interface Erc3009Overrides {
  primaryType?: 'TransferWithAuthorization' | 'ReceiveWithAuthorization';
  fields?: Array<{ name: string; type: string }>;
  domain?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/** A USDC-on-Base ERC-3009 authorization: 1 USDC from PAYER to PAYEE. */
export function erc3009TypedData(o: Erc3009Overrides = {}) {
  const primaryType = o.primaryType ?? 'TransferWithAuthorization';
  return {
    domain: { name: 'USD Coin', version: '2', chainId: BASE, verifyingContract: USDC_BASE, ...o.domain },
    primaryType,
    types: { EIP712Domain: DOMAIN_FIELDS, [primaryType]: o.fields ?? AUTH_FIELDS },
    message: {
      from: PAYER,
      to: PAYEE,
      value: '1000000',
      validAfter: '0',
      validBefore: '1893456000',
      nonce: `0x${'ab'.repeat(32)}`,
      ...o.message,
    },
  };
}

export const CIRCLE_TRANSFER_DESCRIPTOR = {
  $schema: '../../specs/erc7730-v2.schema.json',
  context: {
    eip712: {
      domain: { name: 'USD Coin', version: '2' },
      deployments: [
        { chainId: 1, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        { chainId: 10, address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
        { chainId: 137, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
        { chainId: 8453, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        { chainId: 42161, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
        { chainId: 43114, address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
      ],
    },
  },
  metadata: {
    owner: 'Circle Internet Financial',
    info: { url: 'https://www.circle.com/', deploymentDate: '2020-08-27T00:00:00Z' },
  },
  display: {
    formats: {
      'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)':
        {
          intent: 'Authorize USDC transfer',
          fields: [
            {
              path: 'from',
              label: 'From',
              format: 'addressName',
              params: { types: ['wallet'], sources: ['local', 'ens'] },
              visible: 'always',
            },
            {
              path: 'to',
              label: 'To',
              format: 'addressName',
              params: { types: ['eoa', 'contract'], sources: ['local', 'ens'] },
              visible: 'always',
            },
            { path: 'value', label: 'Amount', format: 'tokenAmount', params: { tokenPath: '@.to' }, visible: 'always' },
            { path: 'validAfter', label: 'Valid after', format: 'date', params: { encoding: 'timestamp' } },
            { path: 'validBefore', label: 'Valid before', format: 'date', params: { encoding: 'timestamp' } },
            { label: 'Nonce', path: 'nonce', visible: 'never' },
          ],
        },
    },
  },
};

/** A descriptor source serving only Circle's TransferWithAuthorization entry for USDC on Base. */
export function circleRegistrySource() {
  const path = 'registry/circle/eip712-TransferWithAuthorization.json';
  return {
    getCalldataIndex: async () => ({}),
    getEip712Index: async () => ({
      [`eip155:${BASE}:${USDC_BASE.toLowerCase()}`]: {
        TransferWithAuthorization: [{ path, encodeTypeHashes: [TRANSFER_WITH_AUTHORIZATION_TYPEHASH] }],
      },
    }),
    getDescriptor: async (p: string) => {
      if (p !== path) throw new Error(`no descriptor at ${p}`);
      return structuredClone(CIRCLE_TRANSFER_DESCRIPTOR);
    },
  };
}

/** Token reads as a chain would answer them: USDC on Base has 6 decimals; anything else is unreadable. */
export async function readUsdcOnly(address: string) {
  return address.toLowerCase() === USDC_BASE.toLowerCase() ? { address, decimals: 6, symbol: 'USDC' } : null;
}
