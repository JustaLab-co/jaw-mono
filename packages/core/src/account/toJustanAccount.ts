import {
    type Address,
    type Hex,
    encodeFunctionData,
    encodeAbiParameters,
    type Hash,
    type TypedDataDefinition,
    size,
    parseSignature,
    encodePacked,
    type TypedData,
    stringToHex,
    padHex,
    numberToHex,
    pad,
    BaseError,
    type LocalAccount,
    type PrivateKeyAccount,
    decodeFunctionData,
    isAddressEqual,
    type Client,
    hashTypedData,
    hashDomain,
    hashStruct,
    getTypesForEIP712Domain,
} from 'viem';
import { readContract, getChainId, getTransactionCount } from 'viem/actions';
import { hashAuthorization } from 'viem/utils';
import {
    type SmartAccount,
    type WebAuthnAccount,
    toSmartAccount,
    entryPoint08Abi,
    entryPoint08Address,
    type SmartAccountImplementation,
    getUserOperationTypedData,
} from 'viem/account-abstraction';
import type { SignAuthorizationReturnType } from 'viem/accounts';
import * as Signature from 'ox/Signature';
import * as TypedDataOx from 'ox/TypedData';
import type * as WebAuthnP256 from 'ox/WebAuthnP256';
import { hashMessage as erc7739HashMessage, hashTypedData as erc7739HashTypedData } from 'viem/experimental/erc7739';
import { CONTRACT_NAME, CONTRACT_VERSION, FACTORY_ADDRESS } from '../constants.js';

export type JustanAccountImplementation = SmartAccountImplementation<
    typeof entryPoint08Abi,
    '0.8',
    {
        abi: typeof abi;
        factory: { abi: typeof factoryAbi; address: Address };
    }
>;

// NOTE: take into consideration signing using another owner
export type ToJustanAccountParameters = {
    client: JustanAccountImplementation['client'];
    owners: readonly (Address | LocalAccount | WebAuthnAccount)[];
    ownerIndex?: number | undefined;
    nonce?: bigint | undefined;
    entryPoint?:
        | {
              abi: typeof entryPoint08Abi;
              address: Address;
              version: '0.8';
          }
        | undefined;
    factoryAddress?: Address | undefined;
    /** Override the factory-derived address. Used when signing for an account this passkey owns but didn't create. */
    address?: Address | undefined;

    // EIP-7702 parameters (optional)
    eip7702Account?: LocalAccount | undefined;
    eip7702Auth?: SignAuthorizationReturnType | undefined;
};

export type ToJustanAccountReturnType = SmartAccount & {
    signAuthorization: () => Promise<SignAuthorizationReturnType>;
};

