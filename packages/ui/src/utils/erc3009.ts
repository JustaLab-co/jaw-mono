// ============================================================================
//  ERC-3009 authorizations
// ----------------------------------------------------------------------------
// An ERC-3009 authorization moves tokens the moment someone submits the
// signature: no transaction for the signer to review afterwards. The EIP-712
// dialog shows these as a payment, so it has to know one when it sees one.
// ============================================================================

import { isAddress } from 'viem';
import { eip712TypeHash } from './clearSigning/eip712';

/**
 * The standard's type hashes (FiatTokenV2 `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` and
 * `RECEIVE_WITH_AUTHORIZATION_TYPEHASH`). Matching the hash, not the name, means a
 * struct that merely borrows the name, or reorders or renames a field, is not read
 * as a payment. CancelAuthorization moves nothing and stays on the generic view.
 */
const ERC3009_TYPEHASHES = {
  TransferWithAuthorization: '0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267',
  ReceiveWithAuthorization: '0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8',
} as const;

export type Erc3009PrimaryType = keyof typeof ERC3009_TYPEHASHES;

export interface Erc3009Authorization {
  primaryType: Erc3009PrimaryType;
  /** The account the tokens leave. Only a signature from this account can move them. */
  from: string;
  /** Who receives the tokens. */
  to: string;
  /** Amount in the token's smallest unit. */
  value: bigint;
  /** The token being moved: under ERC-3009 the verifying contract is the token itself. */
  token: string;
}

interface TypedDataLike {
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  domain?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/** Read typed data as an ERC-3009 payment, or null when it is anything else. */
export function readErc3009(typedData: TypedDataLike | null | undefined): Erc3009Authorization | null {
  const primaryType = typedData?.primaryType;
  if (!typedData?.types || !primaryType || !(primaryType in ERC3009_TYPEHASHES)) return null;
  const expected = ERC3009_TYPEHASHES[primaryType as Erc3009PrimaryType];
  if (eip712TypeHash(typedData.types, primaryType)?.toLowerCase() !== expected) return null;

  const { from, to, value } = typedData.message ?? {};
  const token = typedData.domain?.verifyingContract;
  if (!isAddressString(from) || !isAddressString(to) || !isAddressString(token)) return null;

  let amount: bigint;
  try {
    amount = BigInt(value as string | number | bigint);
  } catch {
    return null;
  }
  if (amount < 0n) return null;

  return {
    primaryType: primaryType as Erc3009PrimaryType,
    from,
    to,
    value: amount,
    token,
  };
}

function isAddressString(v: unknown): v is string {
  return typeof v === 'string' && isAddress(v, { strict: false });
}
