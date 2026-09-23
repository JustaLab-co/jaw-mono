import { concat, encodeAbiParameters, keccak256, stringToBytes, toBytes, type Address, type Hex } from 'viem';

/**
 * The passkey challenge a JustanAccount signature commits to, rebuilt by hand
 * from ERC-7739 and EIP-712. It deliberately avoids viem's erc7739 module and
 * its typed-data hashing, which are what the signing path runs: a test that
 * derived its expectation from them would agree with any bug they share.
 *
 * Only the primitives (keccak, ABI word encoding) come from viem.
 */

const ACCOUNT_NAME = 'JustanAccount';
const ACCOUNT_VERSION = '1';
const ZERO_SALT = `0x${'00'.repeat(32)}` as Hex;

type Field = { name: string; type: string };
type Types = Record<string, readonly Field[]>;

const hashString = (s: string) => keccak256(stringToBytes(s));

/** The account's own EIP-712 domain, which wraps personal messages. */
function accountDomainSeparator(chainId: number, account: Address): Hex {
  const typeHash = hashString('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [typeHash, hashString(ACCOUNT_NAME), hashString(ACCOUNT_VERSION), BigInt(chainId), account]
    )
  );
}

/** EIP-191 personal message hash over raw bytes. */
function eip191(bytes: Uint8Array): Hex {
  return keccak256(concat([stringToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes]));
}

/** ERC-7739 `PersonalSign(bytes prefixed)` under the account's domain. */
export function personalSignChallenge(message: Uint8Array, chainId: number, account: Address): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [hashString('PersonalSign(bytes prefixed)'), eip191(message)]
    )
  );
  return keccak256(concat(['0x1901', accountDomainSeparator(chainId, account), structHash]));
}

/** EIP-712 `encodeType`: the primary struct, then every referenced struct sorted by name. */
export function encodeType(primary: string, types: Types): string {
  const deps = new Set<string>();
  const walk = (name: string) => {
    for (const { type } of types[name] ?? []) {
      const base = type.replace(/(\[\d*\])+$/, '');
      if (types[base] && base !== primary && !deps.has(base)) {
        deps.add(base);
        walk(base);
      }
    }
  };
  walk(primary);
  const format = (name: string) => `${name}(${types[name].map((f) => `${f.type} ${f.name}`).join(',')})`;
  return [primary, ...[...deps].sort()].map(format).join('');
}

/**
 * ERC-7739 `TypedDataSign` over the app's own domain. `domainHash` and
 * `messageHash` are the two digests the signing screen shows, so this is the
 * challenge the passkey must see if what was shown is what gets signed.
 */
export function typedDataSignChallenge(
  shown: { domainHash: Hex; messageHash: Hex },
  payload: { types: Types; primaryType: string },
  chainId: number,
  account: Address
): Hex {
  // The domain type is not part of the message's struct graph.
  const messageTypes = { ...payload.types };
  delete messageTypes.EIP712Domain;
  const typedDataSign: Types = {
    ...messageTypes,
    TypedDataSign: [
      { name: 'contents', type: payload.primaryType },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
    ],
  };
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [
        keccak256(toBytes(encodeType('TypedDataSign', typedDataSign))),
        shown.messageHash,
        hashString(ACCOUNT_NAME),
        hashString(ACCOUNT_VERSION),
        BigInt(chainId),
        account,
        ZERO_SALT,
      ]
    )
  );
  return keccak256(concat(['0x1901', shown.domainHash, structHash]));
}
