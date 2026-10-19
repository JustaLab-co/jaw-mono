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
import { entryPoint08Abi, getUserOperationError } from 'viem/account-abstraction';
import { describe, expect, it } from 'vitest';
import { mayHaveBeenSent, refusalOfFailure, refusalOfLogs } from './reverts';

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
