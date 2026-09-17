import { describe, it, expect } from 'vitest';
import { normalizeSendCallsParams } from './sendCallsParams.js';
import { standardErrorCodes } from '../errors/index.js';

/** Exactly what viem's sendCalls() puts in params[0] by default (version '2.0.0'). */
const viemV2Params = {
    atomicRequired: false,
    calls: [
        { to: '0x0987654321098765432109876543210987654321', data: '0xdeadbeef', value: undefined },
        { to: '0x0987654321098765432109876543210987654321', data: undefined, value: '0x10f2c' },
    ],
    capabilities: undefined,
    chainId: '0x66eee', // 421614 (Arbitrum Sepolia)
    from: '0x1234567890123456789012345678901234567890',
    id: undefined,
    version: '2.0.0',
};

/** The v1.0 envelope dapps built by hand before viem defaulted to 2.0.0. */
const v1Params = {
    version: '1.0',
    from: '0x1234567890123456789012345678901234567890',
    chainId: '0x66eee',
    calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0xdeadbeef', value: '0x0' }],
};

function expectInvalidParams(fn: () => unknown) {
    try {
        fn();
    } catch (error) {
        const { code, message } = error as { code: number; message: string };
        expect(code).toBe(standardErrorCodes.rpc.invalidParams);
        return message;
    }
    throw new Error('expected normalizeSendCallsParams to throw');
}

