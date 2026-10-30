import {
    type Address,
    type Hex,
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    getContractAddress,
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
 * The recipe of accounts created once the recovery module shipped: v1's owners
 * followed by the recovery manager, so recovery works on any network the
 * account is deployed on, with no setup transaction. Frozen like v1.
 */
export const ACCOUNT_RECIPE_V2 = {
    ...ACCOUNT_RECIPE_V1,
    version: 2,
    recoveryManager: '0x9D1df5AeBE2CdBe6051687C0ab2c788890907E45',
} as const satisfies {
    version: number;
    factory: Address;
    initCodeHash: Hex;
    permissionsManager: Address;
    recoveryManager: Address;
    nonce: bigint;
};

/**
 * The record for `owners` under a recipe: the address the factory's CREATE2
 * deploys them to. Computed locally, the same way `factory.getAddress` does,
 * so it needs no RPC.
 */
function deriveRecord(
    { version, factory, initCodeHash, nonce }: { version: number; factory: Address; initCodeHash: Hex; nonce: bigint },
    owners: Hex[]
): AccountRecord {
    const salt = keccak256(encodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], [owners, nonce]));
    const address = getContractAddress({ opcode: 'CREATE2', from: factory, salt, bytecodeHash: initCodeHash });

    return { address, version, factory, owners, nonce: nonce.toString() };
}

/** The v1 record for a passkey public key: owners `[publicKey, permissionsManager]`, nonce 0. */
export function deriveAccountRecordV1(publicKey: Hex): AccountRecord {
    const { permissionsManager } = ACCOUNT_RECIPE_V1;
    return deriveRecord(ACCOUNT_RECIPE_V1, [
        publicKey.toLowerCase() as Hex,
        pad(permissionsManager).toLowerCase() as Hex,
    ]);
}

/** The v2 record for a passkey public key: owners `[publicKey, permissionsManager, recoveryManager]`, nonce 0. */
export function deriveAccountRecordV2(publicKey: Hex): AccountRecord {
    const { permissionsManager, recoveryManager } = ACCOUNT_RECIPE_V2;
    return deriveRecord(ACCOUNT_RECIPE_V2, [
        publicKey.toLowerCase() as Hex,
        pad(permissionsManager).toLowerCase() as Hex,
        pad(recoveryManager).toLowerCase() as Hex,
    ]);
}

/**
 * The record a new account is created with. The one place that picks the
 * recipe for new accounts; existing accounts keep the record they were
 * created with.
 */
export function deriveNewAccountRecord(publicKey: Hex): AccountRecord {
    return deriveAccountRecordV2(publicKey);
}

/** The record `publicKey` derives under recipe `version`, or undefined for a version no recipe has. */
function deriveRecordOfVersion(version: unknown, publicKey: Hex): AccountRecord | undefined {
    if (version === ACCOUNT_RECIPE_V1.version) return deriveAccountRecordV1(publicKey);
    if (version === ACCOUNT_RECIPE_V2.version) return deriveAccountRecordV2(publicKey);
    return undefined;
}

/**
 * Whether `record` is exactly the record `publicKey` derives under the recipe
 * the record names. Recomputing the address from the record's own owners is
 * not enough: owners `[publicKey, someoneElse]` give a valid CREATE2 address
 * that someone else co-owns. While nothing rotates, the only records a key can
 * have are the ones its recipes derive.
 *
 * Total: a record comes from a server response or localStorage, so any field
 * may be missing or of the wrong type, and such a record is rejected rather
 * than thrown on.
 */
export function isAccountRecordOf(record: AccountRecord, publicKey: Hex): boolean {
    const expected = deriveRecordOfVersion(record?.version, publicKey);
    if (!expected) return false;
    const owners: unknown = record.owners;
    return (
        sameHex(record.address, expected.address) &&
        sameHex(record.factory, expected.factory) &&
        record.nonce === expected.nonce &&
        Array.isArray(owners) &&
        owners.length === expected.owners.length &&
        owners.every((owner, i) => sameHex(owner, expected.owners[i]))
    );
}

function sameHex(value: unknown, expected: Hex): boolean {
    return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

/**
 * The record to use for `publicKey`: the stored one when there is one and it
 * checks out, otherwise the v1 record its key derives. A stored record's
 * addresses are returned checksummed whatever their casing, like a derived one's.
 *
 * The derived v1 record is right only for a stored device entry saved before
 * records existed: every account created since stores its record, and a v2
 * account has no other way to be found. A caller that may hold a v2 account
 * must have its record, from storage or the backend, before it gets here.
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
        return { ...stored, address: getAddress(stored.address), factory: getAddress(stored.factory) };
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
