import { zeroAddress, type Address } from 'viem';

/**
 * JustaPermissionManager, the same on every chain. Written out rather than imported because a
 * static `@jaw.id/core` import pulls the whole SDK into CLI startup, and the config parser that
 * reads it is synchronous. A test holds it equal to the SDK's.
 */
export const PERMISSIONS_MANAGER = '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8';

/**
 * One call a permission allows: a target, a function selector, and the checker the permission
 * manager asks to approve each call to it. The checker is part of the permission hash.
 */
export interface CallRule {
  target: string;
  selector: string;
  checker?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Whether a value can be a checker at all: a 20-byte address, in any case. */
export function isCheckerAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

/**
 * The checker a call carries. Absent and zero are the same: a record or a wallet from before
 * checkers names none, and every such permission was approved with the zero checker.
 */
export function checkerOf(call: { checker?: string }): Address {
  return (call.checker ?? zeroAddress) as Address;
}

/** Whether a call names a checker other than the zero one, which is none. */
export function hasChecker(call: { checker?: string }): boolean {
  return checkerOf(call).toLowerCase() !== zeroAddress;
}

/**
 * A rule's identity. Two rules on one function with different checkers are two rules, and the
 * manager runs both; no checker and the zero one are the same rule.
 */
export function callRuleKey(call: CallRule): string {
  return `${call.target.toLowerCase()}:${call.selector.toLowerCase()}:${checkerOf(call).toLowerCase()}`;
}

/**
 * Whether the manager would refuse this address as a checker when the permission is approved: it
 * refuses itself, and the account the permission is for. The account is checked only when known,
 * which a permissions config written before any grant is not.
 */
export function isRefusedChecker(checker: string, account?: string): boolean {
  return [PERMISSIONS_MANAGER, account].some((a) => a !== undefined && a.toLowerCase() === checker.toLowerCase());
}
