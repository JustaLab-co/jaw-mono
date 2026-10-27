import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';
import type { BridgeChain } from './contracts';
import { BridgeContracts } from './table';

const isChecksummed = (value: string): value is Address =>
  isAddress(value, { strict: false }) && getAddress(value) === value;

const isChainKey = (key: string) => {
  const id = Number(key);
  return Number.isSafeInteger(id) && id > 0 && String(id) === key;
};

const address = z.string().refine(isChecksummed, 'not a checksummed address');

const across = z.object({
  spokePool: address,
  periphery: address,
  multicallHandler: address,
  eventEmitter: address.optional(),
  wrappedNative: address.optional(),
  swapRouter: address.optional(),
  lifiDiamond: address.optional(),
});

const relay = z.object({
  depository: address,
  protocolChain: z.string().min(1),
  erc20Routers: z.array(address),
  solvers: z.array(address).min(1),
  testnet: z.literal(true).optional(),
});

const chain = z.object({
  name: z.string().min(1),
  nativeSymbol: z.string().min(1),
  across: across.optional(),
  relay: relay.optional(),
  tokens: z.record(address, z.object({ symbol: z.string().min(1), decimals: z.number().int().min(0).max(36) })),
});

const body = z.object({
  version: z.number().int().nonnegative(),
  chains: z
    .record(z.string().refine(isChainKey, 'not a chain id'), chain)
    .refine((chains) => Object.keys(chains).length > 0, 'no chains'),
});

export type ParseResult = { ok: true; contracts: BridgeContracts } | { ok: false; reason: string };

const failure = (reason: string): ParseResult => ({ ok: false, reason });

const hasDuplicate = (list: readonly string[]) => new Set(list.map((a) => a.toLowerCase())).size !== list.length;

function chainProblem({ across, relay }: BridgeChain): string | undefined {
  if (relay && hasDuplicate(relay.solvers)) return 'a Relay solver is listed twice';
  const roles = [
    ...Object.values(across ?? {}),
    ...(relay ? [relay.depository, ...relay.solvers, ...relay.erc20Routers] : []),
  ];
  if (hasDuplicate(roles)) return 'an address holds two roles';
  if (relay && relay.erc20Routers.length === 0 && !relay.testnet) return 'a Relay chain has no routers';
  return undefined;
}

export function parse(raw: unknown): ParseResult {
  const parsed = body.safeParse(raw);
  if (!parsed.success)
    return failure(`bad shape: ${parsed.error.issues[0].message} at ${parsed.error.issues[0].path.join('.')}`);

  const { version, chains } = parsed.data;
  const protocolChains: string[] = [];
  for (const [id, entry] of Object.entries(chains)) {
    const problem = chainProblem(entry);
    if (problem) return failure(`chain ${id}: ${problem}`);
    if (entry.relay) protocolChains.push(entry.relay.protocolChain);
  }
  if (new Set(protocolChains).size !== protocolChains.length) return failure('two chains share a protocolChain');

  return { ok: true, contracts: new BridgeContracts({ version, chains }) };
}
