import { parseAbi, zeroAddress, ContractFunctionRevertedError, BaseError } from 'viem';
import type { GrantedPermission, ChainClients } from '@jaw.id/agent';

/**
 * What the permission manager will say about a session's own permission.
 *
 * Everything the CLI knew about its permission came out of
 * `~/.jaw/session-config.json`, which is written once at setup and never
 * updated. A permission revoked from keys.jaw.id or from another machine, or an
 * allowance drawn down by something other than this CLI, leaves that file
 * saying what was true the day it was written. The chain knows, and the reads
 * are views.
 *
 * None of them take the permission id. `isApproved`, `isRevoked` and
 * `getCurrentPeriod` all take `Permission calldata` and hash it internally, so
 * the struct has to be rebuilt exactly as it was approved. That is what
 * `GrantedPermission` is for, and why `permissionHash` is checked against the
 * id the grant returned before any answer here is trusted.
 */

export const PERMISSION_MANAGER_ABI = parseAbi([
  'struct CallPermission { address target; bytes4 selector; address checker; }',
  'struct SpendLimit { address token; uint160 allowance; uint8 unit; uint16 multiplier; }',
  'struct Permission { address account; address spender; uint48 start; uint48 end; uint256 salt; CallPermission[] calls; SpendLimit[] spends; }',
  'struct PeriodSpend { uint48 start; uint48 end; uint160 spend; }',
  'function getHash(Permission permission) view returns (bytes32)',
  'function isApproved(Permission permission) view returns (bool)',
  'function isRevoked(Permission permission) view returns (bool)',
  'function getCurrentPeriod(Permission permission, SpendLimit spendLimit) view returns (PeriodSpend)',
  // Carried so the two time-bound reverts can be told apart from a node that
  // did not answer. Everything else the manager can revert with decodes to an
  // unnamed error, which is treated as unavailable rather than guessed at.
  'error JustaPermissionManager_BeforePermissionStart(uint48 currentTimestamp, uint48 start)',
  'error JustaPermissionManager_AfterPermissionEnd(uint48 currentTimestamp, uint48 end)',
]);

const TIME_BOUND_ERRORS = new Set([
  'JustaPermissionManager_BeforePermissionStart',
  'JustaPermissionManager_AfterPermissionEnd',
]);

/**
 * `PeriodUnit` in the contract, by declaration order. `year` is absent on
 * purpose: it has no on-chain unit, and the SDK rewrites it to `month` with the
 * multiplier times twelve before encoding. The struct has to be rebuilt with
 * the same rewrite or it hashes to a different permission.
 */
const PERIOD_UNIT_ENUM: Record<string, number> = {
  minute: 0,
  hour: 1,
  day: 2,
  week: 3,
  month: 4,
  forever: 5,
};

type ContractSpendLimit = {
  token: `0x${string}`;
  allowance: bigint;
  unit: number;
  multiplier: number;
};

type ContractPermission = {
  account: `0x${string}`;
  spender: `0x${string}`;
  start: number;
  end: number;
  salt: bigint;
  calls: ReadonlyArray<{ target: `0x${string}`; selector: `0x${string}`; checker: `0x${string}` }>;
  spends: ReadonlyArray<ContractSpendLimit>;
};

function toContractSpendLimit(spend: GrantedPermission['spends'][number]): ContractSpendLimit | null {
  const unit = spend.unit === 'year' ? 'month' : spend.unit;
  const multiplier = spend.unit === 'year' ? spend.multiplier * 12 : spend.multiplier;
  if (!Object.hasOwn(PERIOD_UNIT_ENUM, unit)) return null;
  return {
    token: spend.token as `0x${string}`,
    allowance: BigInt(spend.allowance),
    unit: PERIOD_UNIT_ENUM[unit],
    multiplier,
  };
}

/**
 * The stored permission in the shape the contract hashes, or null when it
 * cannot be rebuilt.
 *
 * `checker` is filled with the zero address because the grant response does not
 * carry one and `apiPermissionsToPermission` in the SDK always sets it that
 * way. The day a call checker is actually used that stops being true, and the
 * struct built here hashes to a permission that does not exist. Nothing here
 * can detect that on its own, which is why every caller goes through
 * `readPermissionState` and its hash check first.
 */