export async function toJustanAccount(parameters: ToJustanAccountParameters): Promise<ToJustanAccountReturnType> {
    const {
        client,
        owners,
        ownerIndex = 0,
        nonce = 0n,
        entryPoint = {
            abi: entryPoint08Abi,
            address: entryPoint08Address,
            version: '0.8',
        },
        factoryAddress = FACTORY_ADDRESS,
        address: addressOverride,
        // EIP-7702 parameters
        eip7702Account,
        eip7702Auth,
    } = parameters;

    const isEip7702 = !!eip7702Account || !!eip7702Auth;

    let delegationContract: Address | undefined;
    if (isEip7702) {
        delegationContract = await getDelegationContract(client, factoryAddress);

        if (eip7702Auth && !isAddressEqual(eip7702Auth.address, delegationContract)) {
            throw new BaseError('EIP-7702 authorization delegate address does not match delegation contract address');
        }
    }

    const owners_bytes = owners.map((owner) => {
        if (typeof owner === 'string') return pad(owner);
        if (owner.type === 'webAuthn') return owner.publicKey;
        if (owner.type === 'local') return pad(owner.address);
        throw new BaseError('invalid owner type');
    });

    const owner = (() => {
        if (isEip7702) {
            if (!eip7702Account) {
                throw new BaseError('eip7702Account is required when using EIP-7702');
            }
            return eip7702Account;
        }

        const owner = owners[ownerIndex] ?? owners[0];
        if (typeof owner === 'string') return { address: owner, type: 'address' } as const;
        return owner;
    })();

    if (!owner) throw new Error('No owner provided');

    let accountAddress: Address;
    if (addressOverride) {
        accountAddress = addressOverride;
    } else if (isEip7702) {
        accountAddress = eip7702Account!.address;
    } else {
        accountAddress = await readContract(client, {
            address: factoryAddress,
            abi: factoryAbi,
            functionName: 'getAddress',
            args: [owners_bytes, nonce],
        });
    }

    return toSmartAccount({
        client,
        entryPoint,
        // In 7702 mode, expose the authority/delegate pair so viem attaches a
        // stub-signed authorization to any userOp it prepares while the EOA is
        // still undeployed. Without it, estimation-only flows that call
        // prepareUserOperation themselves (e.g. the ERC-20 paymaster approval
        // sizing) simulate a codeless sender and fail. The send path passes
        // its own signed authorization explicitly, which takes precedence.
        // Gated on signAuthorization: viem may call it on this account, so a
        // LocalAccount without it (remote signer) keeps the old behavior
        // instead of throwing mid-estimation.
        ...(isEip7702 && eip7702Account && delegationContract && eip7702Account.signAuthorization
            ? { authorization: { account: eip7702Account as PrivateKeyAccount, address: delegationContract } }
            : {}),
        async decodeCalls(data) {
            const result = decodeFunctionData({
                abi,
                data,
            });
            if (result.functionName === 'execute')
                return [{ to: result.args[0], value: result.args[1], data: result.args[2] }];
            if (result.functionName === 'executeBatch')
                return result.args[0].map((arg) => ({
                    to: arg.target,
                    value: arg.value,
                    data: arg.data,
                }));
            throw new BaseError(`unable to decode calls for "${result.functionName}"`);
        },
        async encodeCalls(calls) {
            if (calls.length === 1) {
                return encodeFunctionData({
                    abi,
                    functionName: 'execute',
                    args: [calls[0].to, calls[0].value ?? 0n, calls[0].data ?? '0x'],
                });
            }
            return encodeFunctionData({
                abi,
                functionName: 'executeBatch',
                args: [
                    calls.map((call) => ({
                        target: call.to,
                        value: call.value ?? 0n,
                        data: call.data ?? '0x',
                    })),
                ],
            });
        },
        async getAddress() {
            return accountAddress;
        },
        async getFactoryArgs() {
            if (isEip7702) {
                return {
                    factory: '0x7702' as Address,
                    factoryData: '0x' as Hex,
                };
            }

            return {
                factory: factoryAddress,
                factoryData: encodeFunctionData({
                    abi: factoryAbi,
                    functionName: 'createAccount',
                    args: [owners_bytes, nonce],
                }),
            };
        },
        async getStubSignature() {
            if (isEip7702) {
                return '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';
            }

            return '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000170000000000000000000000000000000000000000000000000000000000000001949fc7c88032b9fcb5f6efc7a7b8c63668eae9871b765e23123bb473ff57aa831a7c0d9276168ebcc29f2875a0239cffdf2a9cd1c2007c5c77c071db9264df1d000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000847b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a2273496a396e6164474850596759334b7156384f7a4a666c726275504b474f716d59576f4d57516869467773222c226f726967696e223a2268747470733a2f2f6b6579732e6a61772e6964222c2263726f73734f726967696e223a66616c73657d00000000000000000000000000000000000000000000000000000000';
        },
        async signMessage(parameters) {
            const { message } = parameters;

            const address = await this.getAddress();

            const hash = erc7739HashMessage({
                message: message,
                verifierDomain: {
                    name: CONTRACT_NAME,
                    version: CONTRACT_VERSION,
                    verifyingContract: address,
                    chainId: client.chain!.id,
                },
            });

            if (owner.type === 'address') throw new Error('owner cannot sign');

            const signature = await sign({ owner, hash });

            if (isEip7702) {
                return signature;
            }

            return wrapSignature({
                ownerIndex,
                signature,
            });
        },
        async signTypedData(parameters) {
            const { domain = {}, types, primaryType, message } = parameters as TypedDataDefinition<TypedData, string>;

            const address = await this.getAddress();

            const nestedHash = erc7739HashTypedData({
                domain,
                types,
                primaryType,
                message,
                verifierDomain: {
                    chainId: client.chain!.id,
                    name: CONTRACT_NAME,
                    version: CONTRACT_VERSION,
                    verifyingContract: address,
                    salt: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash,
                },
            });

            if (owner.type === 'address') throw new Error('owner cannot sign');

            const signature = await sign({ owner, hash: nestedHash });

            return wrapTypedDataSignature({
                domain,
                types,
                primaryType,
                message,
                // A delegated EOA is its own signer, so there is no owner tuple.
                signature: isEip7702 ? signature : wrapSignature({ ownerIndex, signature }),
            });
        },
        async signUserOperation(parameters) {
            const { chainId = client.chain!.id, ...userOperation } = parameters;

            const address = await this.getAddress();
            const typedData = getUserOperationTypedData({
                chainId,
                entryPointAddress: entryPoint.address,
                userOperation: {
                    ...userOperation,
                    sender: address,
                },
            });

            if (owner.type === 'address') throw new Error('owner cannot sign');

            const signature = await signTypedData({ typedData, owner });

            if (isEip7702) {
                return signature;
            }

            return wrapSignature({
                ownerIndex,
                signature,
            });
        },

        async signAuthorization() {
            if (!isEip7702) {
                throw new BaseError('signAuthorization can only be called for EIP-7702 accounts');
            }

            if (!delegationContract) {
                throw new BaseError('Delegation contract is required for EIP-7702 authorization');
            }

            if (eip7702Auth) {
                return eip7702Auth;
            }

            const chainId = await getChainId(client);
            const nonce = await getTransactionCount(client, { address: eip7702Account!.address });

            if (eip7702Account!.signAuthorization) {
                return eip7702Account!.signAuthorization({ contractAddress: delegationContract, chainId, nonce });
            }

            const hash = hashAuthorization({ address: delegationContract, chainId, nonce });
            const signature = await eip7702Account!.sign!({ hash });
            const { r, s, yParity } = parseSignature(signature);

            return { address: delegationContract, chainId, nonce, r, s, yParity };
        },
    });
}

