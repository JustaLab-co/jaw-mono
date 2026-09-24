import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handleGetPermissionsRequest, normalizeRevokePermissionsParams } from './permissions.js';
import { fetchRPCRequest } from '../utils/index.js';

vi.mock('../utils/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/index.js')>();
    return {
        ...actual,
        fetchRPCRequest: vi.fn().mockResolvedValue([]),
    };
});

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const CONNECTED = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

function sentRequest() {
    return vi.mocked(fetchRPCRequest).mock.calls[0][0] as {
        params: Array<{ address?: string; chainId?: string }>;
    };
}

describe('handleGetPermissionsRequest', () => {
    beforeEach(() => {
        vi.mocked(fetchRPCRequest).mockClear();
    });

    test('Given address and chainId in params, When handled, Then both travel to the relay untouched', async () => {
        await handleGetPermissionsRequest(
            { method: 'wallet_getPermissions', params: [{ address: ADDRESS, chainId: '0x1' }] },
            'api-key'
        );

        expect(sentRequest().params[0]).toEqual({ address: ADDRESS, chainId: '0x1' });
    });

    test('Given no address but a connected account, When handled, Then the connected address is injected', async () => {
        await handleGetPermissionsRequest({ method: 'wallet_getPermissions', params: [] }, 'api-key', CONNECTED);

        expect(sentRequest().params[0]).toEqual({ address: CONNECTED });
    });

    test('Given a chainId but no address, When the connected address is injected, Then the chain filter is preserved', async () => {
        await handleGetPermissionsRequest(
            { method: 'wallet_getPermissions', params: [{ chainId: '0x2105' }] },
            'api-key',
            CONNECTED
        );

        expect(sentRequest().params[0]).toEqual({ address: CONNECTED, chainId: '0x2105' });
    });

    test('Given no address and no connected account, When handled, Then it rejects with invalid params and nothing is sent', async () => {
        await expect(
            handleGetPermissionsRequest({ method: 'wallet_getPermissions', params: [] }, 'api-key')
        ).rejects.toMatchObject({ message: expect.stringContaining('address') });

        expect(fetchRPCRequest).not.toHaveBeenCalled();
    });
});

const REVOKE_ID = `0x${'ab'.repeat(32)}` as const;

/** Every input that must be refused before a signing window opens. */
const REJECTED: [name: string, id: unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['empty string', ''],
    ['bare 0x', '0x'],
    ['too short', `0x${'ab'.repeat(31)}`],
    ['too long', `0x${'ab'.repeat(33)}`],
    ['no 0x prefix', 'ab'.repeat(32)],
    ['non-hex characters', `0x${'zz'.repeat(32)}`],
    ['a number', 1],
    ['an object', {}],
    // A BigInt used to crash the validator itself: the message interpolated JSON.stringify(value),
    // which throws on one. `request` is in-process, so the dapp saw that TypeError, not -32602.
    ['a bigint', 1n],
];

describe('normalizeRevokePermissionsParams', () => {
    it('accepts a 32-byte id and passes the rest through', () => {
        expect(
            normalizeRevokePermissionsParams([{ id: REVOKE_ID, address: ADDRESS, capabilities: { foo: 1 } }])
        ).toEqual({ id: REVOKE_ID, address: ADDRESS, capabilities: { foo: 1 } });
    });

    it('leaves address undefined when the dapp omits it', () => {
        expect(normalizeRevokePermissionsParams([{ id: REVOKE_ID }])).toEqual({
            id: REVOKE_ID,
            address: undefined,
            capabilities: undefined,
        });
    });

    it('accepts a lowercase, non-checksummed id', () => {
        const lower = `0x${'AB'.repeat(32)}`.toLowerCase();
        expect(normalizeRevokePermissionsParams([{ id: lower }]).id).toBe(lower);
    });

    // The bug this guards: both signers skipped their relay check with `if (permissionId)`, so a
    // falsy id bypassed validation entirely and opened a window over an empty permission.
    it.each(REJECTED)('rejects an id that is %s with -32602', (_name, id) => {
        expect(() => normalizeRevokePermissionsParams([{ id }])).toThrow(/must be a 32-byte hex value/);
        try {
            normalizeRevokePermissionsParams([{ id }]);
        } catch (err) {
            expect((err as { code?: number }).code).toBe(-32602);
        }
    });

    it('rejects a malformed envelope', () => {
        for (const params of [undefined, null, [], [null], ['0x'], {}]) {
            expect(() => normalizeRevokePermissionsParams(params)).toThrow(/expected a single object parameter/);
        }
    });

    it('rejects a malformed address even when the id is fine', () => {
        expect(() => normalizeRevokePermissionsParams([{ id: REVOKE_ID, address: '0xabc' }])).toThrow(
            /must be a 20-byte hex address/
        );
    });
});
