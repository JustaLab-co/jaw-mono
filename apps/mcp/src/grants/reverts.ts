import { decodeErrorResult, decodeEventLog, isHex, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import type { Refusal } from './fit';

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

function refusalOf(data: Hex): Refusal | undefined {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: MANAGER_ERRORS, data });
  } catch {
    return undefined;
  }
  switch (decoded.errorName) {
    case 'JustaPermissionManager_UnauthorizedCall':
    case 'JustaPermissionManager_CheckerRejectedCall':
      return { reason: 'call-not-allowed', target: decoded.args[0], selector: decoded.args[1] };
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
function refusalWithin(blob: string): Refusal | undefined {
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
  return !errors.some((e) => (e as { code?: unknown }).code === -32521);
}

export function refusalOfFailure(failure: unknown): Refusal | undefined {
  for (const e of chainOf(failure)) {
    const data = revertDataOf(e);
    const refused = data && refusalWithin(data);
    if (refused) return refused;
  }
  return undefined;
}

/** The refusal named by the revert reason the EntryPoint logged for a userOp that reverted. */
export function refusalOfLogs(logs: { data: Hex; topics: Hex[] }[]): Refusal | undefined {
  for (const log of logs) {
    let reason: Hex;
    try {
      const event = decodeEventLog({ abi: entryPoint08Abi, eventName: 'UserOperationRevertReason', ...log } as never);
      reason = (event.args as { revertReason: Hex }).revertReason;
    } catch {
      continue;
    }
    const refused = refusalWithin(reason);
    if (refused) return refused;
  }
  return undefined;
}