// INTERNAL FUNCTIONS

/** @internal */
async function getDelegationContract(client: Client, factoryAddress: Address): Promise<Address> {
    return await readContract(client, {
        address: factoryAddress,
        abi: factoryAbi,
        functionName: 'getImplementation',
    });
}

/** @internal */
export async function sign({ hash, owner }: { hash: Hash; owner: LocalAccount | WebAuthnAccount }) {
    if (owner.type === 'webAuthn') {
        const { signature, webauthn } = await owner.sign({
            hash,
        });
        return toWebAuthnSignature({
            signature,
            webauthn: {
                authenticatorData: webauthn.authenticatorData,
                clientDataJSON: webauthn.clientDataJSON,
                challengeIndex: webauthn.challengeIndex ?? 23,
                typeIndex: webauthn.typeIndex ?? 1,
                userVerificationRequired: webauthn.userVerificationRequired ?? true,
            },
        });
    }

    if (owner.sign) return owner.sign({ hash });

    throw new BaseError('`owner` does not support raw sign.');
}

export async function signTypedData({
    typedData,
    owner,
}: {
    typedData: TypedDataDefinition;
    owner: LocalAccount | WebAuthnAccount;
}) {
    if (owner.type === 'webAuthn') {
        const { signature, webauthn } = await owner.signTypedData(typedData);

        return toWebAuthnSignature({
            signature,
            webauthn: {
                authenticatorData: webauthn.authenticatorData,
                clientDataJSON: webauthn.clientDataJSON,
                challengeIndex: webauthn.challengeIndex ?? 23,
                typeIndex: webauthn.typeIndex ?? 1,
                userVerificationRequired: webauthn.userVerificationRequired ?? true,
            },
        });
    }

    if (owner.sign) {
        const hash = hashTypedData(typedData);
        return owner.sign({ hash });
    }

    throw new BaseError('`owner` does not support signTypedData.');
}

