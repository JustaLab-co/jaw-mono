import { describe, expect, it } from 'vitest';
import { type Hex, decodeFunctionData, pad } from 'viem';
import {
    ACCOUNT_RECIPE_V1,
    ACCOUNT_RECIPE_V2,
    type AccountRecord,
    accountRecordFactoryData,
    deriveAccountRecordV1,
    deriveAccountRecordV2,
    deriveNewAccountRecord,
    isAccountRecordOf,
    resolveAccountRecord,
} from './accountRecord.js';
import { factoryAbi } from './toJustanAccount.js';

/**
 * Expected addresses come from the deployed factory, not from this code:
 * cast call 0x5803c076563C85799989d42Fc00292A8aE52fa9E \
 *   'getAddress(bytes[],uint256)(address)' \
 *   '[<publicKey>,0x000000000000000000000000f1b40E3D5701C04d86F7828f0EB367B9C90901D8]' 0 \
 *   --rpc-url https://mainnet.base.org
 * They never move to match the code; if one fails, the derivation is wrong.
 */
const FACTORY_VECTORS: { publicKey: Hex; address: Hex }[] = [
    {
        publicKey: `0x${'11'.repeat(64)}`,
        address: '0x3f9D0947449d8dbAfDC6ACFE301593e97176780F',
    },
    {
        publicKey:
            '0x885d083da109f4ea0b626025ee5886d869f51817afad5a380f2b1fa9a35bccf8d52b9347c47495158ef458c338cdd15f7a902d357541d0e19d0b19e8f7ea0fd8',
        address: '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62',
    },
    {
        publicKey:
            '0xdebc6e2f6d482a438e57b6f3c243c6d3899115b664a81a0da8c34e062748442745c98f217813ed30da51350a533b81210a98709f513f8707e113aba0f1a8e5c8',
        address: '0x10EAc035a0C430cD6bd8E39e2a85B5F8922dAEba',
    },
];

/**
 * The same keys under the v2 recipe, also from the deployed factory, on Base and
 * Base Sepolia alike:
 * cast call 0x5803c076563C85799989d42Fc00292A8aE52fa9E \
 *   'getAddress(bytes[],uint256)(address)' \
 *   '[<publicKey>,0x000000000000000000000000f1b40E3D5701C04d86F7828f0EB367B9C90901D8,0x0000000000000000000000009D1df5AeBE2CdBe6051687C0ab2c788890907E45]' 0 \
 *   --rpc-url https://mainnet.base.org
 */
const FACTORY_VECTORS_V2: { publicKey: Hex; address: Hex }[] = [
    {
        publicKey: FACTORY_VECTORS[0].publicKey,
        address: '0x6644F4510907965B878ab6b93b0a0334f86A56CB',
    },
    {
        publicKey: FACTORY_VECTORS[1].publicKey,
        address: '0x201bcE6e444BA385F9c79d972D6b8E7dCc58e98c',
    },
    {
        publicKey: FACTORY_VECTORS[2].publicKey,
        address: '0xF5080CEBf6Be3091F6fC58524a242A4EF22F41FF',
    },
];

const [, VECTOR, OTHER_VECTOR] = FACTORY_VECTORS;
const [, VECTOR_V2] = FACTORY_VECTORS_V2;
const PM_OWNER = pad(ACCOUNT_RECIPE_V1.permissionsManager).toLowerCase() as Hex;
const RM_OWNER = pad(ACCOUNT_RECIPE_V2.recoveryManager).toLowerCase() as Hex;

describe('deriveAccountRecordV1', () => {
    it.each(FACTORY_VECTORS)('derives the address the factory reports for $publicKey', ({ publicKey, address }) => {
        expect(deriveAccountRecordV1(publicKey).address).toBe(address);
    });

    it('records the v1 recipe the address was computed from', () => {
        expect(deriveAccountRecordV1(VECTOR.publicKey)).toEqual({
            address: VECTOR.address,
            version: 1,
            factory: '0x5803c076563C85799989d42Fc00292A8aE52fa9E',
            owners: [VECTOR.publicKey, PM_OWNER],
            nonce: '0',
        });
    });

    it('gives the same record for a key in either case', () => {
        const upper = `0x${VECTOR.publicKey.slice(2).toUpperCase()}` as Hex;
        expect(deriveAccountRecordV1(upper)).toEqual(deriveAccountRecordV1(VECTOR.publicKey));
    });
});

describe('deriveAccountRecordV2', () => {
    it.each(FACTORY_VECTORS_V2)('derives the address the factory reports for $publicKey', ({ publicKey, address }) => {
        expect(deriveAccountRecordV2(publicKey).address).toBe(address);
    });

    it('records the v2 recipe: the v1 owners followed by the recovery manager', () => {
        expect(deriveAccountRecordV2(VECTOR_V2.publicKey)).toEqual({
            address: VECTOR_V2.address,
            version: 2,
            factory: '0x5803c076563C85799989d42Fc00292A8aE52fa9E',
            owners: [VECTOR_V2.publicKey, PM_OWNER, RM_OWNER],
            nonce: '0',
        });
    });
});

describe('deriveNewAccountRecord', () => {
    it('gives a new account the v2 recipe', () => {
        expect(deriveNewAccountRecord(VECTOR.publicKey)).toEqual(deriveAccountRecordV2(VECTOR.publicKey));
    });
});