export function toContractPermission(permission: GrantedPermission): ContractPermission | null {
  const spends: ContractSpendLimit[] = [];
  for (const spend of permission.spends) {
    const converted = toContractSpendLimit(spend);
    if (!converted) return null;
    spends.push(converted);
  }
  let salt: bigint;
  try {
    salt = BigInt(permission.salt);
  } catch {
    return null;
  }
  return {
    account: permission.account as `0x${string}`,
    spender: permission.spender as `0x${string}`,
    start: permission.start,
    end: permission.end,
    salt,
    calls: permission.calls.map((call) => ({
      target: call.target as `0x${string}`,
      selector: call.selector as `0x${string}`,
      checker: zeroAddress,
    })),
    spends,
  };
}

/**
 * What the chain says about the permission, or why it could not say.
 *
 * `mismatch` is its own answer rather than an error: it means the struct on
 * disk does not hash to the id the grant returned, so every read made from it
 * would be about some other permission. Reporting that is more useful than
 * either a false "revoked" or silence.
 */
export type PermissionState =
  | { status: 'ok'; approved: boolean; revoked: boolean }
  | { status: 'mismatch' }
  | { status: 'unavailable' };

export interface PermissionReadTarget {
  chainId: number;
  permissionId: string;
  permission?: GrantedPermission;
}

type ReadContract = (args: {
  address: `0x${string}`;
  abi: typeof PERMISSION_MANAGER_ABI;
  functionName: 'getHash' | 'isApproved' | 'isRevoked' | 'getCurrentPeriod';
  args: readonly unknown[];
}) => Promise<unknown>;

/**
 * Where the reads go: the chain clients, or a `readContract` a test stands in
 * with to keep the network out of the unit tests.
 */
export type ReadDeps = ({ clients: ChainClients } | { readContract: ReadContract }) & {
  /** The permission manager, injectable so a test does not have to import core. */
  manager?: `0x${string}`;
  /**
   * How long to wait on the node.
   *
   * These reads sit in `session status` and `x402 status`, which were local
   * commands before them, and in the payment path. viem retries three times at
   * ten seconds, so an unreachable node would hold a status report open for
   * most of a minute to add a fact that is optional in every caller. Timing out
   * is the same answer as any other failed read: not knowing.
   */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;

/** Rejects the read once the node has had long enough. */
async function within<T>(work: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    });
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function managerAddress(override?: `0x${string}`): Promise<`0x${string}`> {
  if (override) return override;
  // Lazy, like every other core import in the CLI: a static one pulls the whole
  // SDK into startup for a command that may never read the chain.
  const { PERMISSIONS_MANAGER_ADDRESS } = await import('@jaw.id/core');
  return PERMISSIONS_MANAGER_ADDRESS as `0x${string}`;
}

/**
 * The read function for this chain, or null when there is none.
 *
 * The chain clients throw for a chain they have no viem entry for, and a session
 * can live on one: `session status` runs for any chain the account supports,
 * while the client here covers the four the USDC registry names. Null rather
 * than a throw, so a chain without a client reads as not knowing instead of
 * taking the command down.
 */
function reader(chainId: number, deps: ReadDeps): ReadContract | null {
  if ('readContract' in deps) return deps.readContract;
  try {
    const client = deps.clients.publicClient(chainId);
    return (args) => client.readContract(args as never) as Promise<unknown>;
  } catch {
    return null;
  }
}

/**
 * Ask the chain whether the permission is approved and whether it has been
 * revoked.
 *
 * Expiry is deliberately not asked for. The contract's `end` is the same number
 * already in the session config, so a read would only confirm what is on disk.
 * What no local file can know is that someone revoked from another device, and
 * that is the whole reason to make the call.
 */
export async function readPermissionState(target: PermissionReadTarget, deps: ReadDeps): Promise<PermissionState> {
  if (!target.permission) return { status: 'unavailable' };
  const permission = toContractPermission(target.permission);
  if (!permission) return { status: 'unavailable' };

  const read = reader(target.chainId, deps);
  if (!read) return { status: 'unavailable' };

  try {
    const address = await managerAddress(deps.manager);
    const [hash, approved, revoked] = await within(
      Promise.all([
        read({ address, abi: PERMISSION_MANAGER_ABI, functionName: 'getHash', args: [permission] }),
        read({ address, abi: PERMISSION_MANAGER_ABI, functionName: 'isApproved', args: [permission] }),
        read({ address, abi: PERMISSION_MANAGER_ABI, functionName: 'isRevoked', args: [permission] }),
      ]),
      deps.timeoutMs
    );
    if (typeof hash !== 'string' || hash.toLowerCase() !== target.permissionId.toLowerCase()) {
      return { status: 'mismatch' };
    }
    return { status: 'ok', approved: approved === true, revoked: revoked === true };
  } catch {
    // An unreachable node is not evidence about a permission. Callers report
    // that they could not tell, never that the session is dead.
    return { status: 'unavailable' };
  }
}

