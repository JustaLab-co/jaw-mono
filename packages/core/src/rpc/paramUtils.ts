import { isAddress, numberToHex } from 'viem';
import { standardErrors } from '../errors/index.js';

/**
 * Shared shape checks for dapp-supplied RPC params. Validation lives in the SDK
 * (not in the signing UI) so a malformed request is refused with a
 * standards-compliant error before any popup or dialog opens.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hex bytes as sent over JSON-RPC. The charset is `*`, not `+`: a bare '0x' is
 * legitimate empty calldata, so it has to pass here.
 */
export function isHexString(value: unknown): value is `0x${string}` {
    return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Hex quantity as sent over JSON-RPC — at least one digit, unlike hex bytes.
 *
 * A bare '0x' has to be refused separately because it satisfies `isHexString`
 * while `BigInt('0x')` throws: without this, '0x' would pass validation and then
 * raise an untyped SyntaxError deep inside an already-open signing dialog,
 * instead of surfacing to the dapp as -32602.
 */
function isHexQuantity(value: unknown): value is `0x${string}` {
    return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

/** Asserts `params` is a `[{ ... }]` tuple and returns the envelope. */
export function requireParamsObject(params: unknown, method: string): Record<string, unknown> {
    if (!Array.isArray(params) || params.length === 0 || !isRecord(params[0])) {
        throw standardErrors.rpc.invalidParams(`${method}: expected a single object parameter`);
    }
    return params[0];
}

/**
 * Whether this is a 20-byte address. `strict: false` checks length and charset
 * (`/^0x[a-fA-F0-9]{40}$/`) without demanding a valid checksum, so a lowercase
 * or non-checksummed address still passes — but a truncated one ('0x', '0xabc')
 * does not.
 */
export function isHexAddress(value: unknown): value is `0x${string}` {
    return typeof value === 'string' && isAddress(value, { strict: false });
}

/**
 * Requires a 20-byte address, refusing a truncated one here rather than letting
 * it fail later inside an already-open dialog.
 */
export function requireHexAddress(value: unknown, method: string, field: string): `0x${string}` {
    if (!isHexAddress(value)) {
        throw standardErrors.rpc.invalidParams(`${method}: ${field} must be a 20-byte hex address`);
    }
    return value;
}

/**
 * Requires a 32-byte hex value — the shape of a permission id, which is the
 * `bytes32` hash emitted by `PermissionApproved`.
 *
 * A missing id is refused here rather than treated as "no permission named":
 * `wallet_revokePermissions` is *about* a permission, so an absent id is a
 * malformed request, not an absence. Skipping the check on a falsy id is what
 * previously let an empty id open a signing window with nothing to sign.
 */
export function requireHexBytes32(value: unknown, method: string, field: string): `0x${string}` {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        // The value is deliberately not echoed: JSON.stringify throws on a BigInt (and on a
        // circular object), and `request` is in-process, so a dapp passing `{ id: 1n }` would get
        // that TypeError out of the validator instead of -32602. `requireHexAddress` does the same.
        throw standardErrors.rpc.invalidParams(`${method}: ${field} must be a 32-byte hex value`);
    }
    return value as `0x${string}`;
}

export function optionalHexAddress(value: unknown, method: string, field: string): `0x${string}` | undefined {
    if (value === undefined || value === null) return undefined;
    return requireHexAddress(value, method, field);
}

/**
 * Normalizes a quantity to hex. viem sends hex, but the signing UIs have always
 * fed these through `BigInt(value)`, which also accepts a decimal string or a
 * number — so keep accepting everything that used to reach a wallet, and
 * hex-encode it here instead of leaving the conversion downstream.
 */
export function optionalHexQuantity(value: unknown, method: string, field: string): `0x${string}` | undefined {
    if (value === undefined || value === null) return undefined;
    if (isHexQuantity(value)) return value;

    // Decimal wei string, e.g. '1000000000000000' — `BigInt` reads it as
    // decimal, so preserve that reading rather than guessing hex.
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        return numberToHex(BigInt(value));
    }

    // Both branches guard the sign: `numberToHex` rejects a negative with viem's
    // own IntegerOutOfRangeError, which carries no RPC code and would reach the
    // dapp untyped instead of as -32602.
    if (typeof value === 'bigint') {
        if (value < 0n) {
            throw standardErrors.rpc.invalidParams(`${method}: ${field} must be a non-negative integer`);
        }
        return numberToHex(value);
    }

    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw standardErrors.rpc.invalidParams(`${method}: ${field} must be a non-negative integer`);
        }
        return numberToHex(value);
    }

    throw standardErrors.rpc.invalidParams(`${method}: ${field} must be a hex quantity, got ${JSON.stringify(value)}`);
}

export function optionalHexData(value: unknown, method: string, field: string): `0x${string}` | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isHexString(value)) {
        throw standardErrors.rpc.invalidParams(`${method}: ${field} must be hex-encoded`);
    }
    return value;
}

/** Accepts a hex chainId (what viem sends) or a number, and returns hex. */
export function optionalChainId(chainId: unknown, method: string): `0x${string}` | undefined {
    if (chainId === undefined || chainId === null) return undefined;
    if (typeof chainId === 'number') {
        if (!Number.isSafeInteger(chainId) || chainId <= 0) {
            throw standardErrors.rpc.invalidParams(`${method}: invalid chainId ${chainId}`);
        }
        return numberToHex(chainId);
    }
    if (isHexQuantity(chainId)) return chainId;
    throw standardErrors.rpc.invalidParams(
        `${method}: chainId must be a hex string (e.g. '0x66eee') or a number, got ${JSON.stringify(chainId)}`
    );
}