describe('isAccountRecordOf', () => {
    it('accepts the v2 record its key derives', () => {
        expect(isAccountRecordOf(deriveAccountRecordV2(VECTOR.publicKey), VECTOR.publicKey)).toBe(true);
    });

    it("rejects another key's v2 record", () => {
        expect(isAccountRecordOf(deriveAccountRecordV2(OTHER_VECTOR.publicKey), VECTOR.publicKey)).toBe(false);
    });

    it.each([
        ['the managers swapped', { owners: [VECTOR.publicKey, RM_OWNER, PM_OWNER] }],
        [
            'a foreign owner in place of the recovery manager',
            { owners: [VECTOR.publicKey, PM_OWNER, pad('0x000000000000000000000000000000000000dEaD').toLowerCase()] },
        ],
        ['the v1 version number', { version: 1 }],
        ['an unknown version number', { version: 3 }],
    ] as const)('rejects a v2 record with %s', (_, change) => {
        const record = { ...deriveAccountRecordV2(VECTOR.publicKey), ...change } as AccountRecord;
        expect(isAccountRecordOf(record, VECTOR.publicKey)).toBe(false);
    });

    it('accepts the record its key derives', () => {
        expect(isAccountRecordOf(deriveAccountRecordV1(VECTOR.publicKey), VECTOR.publicKey)).toBe(true);
    });

    it('accepts a stored record whose hex is in another case', () => {
        const record = deriveAccountRecordV1(VECTOR.publicKey);
        const stored: AccountRecord = {
            ...record,
            address: record.address.toLowerCase() as Hex,
            owners: record.owners.map((owner) => `0x${owner.slice(2).toUpperCase()}` as Hex),
        };
        expect(isAccountRecordOf(stored, VECTOR.publicKey)).toBe(true);
    });

    it("rejects another key's record", () => {
        expect(isAccountRecordOf(deriveAccountRecordV1(OTHER_VECTOR.publicKey), VECTOR.publicKey)).toBe(false);
    });

    it('rejects a record that adds a co-owner, even though its address is a valid CREATE2 address', () => {
        const record = deriveAccountRecordV1(VECTOR.publicKey);
        const coOwned: AccountRecord = {
            ...record,
            owners: [VECTOR.publicKey, pad('0x000000000000000000000000000000000000dEaD').toLowerCase() as Hex],
        };
        expect(isAccountRecordOf(coOwned, VECTOR.publicKey)).toBe(false);
    });

    it.each([
        ['address', { address: OTHER_VECTOR.address }],
        ['factory', { factory: '0x0000000000000000000000000000000000000001' }],
        ['nonce', { nonce: '1' }],
        ['version', { version: 2 }],
        ['owner order', { owners: [PM_OWNER, VECTOR.publicKey] }],
        ['owner count', { owners: [VECTOR.publicKey] }],
    ] as const)('rejects a record with a different %s', (_, change) => {
        const record = { ...deriveAccountRecordV1(VECTOR.publicKey), ...change } as AccountRecord;
        expect(isAccountRecordOf(record, VECTOR.publicKey)).toBe(false);
    });
});

describe('resolveAccountRecord', () => {
    it('returns the stored record when it checks out', () => {
        const stored = deriveAccountRecordV1(VECTOR.publicKey);
        expect(resolveAccountRecord(stored, VECTOR.publicKey)).toEqual(stored);
    });

    it('checksums the addresses of a stored record that checks out in another casing', () => {
        const valid = deriveAccountRecordV1(VECTOR.publicKey);
        const stored = {
            ...valid,
            address: valid.address.toLowerCase() as Hex,
            factory: valid.factory.toLowerCase() as Hex,
        };
        expect(resolveAccountRecord(stored, VECTOR.publicKey)).toEqual(valid);
    });

    it('returns a stored v2 record when it checks out', () => {
        const stored = deriveAccountRecordV2(VECTOR.publicKey);
        expect(resolveAccountRecord(stored, VECTOR.publicKey)).toEqual(stored);
    });

    it('derives the v1 record when none is stored: only entries saved before records existed have none', () => {
        expect(resolveAccountRecord(undefined, VECTOR.publicKey).address).toBe(VECTOR.address);
    });

    it('derives the record when the stored one belongs to another account', () => {
        const stored = deriveAccountRecordV1(OTHER_VECTOR.publicKey);
        expect(resolveAccountRecord(stored, VECTOR.publicKey).address).toBe(VECTOR.address);
    });

    // A record comes from a server response or localStorage, so its shape is
    // not guaranteed. A malformed one is ignored, never thrown on.
    const valid = deriveAccountRecordV1(VECTOR.publicKey);
    it.each([
        ['an empty address', { ...valid, address: '' }],
        ['no address', { ...valid, address: undefined }],
        ['no factory', { ...valid, factory: undefined }],
        ['no owners', { ...valid, owners: undefined }],
        ['owners that are not an array', { ...valid, owners: 'nope' }],
        ['an owner that is not a string', { ...valid, owners: [null, PM_OWNER] }],
        ['a numeric nonce', { ...valid, nonce: 0 }],
        ['null', null],
    ])('derives the record when the stored one has %s', (_, stored) => {
        const record = resolveAccountRecord(stored as unknown as AccountRecord, VECTOR.publicKey);
        expect(record).toEqual(valid);
        expect(record).not.toBe(stored);
    });
});

describe('accountRecordFactoryData', () => {
    it("encodes createAccount with the record's owners and nonce", () => {
        const record = deriveAccountRecordV1(VECTOR.publicKey);
        const { functionName, args } = decodeFunctionData({
            abi: factoryAbi,
            data: accountRecordFactoryData(record),
        });

        expect(functionName).toBe('createAccount');
        expect(args).toEqual([[VECTOR.publicKey, PM_OWNER], 0n]);
    });

    it('encodes all three owners of a v2 record', () => {
        const { args } = decodeFunctionData({
            abi: factoryAbi,
            data: accountRecordFactoryData(deriveAccountRecordV2(VECTOR_V2.publicKey)),
        });

        expect(args).toEqual([[VECTOR_V2.publicKey, PM_OWNER, RM_OWNER], 0n]);
    });
});
