import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  HttpRequestError,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { describe, expect, it } from 'vitest';
import { lostInTransit, refusalOfFailure, refusalOfLogs } from './reverts';

const CAROL: Address = '0x3333333333333333333333333333333333333333';
const TRANSFER = toFunctionSelector('transfer(address,uint256)');

const MANAGER_ERRORS = parseAbi([
  'error JustaPermissionManager_UnauthorizedCall(address target, bytes4 selector)',
  'error JustaPermissionManager_ExceededSpendLimit(uint256 value, uint256 allowance)',
  'error JustaPermissionManager_AfterPermissionEnd(uint48 currentTimestamp, uint48 end)',
]);
const overLimit = encodeErrorResult({
  abi: MANAGER_ERRORS,
  errorName: 'JustaPermissionManager_ExceededSpendLimit',
  args: [2_000_000n, 1_000_000n],
});

describe('refusalOfFailure', () => {
  it('names an ExceededSpendLimit in the revert data a simulation failed with as over-limit', () => {
    const err = new Error('Could not size the ERC-20 paymaster approval', {
      cause: { name: 'RpcRequestError', details: `UserOperation reverted during simulation with reason: ${overLimit}` },
    });
    expect(refusalOfFailure(err)).toEqual({ reason: 'over-limit', onChain: true });
  });

  it('names an UnauthorizedCall wrapped in a revert of the account as call-not-allowed', () => {
    const inner = encodeErrorResult({
      abi: MANAGER_ERRORS,
      errorName: 'JustaPermissionManager_UnauthorizedCall',
      args: [CAROL, TRANSFER],
    });
    const wrapped = encodeErrorResult({
      abi: parseAbi(['error ExecutionFailed(bytes reason)']),
      errorName: 'ExecutionFailed',
      args: [inner],
    });
    expect(refusalOfFailure({ data: { revertData: wrapped } })).toEqual({
      reason: 'call-not-allowed',
      target: CAROL,
      selector: TRANSFER,
    });
  });

  it('names an AfterPermissionEnd as expired', () => {
    const data = encodeErrorResult({
      abi: MANAGER_ERRORS,
      errorName: 'JustaPermissionManager_AfterPermissionEnd',
      args: [1_800_000_000, 1_799_999_999],
    });
    expect(refusalOfFailure({ details: `execution reverted: ${data}` })).toEqual({ reason: 'expired' });
  });

  it('never reads a message, which can quote the calldata the agent chose', () => {
    expect(refusalOfFailure(new Error(`Request body: {"callData":"${overLimit}"}`))).toBe(undefined);
  });

  it('names nothing in revert data that carries no manager error', () => {
    expect(refusalOfFailure({ details: "AA21 didn't pay prefund 0xdeadbeefcafe" })).toBe(undefined);
  });
});

describe('lostInTransit', () => {
  it('tells a lost answer from a refusal the bundler sent back', () => {
    const lost = new Error('send failed', { cause: new HttpRequestError({ url: 'http://bundler.test' }) });
    expect(lostInTransit(lost)).toBe(true);
    expect(lostInTransit(new Error('send failed', { cause: { name: 'RpcRequestError' } }))).toBe(false);
  });
});

describe('refusalOfLogs', () => {
  it('names the revert reason the EntryPoint logged for the userOp, and nothing in other logs', () => {
    const userOpHash: Hex = `0x${'1'.repeat(64)}`;
    const topics = encodeEventTopics({
      abi: entryPoint08Abi,
      eventName: 'UserOperationRevertReason',
      args: { userOpHash, sender: CAROL },
    }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, overLimit]);
    expect(refusalOfLogs([{ topics, data }])).toEqual({ reason: 'over-limit', onChain: true });
    expect(refusalOfLogs([{ topics: [], data: overLimit }])).toBe(undefined);
  });
});