/**
 * What the on-chain allowance has actually lost this period.
 *
 * `outside-window` is the permission being expired or not yet started:
 * `getCurrentPeriod` runs the same time-bound check the spend path does and
 * reverts rather than answering zero, so the revert is the answer and not a
 * failure.
 */
export type OnChainPeriod =
  | { status: 'ok'; start: number; end: number; spend: bigint }
  | { status: 'outside-window' }
  | { status: 'unavailable' };

/** One limit's counter, tagged with the limit it belongs to. */
export interface OnChainLimit {
  token: string;
  unit: string;
  multiplier: number;
  allowance: string;
  period: OnChainPeriod;
}

/**
 * The current period for every spend limit the permission puts on `token`.
 *
 * All of them, because the contract charges all of them: the counter lives at
 * `_lastUpdatedPeriod[permissionHash][spendLimitHash]`, so a permission with
 * several limits on one token has several counters and reading one answers
 * about one budget. Issued together and awaited as one, so N limits cost the
 * latency of one rather than N; the client does not batch them into a single
 * request, so it is still N+1 calls on the wire.
 *
 * The hash is checked alongside them. `getCurrentPeriod` does not require the
 * permission to exist: handed a struct that hashes to something else it answers
 * about that other hash, as a zeroed counter over a window built from the
 * on-disk start.
 */
export async function readCurrentPeriods(
  target: PermissionReadTarget & { token: string },
  deps: ReadDeps
): Promise<OnChainLimit[]> {
  if (!target.permission) return [];
  const permission = toContractPermission(target.permission);
  if (!permission) return [];

  const granted = target.permission.spends;
  const indexes = granted
    .map((spend, index) => ({ spend, index }))
    .filter(({ spend }) => spend.token.toLowerCase() === target.token.toLowerCase());
  if (indexes.length === 0) return [];

  const unreadable = indexes.map(({ spend }) => ({ ...spend, period: { status: 'unavailable' as const } }));

  const read = reader(target.chainId, deps);
  if (!read) return unreadable;

  try {
    const address = await managerAddress(deps.manager);
    const settled = await within(
      Promise.allSettled([
        read({ address, abi: PERMISSION_MANAGER_ABI, functionName: 'getHash', args: [permission] }),
        ...indexes.map(({ index }) =>
          read({
            address,
            abi: PERMISSION_MANAGER_ABI,
            functionName: 'getCurrentPeriod',
            args: [permission, permission.spends[index]],
          })
        ),
      ]),
      deps.timeoutMs
    );

    const [hashed, ...counters] = settled;
    const hash = hashed.status === 'fulfilled' ? hashed.value : null;
    if (typeof hash !== 'string' || hash.toLowerCase() !== target.permissionId.toLowerCase()) {
      return unreadable;
    }

    return indexes.map(({ spend }, i) => {
      const result = counters[i];
      if (result.status === 'rejected') {
        return {
          ...spend,
          period: isTimeBoundRevert(result.reason)
            ? ({ status: 'outside-window' } as const)
            : ({ status: 'unavailable' } as const),
        };
      }
      const period = result.value as { start: number; end: number; spend: bigint } | undefined;
      return {
        ...spend,
        period: period
          ? ({
              status: 'ok',
              start: Number(period.start),
              end: Number(period.end),
              spend: BigInt(period.spend),
            } as const)
          : ({ status: 'unavailable' } as const),
      };
    });
  } catch {
    return unreadable;
  }
}

/** Whether a failed read was the contract refusing on time bounds rather than a node not answering. */
function isTimeBoundRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError && TIME_BOUND_ERRORS.has(revert.data?.errorName ?? '');
}

/**
 * What the chain says about a session's permission, flattened to one word.
 *
 * `unknown` covers every way of not knowing, which callers treat alike: a node
 * that did not answer, a chain with no client, a session written before the
 * struct was stored, and a struct that cannot be rebuilt. None of them are
 * evidence about a permission, so none of them may read as dead.
 */
export type PermissionLiveness = 'active' | 'revoked' | 'unapproved' | 'mismatch' | 'unknown';

/** `readPermissionState` for the three status surfaces, which all want the one word. */
export async function readLiveness(session: PermissionReadTarget, deps: ReadDeps): Promise<PermissionLiveness> {
  const state = await readPermissionState(session, deps);
  if (state.status === 'unavailable') return 'unknown';
  if (state.status === 'mismatch') return 'mismatch';
  if (state.revoked) return 'revoked';
  return state.approved ? 'active' : 'unapproved';
}
