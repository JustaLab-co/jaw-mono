import {
    type Address,
    type Hex,
    encodeAbiParameters,
    encodeFunctionData,
    getContractAddress,
    isAddressEqual,
    keccak256,
    pad,
} from 'viem';
import { factoryAbi } from './toJustanAccount.js';

/**
 * What a smart account was created from. The address is stored once, at
 * creation, and read back from here instead of being recomputed, so a later
 * change to the SDK's constants never moves an existing account.
 */
export type AccountRecord = {
    address: Address;
    /** Version of the recipe the account was created with. */
    version: number;
    factory: Address;
    /** Owner bytes passed to `createAccount`, in order. */
    owners: Hex[];
    /** uint256 passed to `createAccount`, as a decimal string so it survives JSON storage. */
    nonce: string;
};

/**
 * The recipe every account from @jaw.id/core 0.1.0 onwards was created with.
 * Frozen: these are literals rather than `FACTORY_ADDRESS` or
 * `PERMISSIONS_MANAGER_ADDRESS`, so changing those constants for new accounts
 * leaves the address of every existing one where it is.
 */
export const ACCOUNT_RECIPE_V1 = {
    version: 1,
    factory: '0x5803c076563C85799989d42Fc00292A8aE52fa9E',
    /**
     * `factory.initCodeHash()`: the EIP-1167 clone of the factory's
     * implementation (0xbb4f7d5418Cd8DADB61bb95561179e517572cBCd), the same on
     * every chain.
     */
    initCodeHash: '0x66e5c494c913cf25a974791c8b932da3b3e54d43bb638e7a6421c64db20696e4',
    permissionsManager: '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8',
    nonce: 0n,
} as const satisfies {
    version: number;
    factory: Address;
    initCodeHash: Hex;
    permissionsManager: Address;
    nonce: bigint;
};

/**
 * The v1 record for a passkey public key: owners `[publicKey, permissionsManager]`,
 * nonce 0, and the address the factory's CREATE2 deploys that to. Computed
 * locally, the same way `factory.getAddress` does, so it needs no RPC.
 */
export function deriveAccountRecordV1(publicKey: Hex): AccountRecord {
    const { version, factory, initCodeHash, permissionsManager, nonce } = ACCOUNT_RECIPE_V1;
    const owners: Hex[] = [publicKey.toLowerCase() as Hex, pad(permissionsManager).toLowerCase() as Hex];
    const salt = keccak256(encodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], [owners, nonce]));
    const address = getContractAddress({ opcode: 'CREATE2', from: factory, salt, bytecodeHash: initCodeHash });

    return { address, version, factory, owners, nonce: nonce.toString() };
}

/**
 * Whether `record` is exactly the v1 record of `publicKey`. Recomputing the
 * address from the record's own owners is not enough: owners
 * `[publicKey, someoneElse]` give a valid CREATE2 address that someone else
 * co-owns. While v1 is the only recipe and nothing rotates, the only record a
 * key can have is the one it derives.
 */
export function isAccountRecordOf(record: AccountRecord, publicKey: Hex): boolean {
    const expected = deriveAccountRecordV1(publicKey);
    return (
        record.version === expected.version &&
        isAddressEqual(record.address, expected.address) &&
        isAddressEqual(record.factory, expected.factory) &&
        record.nonce === expected.nonce &&
        record.owners.length === expected.owners.length &&
        record.owners.every((owner, i) => owner.toLowerCase() === expected.owners[i])
    );
}

/**
 * The record to use for `publicKey`: the stored one when there is one and it
 * checks out, otherwise the one its key derives.
 *
 * FALLBACK, VALID ONLY WHILE NO ACCOUNT ROTATES. Deriving from the signer's
 * public key gives the right address only for a key that created its account.
 * Once the recovery module lets a passkey be added to an existing account, a
 * rotated key derives a different, empty address, and this fallback would
 * show it with no error. Before rotation ships, an account that may have
 * rotated must not reach this fallback: a missing record or a failed lookup
 * has to surface as an error the user can retry, and `isAccountRecordOf` has
 * to accept records the chain confirms instead of only derived ones.
 */
export function resolveAccountRecord(stored: AccountRecord | undefined, publicKey: Hex): AccountRecord {
    if (stored && isAccountRecordOf(stored, publicKey)) {
        return stored;
    }
    return deriveAccountRecordV1(publicKey);
}

/** The `createAccount` calldata that deploys the account `record` describes. */
export function accountRecordFactoryData(record: AccountRecord): Hex {
    return encodeFunctionData({
        abi: factoryAbi,
        functionName: 'createAccount',
        args: [record.owners, BigInt(record.nonce)],
    });
}
