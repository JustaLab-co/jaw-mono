import { describe, expect, it } from 'vitest';
import { type Hex, decodeFunctionData, pad } from 'viem';
import {
    ACCOUNT_RECIPE_V1,
    type AccountRecord,
    accountRecordFactoryData,
    deriveAccountRecordV1,
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

const [, VECTOR, OTHER_VECTOR] = FACTORY_VECTORS;
const PM_OWNER = pad(ACCOUNT_RECIPE_V1.permissionsManager).toLowerCase() as Hex;

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

describe('isAccountRecordOf', () => {
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
        expect(resolveAccountRecord(stored, VECTOR.publicKey)).toBe(stored);
    });

    it('derives the record when none is stored', () => {
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
});
