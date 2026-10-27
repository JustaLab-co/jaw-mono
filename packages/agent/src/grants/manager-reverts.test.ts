import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  HttpRequestError,
  parseAbi,
  RpcRequestError,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { entryPoint08Abi, entryPoint08Address, getUserOperationError } from 'viem/account-abstraction';
import { describe, expect, it } from 'vitest';
import { mayHaveBeenSent, refusalOfFailure, refusalOfLogs } from './manager-reverts.js';

const CAROL: Address = '0x3333333333333333333333333333333333333333';
const TRANSFER = toFunctionSelector('transfer(address,uint256)');

const MANAGER_ERRORS = parseAbi([
  'error JustaPermissionManager_UnauthorizedCall(address target, bytes4 selector)',
  'error JustaPermissionManager_CheckerRejectedCall(address target, bytes4 selector, address checker)',
  'error JustaPermissionManager_ExceededSpendLimit(uint256 value, uint256 allowance)',
  'error JustaPermissionManager_AfterPermissionEnd(uint48 currentTimestamp, uint48 end)',
]);
const overLimit = encodeErrorResult({
  abi: MANAGER_ERRORS,
  errorName: 'JustaPermissionManager_ExceededSpendLimit',
  args: [2_000_000n, 1_000_000n],
});

const rpcError = (error: { code: number; message: string; data?: unknown }) =>
  new RpcRequestError({ body: {}, error, url: 'http://bundler.test' });
const bundlerAnswered = (cause: Error) =>
  getUserOperationError(
    cause as never,
    {
      sender: CAROL,
      nonce: 0n,
      callData: '0x',
      signature: '0x',
    } as never
  );

describe('refusalOfFailure', () => {
  it('names an ExceededSpendLimit in the revert data a simulation failed with as over-limit', () => {
    const err = new Error('Could not size the ERC-20 paymaster approval', {
      cause: rpcError({ code: -32521, message: 'execution reverted', data: overLimit }),
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

  // The call is allowed by its rule; the checker on that rule refused its arguments. The agent can
  // fix the call, not the grant, so the two are told apart.
  it('names a CheckerRejectedCall as checker-rejected, naming the checker', () => {
    const checker: Address = '0x398b9d939E7E616E03eA99601c835C920621B2ca';
    const data = encodeErrorResult({
      abi: MANAGER_ERRORS,
      errorName: 'JustaPermissionManager_CheckerRejectedCall',
      args: [CAROL, TRANSFER, checker],
    });
    expect(refusalOfFailure({ data: { revertData: data } })).toEqual({
      reason: 'checker-rejected',
      target: CAROL,
      selector: TRANSFER,
      checker,
    });
  });

  it('names an AfterPermissionEnd as expired', () => {
    const data = encodeErrorResult({
      abi: MANAGER_ERRORS,
      errorName: 'JustaPermissionManager_AfterPermissionEnd',
      args: [1_800_000_000, 1_799_999_999],
    });
    expect(refusalOfFailure(rpcError({ code: -32521, message: 'execution reverted', data }))).toEqual({
      reason: 'expired',
    });
  });

  it('never reads the bundler message viem keeps as details, even when it reads like a manager error', () => {
    const err = rpcError({
      code: -32500,
      message: `UserOperation reverted during simulation with reason: ${overLimit}`,
    });
    expect(refusalOfFailure(bundlerAnswered(err))).toBe(undefined);
  });

  it('never reads a message, which can quote the calldata the agent chose', () => {
    expect(refusalOfFailure(new Error(`Request body: {"callData":"${overLimit}"}`))).toBe(undefined);
  });

  it('names nothing in revert data that carries no manager error', () => {
    expect(refusalOfFailure({ data: '0xdeadbeefcafe' })).toBe(undefined);
  });
});

describe('mayHaveBeenSent', () => {
  it('counts any bundler answer to the userOp as maybe sent, unless its estimate reverted', () => {
    expect(mayHaveBeenSent(bundlerAnswered(rpcError({ code: -32602, message: 'already known' })))).toBe(true);
    expect(mayHaveBeenSent(bundlerAnswered(rpcError({ code: -32500, message: 'AA25 invalid account nonce' })))).toBe(
      true
    );
    const reverted = rpcError({ code: -32521, message: 'execution reverted', data: overLimit });
    expect(mayHaveBeenSent(bundlerAnswered(reverted))).toBe(false);
    expect(mayHaveBeenSent(bundlerAnswered(rpcError({ code: -32521, message: 'execution reverted' })))).toBe(false);
    const hexOnRefusal = rpcError({ code: -32500, message: 'AA25 invalid account nonce', data: '0xdeadbeef' });
    expect(mayHaveBeenSent(bundlerAnswered(hexOnRefusal))).toBe(true);
  });

  it('counts a lost answer to the userOp as maybe sent, and any failure before the userOp existed as not', () => {
    const lost = new HttpRequestError({ url: 'http://bundler.test', status: 502 });
    expect(mayHaveBeenSent(bundlerAnswered(lost))).toBe(true);
    const sizing = (cause: Error) => new Error('Could not size the ERC-20 paymaster approval', { cause });
    const prefund = bundlerAnswered(rpcError({ code: -32500, message: 'AA21 did not pay prefund' }));
    expect(mayHaveBeenSent(sizing(prefund))).toBe(false);
    expect(mayHaveBeenSent(sizing(lost))).toBe(false);
    expect(mayHaveBeenSent(new Error('the permission store did not answer', { cause: lost }))).toBe(false);
  });
});

describe('refusalOfLogs', () => {
  const OURS: Hex = `0x${'1'.repeat(64)}`;
  const THEIRS: Hex = `0x${'2'.repeat(64)}`;
  const revertLog = (userOpHash: Hex, reason: Hex, address: Address = entryPoint08Address) => ({
    address,
    topics: encodeEventTopics({
      abi: entryPoint08Abi,
      eventName: 'UserOperationRevertReason',
      args: { userOpHash, sender: CAROL },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, reason]),
  });
  const callNotAllowed = encodeErrorResult({
    abi: MANAGER_ERRORS,
    errorName: 'JustaPermissionManager_UnauthorizedCall',
    args: [CAROL, TRANSFER],
  });

  it('names the revert reason the EntryPoint logged for the userOp, and nothing in other logs', () => {
    expect(refusalOfLogs([revertLog(OURS, overLimit)], OURS)).toEqual({ reason: 'over-limit', onChain: true });
    expect(refusalOfLogs([{ address: entryPoint08Address, topics: [], data: overLimit }], OURS)).toBe(undefined);
  });

  it('names only the revert logged for this userOp when the bundle holds another reverted userOp', () => {
    const bundle = [revertLog(THEIRS, overLimit), revertLog(OURS, callNotAllowed)];
    expect(refusalOfLogs(bundle, OURS)).toEqual({ reason: 'call-not-allowed', target: CAROL, selector: TRANSFER });
    expect(refusalOfLogs([revertLog(THEIRS, overLimit)], OURS)).toBe(undefined);
  });

  it('names nothing from a revert log for this userOp that the EntryPoint did not emit', () => {
    expect(refusalOfLogs([revertLog(OURS, overLimit, CAROL)], OURS)).toBe(undefined);
  });
});
