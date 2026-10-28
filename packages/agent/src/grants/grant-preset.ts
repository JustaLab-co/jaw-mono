import { parseUnits } from 'viem';
import { USDC_BY_NETWORK } from '../x402/asset-registry.js';
import type { PermissionsConfig } from './permissions-config.js';

/**
 * Build the permission an x402 payer actually needs, so nobody has to hand-write
 * it.
 *
 * Paying an x402 challenge, and refilling the payer through the permission when
 * it falls short, only ever needs one thing: a USDC `transfer` on the session's
 * chain, capped per period. Spelling that out by hand means knowing the USDC
 * address for your chain and the exact `transfer(address,uint256)` signature,
 * which is a lot to ask before a first payment. The registry already knows the
 * address and the decimals, so derive it.
 */

const TRANSFER_SIGNATURE = 'transfer(address,uint256)';

/** SpendLimit.allowance is uint160 in JustaPermissionManager. */
const MAX_ALLOWANCE = 2n ** 160n - 1n;

/** Spend periods accepted on a limit, matching the units the grant validator takes. */
export const LIMIT_PERIODS = ['minute', 'hour', 'day', 'week', 'month', 'year', 'forever'] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

/** Applied when `--x402` is given with no explicit limit. Matches the default x402 session cap. */
export const DEFAULT_X402_LIMIT = '10/day';

export interface ParsedLimit {
  /** Human amount as written, e.g. "10" or "2.5". */
  amount: string;
  period: LimitPeriod;
}

/**
 * Parse a `<amount>[/<period>]` limit, e.g. `10/day`, `2.5/week`, or a bare `10`
 * which means per day. The amount stays a decimal string here; scaling to base
 * units needs the token's decimals and happens in `buildX402Permissions`.
 */
export function parseLimit(input: string): ParsedLimit {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Limit is empty. Use --limit <amount>/<period>, for example 10/day.');

  const [rawAmount, rawPeriod = 'day', ...rest] = trimmed.split('/');
  if (rest.length > 0) {
    throw new Error(`Invalid limit "${input}". Expected <amount>/<period>, for example 10/day.`);
  }

  const amount = rawAmount.trim();
  // Reject exponent and sign forms up front: parseUnits would either throw a
  // less helpful error or silently accept something the user did not mean.
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid limit amount "${rawAmount}". Expected a positive number, for example 10 or 2.5.`);
  }

  const period = rawPeriod.trim().toLowerCase() as LimitPeriod;
  if (!(LIMIT_PERIODS as readonly string[]).includes(period)) {
    throw new Error(`Invalid limit period "${rawPeriod}". Expected one of: ${LIMIT_PERIODS.join(', ')}.`);
  }

  return { amount, period };
}

/**
 * The USDC-transfer permission for `chainId`, capped at `limit` per period.
 * Throws when the chain has no USDC in the registry, since there is nothing
 * meaningful to grant for x402 there.
 */
export function buildX402Permissions(chainId: number, limit: string = DEFAULT_X402_LIMIT): PermissionsConfig {
  const usdc = Object.values(USDC_BY_NETWORK).find((asset) => asset.chainId === chainId);
  if (!usdc) {
    const supported = Object.values(USDC_BY_NETWORK)
      .map((a) => a.chainId)
      .sort((a, b) => a - b)
      .join(', ');
    throw new Error(`No USDC configured for chain ${chainId}. x402 payments are supported on: ${supported}.`);
  }

  const { amount, period } = parseLimit(limit);
  let allowance: bigint;
  try {
    allowance = parseUnits(amount, usdc.decimals);
  } catch {
    throw new Error(`Invalid limit amount "${amount}" for a token with ${usdc.decimals} decimals.`);
  }
  if (allowance <= 0n) {
    throw new Error(`Limit "${limit}" resolves to zero, which would refuse every payment.`);
  }
  // SpendLimit.allowance is a uint160 on chain. Past that the grant fails deep
  // in ABI encoding with an opaque range error, so refuse here where the number
  // the user typed is still in hand.
  if (allowance > MAX_ALLOWANCE) {
    throw new Error(`Limit "${limit}" is larger than a spend allowance can hold (max ${MAX_ALLOWANCE}).`);
  }

  return {
    calls: [{ target: usdc.address, functionSignature: TRANSFER_SIGNATURE }],
    spends: [{ token: usdc.address, allowance: allowance.toString(), unit: period, multiplier: 1 }],
  };
}

/** One-line summary of what an --x402 grant permits, for the setup output. */
export function describeX402Grant(limit: string = DEFAULT_X402_LIMIT): string {
  const { amount, period } = parseLimit(limit);
  const per = period === 'forever' ? 'in total' : `per ${period}`;
  return `${amount} USDC ${per}, transfers only`;
}
