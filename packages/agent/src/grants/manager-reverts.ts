import { decodeErrorResult, decodeEventLog, isHex, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';
import { entryPoint08Abi, entryPoint08Address } from 'viem/account-abstraction';

/** What the permission manager refused a session key's userOp for, read from its revert. */
export type ManagerRefusal =
  | { reason: 'call-not-allowed'; target: Address; selector: Hex }
  // The rule allows the call; the checker on it refused the call's arguments.
  | CheckerRejected
  | { reason: 'over-limit'; onChain: true }
  | { reason: 'expired' }
  | { reason: 'no-grant' };

type CheckerRejected = { reason: 'checker-rejected'; target: Address; selector: Hex; checker: Address };

/**
 * What to do about a checker's refusal, said the same way by every host that sends as a session
 * key. The call is allowed, so the fix is in its arguments and a wider permission would not help.
 */
export function checkerRejectedDetail(refused: CheckerRejected, permissionId: string): string {
  return (
    `Change the call's arguments, never the permission: permission ${permissionId} allows calling ` +
    `${refused.selector} on ${refused.target}, but its checker ${refused.checker} refused this call's arguments.`
  );
}

const SIGNATURES = [
  'error JustaPermissionManager_UnauthorizedCall(address target, bytes4 selector)',
  'error JustaPermissionManager_CheckerRejectedCall(address target, bytes4 selector, address checker)',
  'error JustaPermissionManager_ExceededSpendLimit(uint256 value, uint256 allowance)',
  'error JustaPermissionManager_NoSpendPermissions()',
  'error JustaPermissionManager_SpendValueOverflow(uint256 value)',
  'error JustaPermissionManager_AfterPermissionEnd(uint48 currentTimestamp, uint48 end)',
  'error JustaPermissionManager_BeforePermissionStart(uint48 currentTimestamp, uint48 start)',
  'error JustaPermissionManager_UnauthorizedPermission()',
] as const;
const MANAGER_ERRORS = parseAbi(SIGNATURES);
const SELECTORS = SIGNATURES.map((s) =>
  toFunctionSelector(s.slice('error '.length).replace(/ \w+(?=[,)])/g, '')).slice(2)
);

// Revert data past this is not a manager error the bundler or EntryPoint reported.
const MAX_SCAN = 8_192;

function refusalOf(data: Hex): ManagerRefusal | undefined {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: MANAGER_ERRORS, data });
  } catch {
    return undefined;
  }
  switch (decoded.errorName) {
    case 'JustaPermissionManager_UnauthorizedCall':
      return { reason: 'call-not-allowed', target: decoded.args[0], selector: decoded.args[1] };
    case 'JustaPermissionManager_CheckerRejectedCall':
      return {
        reason: 'checker-rejected',
        target: decoded.args[0],
        selector: decoded.args[1],
        checker: decoded.args[2],
      };
    case 'JustaPermissionManager_ExceededSpendLimit':
    case 'JustaPermissionManager_NoSpendPermissions':
    case 'JustaPermissionManager_SpendValueOverflow':
      return { reason: 'over-limit', onChain: true };
    case 'JustaPermissionManager_AfterPermissionEnd':
    case 'JustaPermissionManager_BeforePermissionStart':
      return { reason: 'expired' };
    case 'JustaPermissionManager_UnauthorizedPermission':
      return { reason: 'no-grant' };
  }
}

// The account wraps what its call reverted with, so the manager's error need not start the data.
function refusalWithin(blob: string): ManagerRefusal | undefined {
  const hex = blob.slice(2, 2 + MAX_SCAN).toLowerCase();
  for (const selector of SELECTORS) {
    for (let at = hex.indexOf(selector); at !== -1; at = hex.indexOf(selector, at + 1)) {
      if (at % 2 !== 0) continue;
      const refused = refusalOf(`0x${hex.slice(at)}`);
      if (refused) return refused;
    }
  }
  return undefined;
}

function chainOf(failure: unknown): object[] {
  const errors: object[] = [];
  for (let at = failure; at && typeof at === 'object' && !errors.includes(at); at = (at as { cause?: unknown }).cause) {
    errors.push(at);
  }
  return errors;
}

function revertDataOf(e: object): Hex | undefined {
  const { data } = e as { data?: unknown };
  const blob = typeof data === 'string' ? data : (data as { revertData?: unknown } | undefined)?.revertData;
  return typeof blob === 'string' && isHex(blob) ? blob : undefined;
}

/**
 * Anything thrown before the userOp is built does not have viem's UserOperationExecutionError on
 * top. viem throws that same error from the last estimate and from eth_sendUserOperation, so past
 * that point only a simulated revert, the bundler's -32521, proves nothing went out.
 */
export function mayHaveBeenSent(failure: unknown): boolean {
  const errors = chainOf(failure);
  if ((errors[0] as { name?: string } | undefined)?.name !== 'UserOperationExecutionError') return false;
  return !refusedInSimulation(failure);
}

/** The bundler's -32521: it simulated the userOp, saw it revert, and kept nothing. */
export function refusedInSimulation(failure: unknown): boolean {
  return chainOf(failure).some((e) => (e as { code?: unknown }).code === -32521);
}

export function refusalOfFailure(failure: unknown): ManagerRefusal | undefined {
  for (const e of chainOf(failure)) {
    const data = revertDataOf(e);
    const refused = data && refusalWithin(data);
    if (refused) return refused;
  }
  return undefined;
}

/** The refusal named by the revert reason the EntryPoint logged for this userOp; its bundle may hold others. */
export function refusalOfLogs(
  logs: { address: Address; data: Hex; topics: Hex[] }[],
  userOpHash: Hex
): ManagerRefusal | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== entryPoint08Address.toLowerCase()) continue;
    let args: { userOpHash: Hex; revertReason: Hex };
    try {
      const event = decodeEventLog({ abi: entryPoint08Abi, eventName: 'UserOperationRevertReason', ...log } as never);
      args = event.args as typeof args;
    } catch {
      continue;
    }
    if (args.userOpHash.toLowerCase() !== userOpHash.toLowerCase()) continue;
    const refused = refusalWithin(args.revertReason);
    if (refused) return refused;
  }
  return undefined;
}
