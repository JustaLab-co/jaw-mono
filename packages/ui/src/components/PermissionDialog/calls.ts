import type { CallPermission } from './types';

/** A call as a grant request carries it: a selector, a signature or both, and an optional checker. */
export interface RequestedCall {
  target: string;
  selector?: string;
  functionSignature?: string;
  checker?: string;
}

/**
 * The requested calls as the grant dialog shows them. One mapping for both hosts, ReactUIHandler
 * and keys.jaw.id, so a field of the signed call (the checker, today) can't reach one screen and
 * not the other.
 *
 * `signatures` is the async selector lookup, keyed by lowercase selector. Until it resolves, a
 * selector renders as its raw hex and upgrades in place.
 */
export function toDialogCalls(calls: readonly RequestedCall[], signatures: Record<string, string>): CallPermission[] {
  return calls.map((call) => ({
    target: call.target,
    selector: call.selector,
    functionSignature:
      call.functionSignature ||
      (call.selector ? (signatures[call.selector.toLowerCase()] ?? call.selector) : 'Unknown Function'),
    checker: call.checker,
  }));
}
