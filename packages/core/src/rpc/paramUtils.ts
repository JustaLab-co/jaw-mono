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
 * Requires a 20-byte address. `strict: false` checks length and charset
 * (`/^0x[a-fA-F0-9]{40}$/`) without demanding a valid checksum, so a lowercase
 * or non-checksummed address still passes — but a truncated one ('0x', '0xabc')
 * is refused here rather than failing later inside an already-open dialog.
 */
export function requireHexAddress(value: unknown, method: string, field: string): `0x${string}` {
    if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
        throw standardErrors.rpc.invalidParams(`${method}: ${field} must be a 20-byte hex address`);
    }
    return value as `0x${string}`;
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

/**
 * Renders a rejected value for an error message without being able to throw.
 *
 * `JSON.stringify` raises on a BigInt and on a circular object, so echoing a
 * value straight into a `-32602` message can replace that typed RPC error with
 * an untyped `TypeError` — the very failure the message exists to describe.
 */
function describeValue(value: unknown): string {
    if (typeof value === 'bigint') return `${value}n`;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
}

/** Accepts a hex chainId (what viem sends), a number, or a bigint, and returns hex. */
export function optionalChainId(chainId: unknown, method: string): `0x${string}` | undefined {
    if (chainId === undefined || chainId === null) return undefined;
    if (typeof chainId === 'number') {
        if (!Number.isSafeInteger(chainId) || chainId <= 0) {
            throw standardErrors.rpc.invalidParams(`${method}: invalid chainId ${chainId}`);
        }
        return numberToHex(chainId);
    }
    // A bigint is a legitimate way to hold a chain id, and `optionalHexQuantity`
    // has always accepted one for the other quantities. Without this branch it
    // fell through to the throw below, where `JSON.stringify` raised
    // `TypeError: Do not know how to serialize a BigInt` — so `{ chainId: 8453n }`
    // reached the dapp as an untyped TypeError instead of -32602, in
    // wallet_sendCalls and wallet_sendTransaction as well as here.
    if (typeof chainId === 'bigint') {
        if (chainId <= 0n) {
            throw standardErrors.rpc.invalidParams(`${method}: invalid chainId ${chainId}`);
        }
        return numberToHex(chainId);
    }
    if (isHexQuantity(chainId)) return chainId;
    throw standardErrors.rpc.invalidParams(
        `${method}: chainId must be a hex string (e.g. '0x66eee') or a number, got ${describeValue(chainId)}`
    );
}

/**
 * A list of chainIds, each accepted in the same shapes as `optionalChainId`.
 *
 * An empty array is refused rather than read as "no preference". A caller that
 * sends one has computed it — `chains: supported.filter(...)` that matched
 * nothing — and answering that with the wallet's own default would show the
 * user every chain at the exact moment the dapp meant none. -32602 surfaces the
 * empty filter to the dapp instead of hiding it behind a plausible screen.
 *
 * Deduplicated in order, so a repeated id cannot draw the same icon twice.
 */
export function optionalChainIdList(value: unknown, method: string, field: string): `0x${string}`[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
        throw standardErrors.rpc.invalidParams(`${method}: ${field} must be an array of chainIds`);
    }
    if (value.length === 0) {
        throw standardErrors.rpc.invalidParams(`${method}: ${field} must not be empty`);
    }

    const seen = new Set<string>();
    const chains: `0x${string}`[] = [];
    for (const entry of value) {
        // `optionalChainId` answers undefined for a null or undefined entry.
        // At the top level that means "omitted", but a hole inside an explicit
        // list is a malformed entry, so it is refused here rather than skipped
        // — and checking the result rather than the input gives `hex` its
        // non-undefined type without an assertion.
        const hex = optionalChainId(entry, method);
        if (hex === undefined) {
            throw standardErrors.rpc.invalidParams(`${method}: ${field} must not contain empty entries`);
        }
        // Compared as BigInt, not as the hex string: '0x1' and '0x01' are the
        // same chain, and viem's own encoders disagree about leading zeros.
        const key = BigInt(hex).toString();
        if (seen.has(key)) continue;
        seen.add(key);
        chains.push(hex);
    }
    return chains;
}