export function toWebAuthnSignature({ webauthn, signature }: { webauthn: WebAuthnP256.SignMetadata; signature: Hex }) {
    const { r, s } = Signature.fromHex(signature);

    const rBytes32 = padHex(numberToHex(r), { size: 32 });
    const sBytes32 = padHex(numberToHex(s), { size: 32 });

    return encodeAbiParameters(
        [
            {
                components: [
                    {
                        name: 'authenticatorData',
                        type: 'bytes',
                    },
                    { name: 'clientDataJSON', type: 'bytes' },
                    { name: 'challengeIndex', type: 'uint256' },
                    { name: 'typeIndex', type: 'uint256' },
                    {
                        name: 'r',
                        type: 'bytes32',
                    },
                    {
                        name: 's',
                        type: 'bytes32',
                    },
                ],
                type: 'tuple',
            },
        ],
        [
            {
                authenticatorData: webauthn.authenticatorData,
                clientDataJSON: stringToHex(webauthn.clientDataJSON),
                challengeIndex: BigInt(webauthn.challengeIndex),
                typeIndex: BigInt(webauthn.typeIndex),
                r: rBytes32,
                s: sBytes32,
            },
        ]
    );
}

/** @internal */
export function wrapSignature(parameters: { ownerIndex?: number | undefined; signature: Hex }) {
    const { ownerIndex = 0 } = parameters;
    const signatureData = (() => {
        if (size(parameters.signature) !== 65) return parameters.signature;
        const signature = parseSignature(parameters.signature);
        return encodePacked(
            ['bytes32', 'bytes32', 'uint8'],
            [signature.r, signature.s, signature.yParity === 0 ? 27 : 28]
        );
    })();
    return encodeAbiParameters(
        [
            {
                components: [
                    {
                        name: 'ownerIndex',
                        type: 'uint256',
                    },
                    {
                        name: 'signatureData',
                        type: 'bytes',
                    },
                ],
                type: 'tuple',
            },
        ],
        [
            {
                // uint256 in the struct, so a bigint here. Narrower than the
                // struct is not free: a uint8 declaration makes viem refuse to
                // encode past 255, and `MultiOwnable` never reuses an index.
                ownerIndex: BigInt(ownerIndex),
                signatureData,
            },
        ]
    );
}
/**
 * ERC-7739 `TypedDataSign` signature in Solady's explicit mode: the contents
 * types sorted as EIP-712 encodes them inside `TypedDataSign`, then the primary
 * type's name. The app domain is hashed with the declared `EIP712Domain`, if
 * any, as the signed hash is.
 */
function wrapTypedDataSignature(parameters: TypedDataDefinition<Record<string, unknown>, string> & { signature: Hex }) {
    const { domain = {}, message, primaryType, signature } = parameters;
    const types = { EIP712Domain: getTypesForEIP712Domain({ domain }), ...parameters.types } as TypedData;

    const contentsType = TypedDataOx.encodeType({ primaryType, types })
        .split(/(?<=\))/)
        .sort()
        .join('');
    const contentsDescription = stringToHex(contentsType + primaryType);

    return encodePacked(
        ['bytes', 'bytes32', 'bytes32', 'bytes', 'uint16'],
        [
            signature,
            hashDomain({ domain, types }),
            hashStruct({ data: message, primaryType, types }),
            contentsDescription,
            size(contentsDescription),
        ]
    );
}

