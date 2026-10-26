import type { Address, Hex } from 'viem';
import { z } from 'zod';
import type { SwapCall } from './check';
import type { SwapRow } from './store';

export const CALL_INVALID = 'call_invalid';

const pattern = <T extends string>(re: RegExp) => z.custom<T>((v) => typeof v === 'string' && re.test(v));
const fields = {
  chainId: z.number().int().positive(),
  to: pattern<Address>(/^0x[0-9a-fA-F]{40}$/),
  data: pattern<Hex>(/^0x([0-9a-fA-F]{2})*$/),
  value: pattern<string>(/^(0|[1-9][0-9]*)$/),
};
const approveCall = z.strictObject({
  kind: z.literal('approve'),
  ...fields,
  data: pattern<Hex>(/^0x095ea7b3[0-9a-fA-F]{128}$/),
  value: z.literal('0'),
});
const depositCall = z.strictObject({ kind: z.literal('deposit'), ...fields });
const legacyCall = z.strictObject(fields).transform((call) => [{ kind: 'deposit' as const, ...call }]);
const stored = z.union([legacyCall, z.tuple([depositCall]), z.tuple([approveCall, depositCall])]);

export function parseCalls(value: unknown): SwapCall[] | undefined {
  const calls = stored.safeParse(value).data;
  if (!calls) return undefined;
  if (!calls.every((c) => c.chainId === calls[0].chainId)) return undefined;
  return calls;
}

export const callsOf = (row: Pick<SwapRow, 'call'>) => parseCalls(row.call);