describe('normalizeSendCallsParams', () => {
    it('accepts the viem v2.0.0 envelope', () => {
        const result = normalizeSendCallsParams([viemV2Params]);

        expect(result).toEqual({
            version: '2.0.0',
            from: '0x1234567890123456789012345678901234567890',
            chainId: '0x66eee',
            atomicRequired: false,
            calls: [
                { to: '0x0987654321098765432109876543210987654321', data: '0xdeadbeef' },
                { to: '0x0987654321098765432109876543210987654321', value: '0x10f2c' },
            ],
        });
    });

    it('accepts the v1.0 envelope unchanged', () => {
        const result = normalizeSendCallsParams([v1Params]);

        expect(result.version).toBe('1.0');
        expect(result.chainId).toBe('0x66eee');
        expect(result.calls).toEqual([
            { to: '0x0987654321098765432109876543210987654321', data: '0xdeadbeef', value: '0x0' },
        ]);
    });

    it('defaults a missing version to 1.0', () => {
        const { version } = normalizeSendCallsParams([{ ...v1Params, version: undefined }]);
        expect(version).toBe('1.0');
    });

    it('defaults atomicRequired to false when absent', () => {
        expect(normalizeSendCallsParams([v1Params]).atomicRequired).toBe(false);
    });

    it('keeps atomicRequired: true (ERC-4337 batches are atomic)', () => {
        expect(normalizeSendCallsParams([{ ...viemV2Params, atomicRequired: true }]).atomicRequired).toBe(true);
    });

    it('normalizes a numeric chainId to hex', () => {
        expect(normalizeSendCallsParams([{ ...v1Params, chainId: 421614 }]).chainId).toBe('0x66eee');
    });

    it('leaves chainId undefined when the dapp omits it', () => {
        expect(normalizeSendCallsParams([{ ...v1Params, chainId: undefined }]).chainId).toBeUndefined();
    });

    it('preserves capabilities', () => {
        const capabilities = { paymasterService: { url: 'https://paymaster.test' } };
        const result = normalizeSendCallsParams([{ ...viemV2Params, capabilities }]);

        expect(result.capabilities).toEqual(capabilities);
    });

    // A caller-supplied `id` is not honored: the batch is registered under the
    // batchId the wallet generates, so accepting one would hand the dapp an id
    // that wallet_getCallsStatus rejects with 5730. It's dropped, not echoed.
    it('drops a caller-supplied batch id rather than echoing one it will not honor', () => {
        const result = normalizeSendCallsParams([{ ...viemV2Params, id: '0xabc' }]);

        expect(result).not.toHaveProperty('id');
    });

    it('rejects an unsupported version with -32602 naming the supported versions', () => {
        const message = expectInvalidParams(() => normalizeSendCallsParams([{ ...viemV2Params, version: '3.0.0' }]));
        expect(message).toContain('3.0.0');
        expect(message).toContain('1.0');
        expect(message).toContain('2.0.0');
    });

    it('rejects a missing params object with -32602', () => {
        expectInvalidParams(() => normalizeSendCallsParams([]));
        expectInvalidParams(() => normalizeSendCallsParams(undefined));
    });

    it('rejects a missing or empty calls array with -32602', () => {
        expectInvalidParams(() => normalizeSendCallsParams([{ ...v1Params, calls: undefined }]));
        expectInvalidParams(() => normalizeSendCallsParams([{ ...v1Params, calls: [] }]));
    });

    it('rejects a malformed call entry with -32602', () => {
        const message = expectInvalidParams(() => normalizeSendCallsParams([{ ...v1Params, calls: ['0xdead'] }]));
        expect(message).toContain('calls[0]');
    });

    it('rejects a call without a target — ERC-4337 execute needs one', () => {
        const message = expectInvalidParams(() =>
            normalizeSendCallsParams([{ ...v1Params, calls: [{ data: '0xdeadbeef' }] }])
        );
        expect(message).toContain('calls[0].to');
    });

    it('rejects a target that is hex but not 20 bytes — it would fail inside an open dialog', () => {
        for (const to of ['0x', '0xabc', `0x${'ab'.repeat(21)}`]) {
            const message = expectInvalidParams(() => normalizeSendCallsParams([{ ...v1Params, calls: [{ to }] }]));
            expect(message).toContain('calls[0].to');
        }
    });

    it('accepts a lowercase or non-checksummed target — only the checksum is not required', () => {
        const lower = '0x0987654321098765432109876543210987654321';
        const mixed = '0xAbCdeF0123456789012345678901234567890123';

        expect(normalizeSendCallsParams([{ ...v1Params, calls: [{ to: lower }] }]).calls[0].to).toBe(lower);
        expect(normalizeSendCallsParams([{ ...v1Params, calls: [{ to: mixed }] }]).calls[0].to).toBe(mixed);
    });

    it('keeps accepting decimal wei values, which the signing UIs always BigInt()-ed', () => {
        const result = normalizeSendCallsParams([
            { ...v1Params, calls: [{ to: '0x0987654321098765432109876543210987654321', value: '1000000000000000' }] },
        ]);

        expect(result.calls[0].value).toBe('0x38d7ea4c68000');
        expect(BigInt(result.calls[0].value!)).toBe(1000000000000000n);
    });

    it('rejects a non-hex chainId with -32602', () => {
        expectInvalidParams(() => normalizeSendCallsParams([{ ...v1Params, chainId: 'arbitrum-sepolia' }]));
    });

    // A bare '0x' satisfies a hex charset check but `BigInt('0x')` throws, so
    // letting it through would crash the signing dialog after it opened —
    // exactly the failure this validation exists to turn into a -32602.
    it('rejects a bare 0x value — hex charset, but not a quantity', () => {
        const message = expectInvalidParams(() =>
            normalizeSendCallsParams([
                { ...v1Params, calls: [{ to: '0x0987654321098765432109876543210987654321', value: '0x' }] },
            ])
        );
        expect(message).toContain('calls[0].value');
    });

    it('rejects a bare 0x chainId', () => {
        expectInvalidParams(() => normalizeSendCallsParams([{ ...v1Params, chainId: '0x' }]));
    });

    it("keeps accepting '0x' as call data — empty calldata is a plain value transfer", () => {
        const result = normalizeSendCallsParams([
            { ...v1Params, calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0x' }] },
        ]);

        expect(result.calls[0].data).toBe('0x');
    });

    describe('capabilities (EIP-5792 5700)', () => {
        function expectUnsupportedCapability(fn: () => unknown) {
            try {
                fn();
            } catch (error) {
                const { code, message } = error as { code: number; message: string };
                expect(code).toBe(standardErrorCodes.eip5792.unsupportedNonOptionalCapability);
                return message;
            }
            throw new Error('expected normalizeSendCallsParams to throw');
        }

        it('accepts the capabilities we implement', () => {
            const capabilities = {
                paymasterService: { url: 'https://paymaster.test' },
                permissions: { id: '0xabc' },
            };
            expect(normalizeSendCallsParams([{ ...viemV2Params, capabilities }]).capabilities).toEqual(capabilities);
        });

        it('rejects an unimplemented non-optional capability with 5700', () => {
            const message = expectUnsupportedCapability(() =>
                normalizeSendCallsParams([{ ...viemV2Params, capabilities: { flashLoan: { amount: '0x1' } } }])
            );
            expect(message).toContain('flashLoan');
        });

        it('ignores an unimplemented capability the dapp marked optional', () => {
            const capabilities = { dataSuffix: { value: '0xabcd', optional: true } };
            expect(normalizeSendCallsParams([{ ...viemV2Params, capabilities }]).capabilities).toEqual(capabilities);
        });
    });

    // `optionalHexQuantity` echoed the rejected value through a bare
    // `JSON.stringify`, which raises on a circular object — so building the
    // -32602 message threw a TypeError and the dapp got that instead, with no
    // RPC code on it. The same trap `optionalChainId` had.
    it('refuses an unserializable value with -32602 rather than a TypeError', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        const message = expectInvalidParams(() =>
            normalizeSendCallsParams([
                {
                    version: '2.0.0',
                    calls: [{ to: '0x0987654321098765432109876543210987654321', value: circular }],
                },
            ])
        );

        // The describeValue fallback, proving the message was built rather than
        // the stringify having thrown on the way to it.
        expect(message).toContain('[object Object]');
    });
});