/////////////////////////////////////////////////////////////////////////////////////////////
// Constants

export const abi = [
    {
        type: 'constructor',
        inputs: [
            {
                name: 'entryPointAddress',
                type: 'address',
                internalType: 'address',
            },
            {
                name: 'factory',
                type: 'address',
                internalType: 'address',
            },
        ],
        stateMutability: 'nonpayable',
    },
    {
        type: 'fallback',
        stateMutability: 'payable',
    },
    {
        type: 'receive',
        stateMutability: 'payable',
    },
    {
        type: 'function',
        name: 'REPLAYABLE_NONCE_KEY',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'addOwnerAddress',
        inputs: [
            {
                name: 'owner',
                type: 'address',
                internalType: 'address',
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        type: 'function',
        name: 'addOwnerPublicKey',
        inputs: [
            {
                name: 'x',
                type: 'bytes32',
                internalType: 'bytes32',
            },
            {
                name: 'y',
                type: 'bytes32',
                internalType: 'bytes32',
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        type: 'function',
        name: 'canSkipChainIdValidation',
        inputs: [
            {
                name: 'functionSelector',
                type: 'bytes4',
                internalType: 'bytes4',
            },
        ],
        outputs: [
            {
                name: '',
                type: 'bool',
                internalType: 'bool',
            },
        ],
        stateMutability: 'pure',
    },
    {
        type: 'function',
        name: 'eip712Domain',
        inputs: [],
        outputs: [
            {
                name: 'fields',
                type: 'bytes1',
                internalType: 'bytes1',
            },
            {
                name: 'name',
                type: 'string',
                internalType: 'string',
            },
            {
                name: 'version',
                type: 'string',
                internalType: 'string',
            },
            {
                name: 'chainId',
                type: 'uint256',
                internalType: 'uint256',
            },
            {
                name: 'verifyingContract',
                type: 'address',
                internalType: 'address',
            },
            {
                name: 'salt',
                type: 'bytes32',
                internalType: 'bytes32',
            },
            {
                name: 'extensions',
                type: 'uint256[]',
                internalType: 'uint256[]',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'entryPoint',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'address',
                internalType: 'contract IEntryPoint',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'execute',
        inputs: [
            {
                name: 'target',
                type: 'address',
                internalType: 'address',
            },
            {
                name: 'value',
                type: 'uint256',
                internalType: 'uint256',
            },
            {
                name: 'data',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        type: 'function',
        name: 'executeBatch',
        inputs: [
            {
                name: 'calls',
                type: 'tuple[]',
                internalType: 'struct BaseAccount.Call[]',
                components: [
                    {
                        name: 'target',
                        type: 'address',
                        internalType: 'address',
                    },
                    {
                        name: 'value',
                        type: 'uint256',
                        internalType: 'uint256',
                    },
                    {
                        name: 'data',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                ],
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        type: 'function',
        name: 'executeWithoutChainIdValidation',
        inputs: [
            {
                name: 'calls',
                type: 'bytes[]',
                internalType: 'bytes[]',
            },
        ],
        outputs: [],
        stateMutability: 'payable',
    },
    {
        type: 'function',
        name: 'getNonce',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'getUserOpHashWithoutChainId',
        inputs: [
            {
                name: 'userOp',
                type: 'tuple',
                internalType: 'struct PackedUserOperation',
                components: [
                    {
                        name: 'sender',
                        type: 'address',
                        internalType: 'address',
                    },
                    {
                        name: 'nonce',
                        type: 'uint256',
                        internalType: 'uint256',
                    },
                    {
                        name: 'initCode',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                    {
                        name: 'callData',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                    {
                        name: 'accountGasLimits',
                        type: 'bytes32',
                        internalType: 'bytes32',
                    },
                    {
                        name: 'preVerificationGas',
                        type: 'uint256',
                        internalType: 'uint256',
                    },
                    {
                        name: 'gasFees',
                        type: 'bytes32',
                        internalType: 'bytes32',
                    },
                    {
                        name: 'paymasterAndData',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                    {
                        name: 'signature',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                ],
            },
        ],
        outputs: [
            {
                name: '',
                type: 'bytes32',
                internalType: 'bytes32',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'initialize',
        inputs: [
            {
                name: 'owners',
                type: 'bytes[]',
                internalType: 'bytes[]',
            },
        ],
        outputs: [],
        stateMutability: 'payable',
    },
    {
        type: 'function',
        name: 'isOwnerAddress',
        inputs: [
            {
                name: 'account',
                type: 'address',
                internalType: 'address',
            },
        ],
        outputs: [
            {
                name: '',
                type: 'bool',
                internalType: 'bool',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'isOwnerBytes',
        inputs: [
            {
                name: 'account',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
        outputs: [
            {
                name: '',
                type: 'bool',
                internalType: 'bool',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'isOwnerPublicKey',
        inputs: [
            {
                name: 'x',
                type: 'bytes32',
                internalType: 'bytes32',
            },
            {
                name: 'y',
                type: 'bytes32',
                internalType: 'bytes32',
            },
        ],
        outputs: [
            {
                name: '',
                type: 'bool',
                internalType: 'bool',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'isValidSignature',
        inputs: [
            {
                name: 'hash',
                type: 'bytes32',
                internalType: 'bytes32',
            },
            {
                name: 'signature',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
        outputs: [
            {
                name: 'result',
                type: 'bytes4',
                internalType: 'bytes4',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'nextOwnerIndex',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'ownerAtIndex',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        outputs: [
            {
                name: '',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'ownerCount',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'removeLastOwner',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                internalType: 'uint256',
            },
            {
                name: 'owner',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        type: 'function',
        name: 'removeOwnerAtIndex',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                internalType: 'uint256',
            },
            {
                name: 'owner',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        type: 'function',
        name: 'removedOwnersCount',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'supportsInterface',
        inputs: [
            {
                name: 'id',
                type: 'bytes4',
                internalType: 'bytes4',
            },
        ],
        outputs: [
            {
                name: '',
                type: 'bool',
                internalType: 'bool',
            },
        ],
        stateMutability: 'pure',
    },
    {
        type: 'function',
        name: 'validateUserOp',
        inputs: [
            {
                name: 'userOp',
                type: 'tuple',
                internalType: 'struct PackedUserOperation',
                components: [
                    {
                        name: 'sender',
                        type: 'address',
                        internalType: 'address',
                    },
                    {
                        name: 'nonce',
                        type: 'uint256',
                        internalType: 'uint256',
                    },
                    {
                        name: 'initCode',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                    {
                        name: 'callData',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                    {
                        name: 'accountGasLimits',
                        type: 'bytes32',
                        internalType: 'bytes32',
                    },
                    {
                        name: 'preVerificationGas',
                        type: 'uint256',
                        internalType: 'uint256',
                    },
                    {
                        name: 'gasFees',
                        type: 'bytes32',
                        internalType: 'bytes32',
                    },
                    {
                        name: 'paymasterAndData',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                    {
                        name: 'signature',
                        type: 'bytes',
                        internalType: 'bytes',
                    },
                ],
            },
            {
                name: 'userOpHash',
                type: 'bytes32',
                internalType: 'bytes32',
            },
            {
                name: 'missingAccountFunds',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        outputs: [
            {
                name: 'validationData',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        stateMutability: 'nonpayable',
    },
    {
        type: 'event',
        name: 'AddOwner',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                indexed: true,
                internalType: 'uint256',
            },
            {
                name: 'owner',
                type: 'bytes',
                indexed: false,
                internalType: 'bytes',
            },
        ],
        anonymous: false,
    },
    {
        type: 'event',
        name: 'RemoveOwner',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                indexed: true,
                internalType: 'uint256',
            },
            {
                name: 'owner',
                type: 'bytes',
                indexed: false,
                internalType: 'bytes',
            },
        ],
        anonymous: false,
    },
    {
        type: 'error',
        name: 'ExecuteError',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                internalType: 'uint256',
            },
            {
                name: 'error',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
    },
    {
        type: 'error',
        name: 'FnSelectorNotRecognized',
        inputs: [],
    },
    {
        type: 'error',
        name: 'JustanAccount_AlreadyInitialized',
        inputs: [],
    },
    {
        type: 'error',
        name: 'JustanAccount_InvalidNonceKey',
        inputs: [
            {
                name: 'key',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
    },
    {
        type: 'error',
        name: 'JustanAccount_SelectorNotAllowed',
        inputs: [
            {
                name: 'selector',
                type: 'bytes4',
                internalType: 'bytes4',
            },
        ],
    },
    {
        type: 'error',
        name: 'JustanAccount_UnauthorizedInitialization',
        inputs: [],
    },
    {
        type: 'error',
        name: 'MultiOwnable_AlreadyOwner',
        inputs: [
            {
                name: 'owner',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
    },
    {
        type: 'error',
        name: 'MultiOwnable_InvalidEthereumAddressOwner',
        inputs: [
            {
                name: 'owner',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
    },
    {
        type: 'error',
        name: 'MultiOwnable_InvalidOwnerBytesLength',
        inputs: [
            {
                name: 'owner',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
    },
    {
        type: 'error',
        name: 'MultiOwnable_LastOwner',
        inputs: [],
    },
    {
        type: 'error',
        name: 'MultiOwnable_NoOwnerAtIndex',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
    },
    {
        type: 'error',
        name: 'MultiOwnable_NotLastOwner',
        inputs: [
            {
                name: 'ownersRemaining',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
    },
    {
        type: 'error',
        name: 'MultiOwnable_Unauthorized',
        inputs: [],
    },
    {
        type: 'error',
        name: 'MultiOwnable_WrongOwnerAtIndex',
        inputs: [
            {
                name: 'index',
                type: 'uint256',
                internalType: 'uint256',
            },
            {
                name: 'expectedOwner',
                type: 'bytes',
                internalType: 'bytes',
            },
            {
                name: 'actualOwner',
                type: 'bytes',
                internalType: 'bytes',
            },
        ],
    },
] as const;

export const factoryAbi = [
    {
        type: 'constructor',
        inputs: [
            {
                name: 'entryPointAddress',
                type: 'address',
                internalType: 'address',
            },
        ],
        stateMutability: 'nonpayable',
    },
    {
        type: 'function',
        name: 'createAccount',
        inputs: [
            {
                name: 'owners',
                type: 'bytes[]',
                internalType: 'bytes[]',
            },
            {
                name: 'nonce',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        outputs: [
            {
                name: 'account',
                type: 'address',
                internalType: 'contract JustanAccount',
            },
        ],
        stateMutability: 'payable',
    },
    {
        type: 'function',
        name: 'getAddress',
        inputs: [
            {
                name: 'owners',
                type: 'bytes[]',
                internalType: 'bytes[]',
            },
            {
                name: 'nonce',
                type: 'uint256',
                internalType: 'uint256',
            },
        ],
        outputs: [
            {
                name: '',
                type: 'address',
                internalType: 'address',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'getImplementation',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'address',
                internalType: 'address',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'initCodeHash',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'bytes32',
                internalType: 'bytes32',
            },
        ],
        stateMutability: 'view',
    },
    {
        type: 'error',
        name: 'JustanAccountFactory_AlreadyDeployed',
        inputs: [],
    },
    {
        type: 'error',
        name: 'JustanAccountFactory_OwnerRequired',
        inputs: [],
    },
] as const;
