import { describe, it, expect } from 'vitest';
import { hashTypedData as erc7739HashTypedData, wrapTypedDataSignature } from 'viem/experimental/erc7739';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from './scheme-exact-evm.js';
import {
  PERMIT2_UPTO_CONTENTS_TYPE,
  PERMIT_WITNESS_TRANSFER_FROM_TYPES,
  permit2Domain,
  X402_UPTO_PROXY_ADDRESS,
  type UptoPermitMessage,
} from './permit2.js';

/**
 * The bytes the delegated signing path produces, frozen.
 *
 * The two `exact` literals are the record of what a verifier has actually
 * accepted from us: they were captured from the hand-written ERC-7739
 * implementation that settled a real payment on Base Sepolia, and they still
 * hold now that viem produces them instead, which is what makes that swap a
 * proven no-op rather than a leap.
 *
 * The two `upto` literals carry no such history. Nothing has ever verified
 * them. They were produced here, and they stay until a settlement says
 * otherwise, so treat them as a change detector and not as evidence that the
 * scheme works.
 *
 * What the file is worth going forward: viem is the signer now, and it is an
 * experimental module. If an upgrade moves any of these bytes, the account
 * stops accepting our signatures, and this is the cheapest place to find out.
 */

const accountDomain = {
  name: 'JustanAccount',
  version: '1',
  chainId: 84532n,
  verifyingContract: '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F' as `0x${string}`,
  salt: ('0x' + '00'.repeat(32)) as `0x${string}`,
};

/** A recognisable stand-in: the layout is what matters, not the key. */
const signature = ('0x' + 'ab'.repeat(65)) as `0x${string}`;

const exactDomain = {
  name: 'USDC',
  version: '2',
  chainId: 84532,
  verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
};

const exactMessage = {
  from: '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F' as `0x${string}`,
  to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as `0x${string}`,
  value: 1000n,
  validAfter: 0n,
  validBefore: 1_800_000_000n,
  nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
};

const uptoMessage: UptoPermitMessage = {
  permitted: { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: 5_000_000n },
  spender: X402_UPTO_PROXY_ADDRESS,
  nonce: BigInt('0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480'),
  deadline: 1_740_672_154n,
  witness: {
    to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    facilitator: '0x1111111111111111111111111111111111111111',
    validAfter: 1_740_672_089n,
  },
};

const EXACT_DIGEST = '0x93c534c2dba54f2315622869c1606ea6ae9f54a95a0ce9e437883063c9189554';
const EXACT_BLOB =
  '0x' +
  'ab'.repeat(65) +
  '71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818' +
  '5d8464a8940d34bddf7184ef17bcc4ae3bdf798f7ba6048dfa25f0090661771c' +
  '5472616e7366657257697468417574686f72697a6174696f6e28616464726573732066726f6d2c6164647265737320746f2c' +
  '75696e743235362076616c75652c75696e743235362076616c696441667465722c75696e743235362076616c69644265666f7265' +
  '2c62797465733332206e6f6e636529' +
  '0075';

const UPTO_DIGEST = '0x351a098dca63573531cee3005d61430ba31b319174709058c836b7551b1ed46f';
const UPTO_BLOB =
  '0x' +
  'ab'.repeat(65) +
  '010f27a92fb9a32622f44f001dc4d15706a85b33499cfc2ce9033113ab26592c' +
  '482b7b2efc1e90d0583360483bee6afe097d47c281552f14b440443cdcfd5368' +
  '5065726d69745769746e6573735472616e7366657246726f6d28546f6b656e5065726d697373696f6e73207065726d69747465642c' +
  '61646472657373207370656e6465722c75696e74323536206e6f6e63652c75696e7432353620646561646c696e652c' +
  '5769746e657373207769746e65737329546f6b656e5065726d697373696f6e73286164647265737320746f6b656e2c75696e7432353620616d6f756e7429' +
  '5769746e657373286164647265737320746f2c6164647265737320666163696c697461746f722c75696e743235362076616c6964416674657229' +
  '00dc';

/** The trailing uint16 is the byte length of the contents type in the blob. */
const declaredTypeLength = (blob: string): number => parseInt(blob.slice(-4), 16);
const embeddedType = (blob: string): string =>
  Buffer.from(blob.slice(2 + (65 + 32 + 32) * 2, -4), 'hex').toString('utf8');

const exactParams = {
  domain: exactDomain,
  types: TRANSFER_WITH_AUTHORIZATION_TYPES,
  primaryType: 'TransferWithAuthorization',
  message: exactMessage,
};

describe('the exact scheme signing path', () => {
  it('produces the digest a verifier has accepted on chain', () => {
    expect(erc7739HashTypedData({ ...exactParams, verifierDomain: accountDomain } as never)).toBe(EXACT_DIGEST);
  });

  it('produces the same blob, type string and length included', () => {
    const blob = wrapTypedDataSignature({ ...exactParams, signature } as never);
    expect(blob).toBe(EXACT_BLOB);
    expect(embeddedType(blob)).toBe(
      'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
    );
    expect(declaredTypeLength(blob)).toBe(embeddedType(blob).length);
  });
});

const uptoParams = {
  domain: permit2Domain(84532),
  types: PERMIT_WITNESS_TRANSFER_FROM_TYPES,
  primaryType: 'PermitWitnessTransferFrom',
  message: uptoMessage,
};

describe('the upto scheme signing path', () => {
  it('produces the pinned digest and blob', () => {
    expect(erc7739HashTypedData({ ...uptoParams, verifierDomain: accountDomain } as never)).toBe(UPTO_DIGEST);
    const blob = wrapTypedDataSignature({ ...uptoParams, signature } as never);
    expect(blob).toBe(UPTO_BLOB);
    expect(declaredTypeLength(blob)).toBe(embeddedType(blob).length);
  });

  it('embeds the type string transcribed from the proxy contract', () => {
    // The one assertion that can catch a bad transcription: viem builds the
    // type from the structs, so this compares what it derived against the
    // string copied out of x402UptoPermit2Proxy.sol. Comparing that string to
    // another copy of itself would prove nothing.
    expect(embeddedType(wrapTypedDataSignature({ ...uptoParams, signature } as never))).toBe(
      PERMIT2_UPTO_CONTENTS_TYPE
    );
  });

  /**
   * Solady appends the blob's contents type to the envelope verbatim
   * (`ERC1271.sol:270-275`), while viem rebuilds the envelope through EIP-712
   * `encodeType`, which sorts every referenced struct alphabetically. The two
   * agree only while the contents struct sorts first among itself and its
   * dependencies, which both type sets we sign happen to do. A future contents
   * struct named `Authorization` alongside `TokenPermissions` would not, and
   * the client and the account would hash different envelopes with no error
   * from either. The hand-written signer this replaced was immune, since it
   * concatenated the contents type the way Solady does.
   */
  it('keeps the contents struct sorting first among its dependencies', () => {
    const names = Object.keys(PERMIT_WITNESS_TRANSFER_FROM_TYPES);
    expect([...names].sort()[0]).toBe('PermitWitnessTransferFrom');
  });
});
