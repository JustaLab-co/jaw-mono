import { ANY_FN_SEL, ANY_TARGET, EMPTY_CALLDATA_FN_SEL } from '@jaw.id/core';
import { usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { isAddress, numberToHex, parseUnits, toFunctionSelector, type Address } from 'viem';
import { z } from 'zod';
import { chainClients } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { revokeReplaced, sessionSender, type DisconnectDeps } from '@/connections/disconnect';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { ownerRelay, type OpenWallet } from '@/connections/relay';
import { spends } from '@/connections/scopes';
import { SPEND_UNITS } from '@/db/schema';
import { budgetGrant, readOnChain, type GrantRequest, type ReadPermission } from '@/grants/permission';
import {
  followUps,
  lostBefore,
  lostLinkSaid,
  openLink,
  RECONNECTING,
  reconnecting,
  type PermissionRequestRow,
} from '@/grants/requests';
import { grantWork, type GrantPayload } from '@/grants/resume';
import {
  grantsBeside,
  liveGrants,
  LIVE_GRANTS_PER_CONNECTION,
  x402Budget,
  type GrantKind,
  type LiveGrant,
} from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { expiresIn, formatAmount, nativeSymbol, onDate, withinWindow } from '@/lib/owner-text';
import { forbiddenTargets } from './owner-calls';
import { ACCOUNT_BUSY, NO_PAY_SCOPE, refusal, withNext } from './reply';

const MAX_ENTRIES = 10;

const WILDCARD_SELECTORS = new Set<string>([ANY_FN_SEL, EMPTY_CALLDATA_FN_SEL]);

const address = z.string().refine((a) => isAddress(a, { strict: false }), 'must be a 0x address');
const signature = z
  .string()
  .max(256)
  .refine((s) => {
    try {
      toFunctionSelector(s);
      return true;
    } catch {
      return false;
    }
  }, 'must be a function signature such as "transfer(address,uint256)"');

const grantInput = z.strictObject({
  x402Budget: z
    .strictObject({
      perDay: z
        .string()
        .regex(/^\d{1,9}(\.\d{1,6})?$/)
        .describe('USDC per day, as a decimal such as "1" or "0.5"'),
    })
    .optional()
    .describe('The spend limit for paid services: a daily USDC limit that payments, refills and swap quotes draw from'),
  calls: z
    .array(z.strictObject({ target: address, functionSignature: signature }))
    .min(1)
    .max(MAX_ENTRIES)
    .optional()
    .describe('The contract functions this connection may call, each a target and a function signature'),
  spends: z
    .array(
      z
        .strictObject({
          token: address,
          allowance: z
            .string()
            .regex(/^[1-9]\d{0,48}$/)
            .refine((a) => BigInt(a) < 2n ** 160n, 'must fit the 160 bits a spend limit holds')
            .describe('Base units of the token per period, as a decimal integer'),
          unit: z.enum(SPEND_UNITS),
          multiplier: z.number().int().min(1).max(65535).default(1).describe('Periods per limit, default 1'),
        })
        .refine(
          (s) => s.unit !== 'year' || s.multiplier <= 5461,
          'a yearly limit is held as months, so its multiplier is at most 5461'
        )
    )
    .max(MAX_ENTRIES)
    .optional()
    .describe('How much of each token this connection may move per period'),
  expiresAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When the permission ends; the connection's own end when absent or later"),
});
export type GrantInput = z.input<typeof grantInput>;

interface GrantDeps {
  openWallet: OpenWallet;
  readPermission: ReadPermission;
  /** What revokes replaced budgets as spender. */
  session: Pick<DisconnectDeps, 'clients' | 'sender' | 'lockWaitMs'>;
}

const DEFAULTS: GrantDeps = {
  openWallet: ownerRelay,
  readPermission: readOnChain,
  session: { clients: chainClients, sender: sessionSender },
};

const output = z.object({ url: z.url(), expiresAt: z.string(), summary: z.string() });

interface Asked {
  kind: GrantKind;
  grant: GrantRequest;
  what: string;
}

// ERC-7528, how the permission manager names the chain's own coin.
const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * An amount of a token as the owner reads it: with its decimals and symbol for the chain's own coin and USDC, which
 * this server knows. Any other token stays exact, in its smallest unit, named by its address.
 */
export function tokenAmount(chainId: number, token: string, amount: bigint | string): string {
  if (token.toLowerCase() === NATIVE_TOKEN) return formatAmount(amount, 18, nativeSymbol(chainId));
  const usdc = usdcForNetwork(`eip155:${chainId}`);
  if (usdc && token.toLowerCase() === usdc.address.toLowerCase()) return formatAmount(amount, usdc.decimals, 'USDC');
  return `${BigInt(amount)} smallest units of the token at ${token}`;
}

const ONE_UNIT: Record<string, string> = {
  minute: 'a minute',
  hour: 'an hour',
  day: 'a day',
  week: 'a week',
  month: 'a month',
  year: 'a year',
};

/** A limit's period as the owner reads it: "a day", "every 2 months", "in total". */
const perPeriod = (unit: string, multiplier: number) =>
  unit === 'forever'
    ? 'in total'
    : multiplier === 1
      ? (ONE_UNIT[unit] ?? `per ${unit}`)
      : `every ${multiplier} ${unit}s`;

/** "a", "a and b", "a, b and c". */
export const listed = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

type SpendLimit = { token: string; allowance: string | bigint; unit: string; multiplier?: number };

/** What spend limits let move, summed per token and period: "1 USDC a day", "0.50 ETH a week". */
export function spendLimits(chainId: number, limits: readonly SpendLimit[]): string[] {
  const sums = new Map<string, { token: string; per: string; amount: bigint }>();
  for (const { token, unit, multiplier = 1, allowance } of limits) {
    const per = perPeriod(unit, multiplier);
    const key = `${token.toLowerCase()}:${per}`;
    const sum = sums.get(key) ?? { token, per, amount: 0n };
    sums.set(key, { ...sum, amount: sum.amount + BigInt(allowance) });
  }
  return [...sums.values()].map(({ token, per, amount }) => `${tokenAmount(chainId, token, amount)} ${per}`);
}

const NOTHING_ASKED = 'Nothing was asked.';

function asked(t: Tenant, input: GrantInput, expiry: number): Asked | string {
  if (input.x402Budget) {
    const usdc = usdcForNetwork(`eip155:${t.chainId}`);
    if (!usdc) return "USDC is not supported on this connection's chain.";
    const allowance = parseUnits(input.x402Budget.perDay, usdc.decimals);
    if (allowance === 0n) return `A spend limit of zero would refuse every payment. ${NOTHING_ASKED}`;
    const grant = budgetGrant({
      chainId: t.chainId,
      spender: t.sessionAddress,
      token: usdc.address,
      allowance,
      expiry,
    });
    const perDay = formatAmount(allowance, usdc.decimals, 'USDC');
    return { kind: 'x402-budget', grant, what: `a spend limit of ${perDay} a day for paid services` };
  }
  if (!input.calls) {
    return withNext(
      `The request names no permission to ask for. ${NOTHING_ASKED}`,
      'Pass x402Budget for a spend limit for paid services, or calls (and any spends) for a custom permission.'
    );
  }
  const forbidden = forbiddenTargets(t).add(ANY_TARGET.toLowerCase());
  const refused = input.calls.find((c) => forbidden.has(c.target.toLowerCase()));
  if (refused) {
    return withNext(
      `call_target_refused: A permission can never cover ${refused.target}: the wallet itself and the contracts that guard it are always off limits. ${NOTHING_ASKED}`,
      'The account itself, the permission manager, the EntryPoint contracts and the any-contract wildcard cannot be granted.'
    );
  }
  const wildcard = input.calls.find((c) => WILDCARD_SELECTORS.has(toFunctionSelector(c.functionSignature)));
  if (wildcard) {
    return withNext(
      `call_selector_refused: One of the actions asked for would read as any action on that contract, so it cannot be allowed. ${NOTHING_ASKED}`,
      `${wildcard.functionSignature} hashes to a selector the permission manager reads as any function (or an empty call), so it cannot be granted.`
    );
  }
  const calls = input.calls.map((c) => ({ target: c.target as Address, functionSignature: c.functionSignature }));
  const spent = (input.spends ?? []).map((s) => ({ ...s, token: s.token as Address, multiplier: s.multiplier ?? 1 }));
  const grant: GrantRequest = {
    spender: t.sessionAddress,
    expiry,
    chainId: numberToHex(t.chainId),
    permissions: { calls, spends: spent },
  };
  const targets = [...new Map(calls.map((c) => [c.target.toLowerCase(), c.target])).values()];
  const on = targets.length === 1 ? targets[0] : `${targets.length} contracts (${listed(targets)})`;
  const actions = `${calls.length} allowed action${calls.length === 1 ? '' : 's'} on ${on}`;
  const limits = spendLimits(t.chainId, spent);
  return { kind: 'custom', grant, what: limits.length ? `${actions} with a limit of ${listed(limits)}` : actions };
}

/** Revokes the budgets a newer one replaced. One left approved stays replaced, so nothing pays from it. */
async function revokeOlder(t: Tenant, deps: GrantDeps) {
  const outcome = await revokeReplaced(t, { readPermission: deps.readPermission, ...deps.session }).catch(errorLabel);
  if (typeof outcome === 'string') log('warn', { msg: 'replaced budget not revoked', error: outcome });
  else if (outcome.stillApproved.length || outcome.unread.length) {
    log('warn', { msg: 'replaced budget not revoked', error: [...outcome.stillApproved, ...outcome.unread].join(',') });
  }
}

/** For the agent: what the connection's earlier permissions let it move, summed per token and period. */
function earlier(t: Tenant, held: LiveGrant[]): string {
  if (!held.length) return '';
  const limits = spendLimits(
    t.chainId,
    held.flatMap((g) => g.permission.spends)
  );
  if (held.length === 1) {
    const moves = limits.length
      ? `it lets this connection move up to ${listed(limits)}`
      : 'it lets this connection move no tokens';
    return `The earlier permission on this connection stays in force until it expires or is revoked; ${moves}.`;
  }
  const moves = limits.length
    ? `together they let this connection move up to ${listed(limits)}`
    : 'none of them lets this connection move tokens';
  return `The ${held.length} earlier permissions on this connection stay in force until they expire or are revoked; ${moves}.`;
}

/** The owner's line about a link this server lost after asking, and what the agent should know about it. */
const lostLink = (lost: PermissionRequestRow) => {
  const said = lostLinkSaid(lost, 'permission');
  return {
    say: said.say,
    next: `${said.next} A permission approved on the earlier link can go live on chain without this server recording it, and then only jaw_revoke_permission with its id from the wallet ends it.`,
  };
};

const lines = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join('\n');
const sentences = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

export async function grantPermissions(t: Tenant, input: GrantInput, deps = DEFAULTS) {
  if (input.x402Budget && (input.calls || input.spends || input.expiresAt)) {
    return refusal(
      withNext(
        `A spend limit for paid services is asked for on its own. ${NOTHING_ASKED}`,
        'x402Budget is a preset: pass it alone, or pass calls and spends without it.'
      )
    );
  }
  const requested = input.expiresAt ? new Date(input.expiresAt) : t.expiresAt;
  if (requested.getTime() <= Date.now()) {
    return refusal(
      withNext(
        `expiry_in_past: The end date asked for has already passed. ${NOTHING_ASKED}`,
        `The expiry ${requested.toISOString()} has already passed. Ask for a later one.`
      )
    );
  }
  const until = new Date(Date.now() + APPROVE_WITHIN_MS);
  const expiresAt = requested < t.expiresAt ? requested : t.expiresAt;
  if (expiresAt <= until) {
    return refusal(
      withNext(
        `expiry_too_soon: The permission would end before the owner's ${APPROVE_WITHIN_MS / 60_000} minutes to approve it are up. ${NOTHING_ASKED}`,
        `It would end at ${expiresAt.toISOString()}. Ask for a later expiresAt.`
      )
    );
  }
  const ask = asked(t, input, Math.floor(expiresAt.getTime() / 1000));
  if (typeof ask === 'string') return refusal(ask);
  if ((await grantsBeside(t.connectionId, ask.kind)) >= LIVE_GRANTS_PER_CONNECTION) await revokeOlder(t, deps);
  if ((await grantsBeside(t.connectionId, ask.kind)) >= LIVE_GRANTS_PER_CONNECTION) {
    return refusal(
      withNext(
        `This connection already holds ${LIVE_GRANTS_PER_CONNECTION} permissions, the most it can. ${NOTHING_ASKED}`,
        'Revoke one the owner no longer needs (jaw_connections lists them, jaw_revoke_permission revokes one), or wait for one to expire.'
      )
    );
  }
  const held = await liveGrants(t.connectionId);
  const replacing = ask.kind === 'x402-budget' && (await x402Budget(t.connectionId)) !== undefined;
  const payload: GrantPayload = { kind: ask.kind, grant: ask.grant };
  const opened = await openLink(
    t,
    {
      method: 'grant',
      chainId: t.chainId,
      approveBy: until,
      payload,
      rebuild: grantWork(deps.readPermission),
      settled: async ({ state }) => {
        if (state === 'approved') await revokeOlder(t, deps);
      },
    },
    deps.openWallet
  );
  if (opened === 'wallet_busy') return refusal('Too many owners are approving right now. Try again in a minute.');
  if (opened === 'account_busy') return refusal(ACCOUNT_BUSY);
  const row = 'waiting' in opened ? opened.waiting : opened.opened;
  const found = await lostBefore(row);
  const lost = found && lostLink(found);
  // The link approves the earlier request, never the one just asked for, so both texts say whose it is.
  if ('waiting' in opened) {
    const open = reconnecting(row);
    return refusal(
      withNext(
        lines(
          `An earlier permission request is still ${open ? 'open' : 'waiting'} for the owner, so this one was not opened. It ${expiresIn(row.approveBy)}.`,
          `To approve or decline the earlier request: ${row.walletUrl}`,
          lost && lost.say
        ),
        sentences(
          'This link is for the earlier request, not the one just asked for: never present it as the new one.',
          open && RECONNECTING.trim(),
          lost && lost.next,
          `Once the earlier request is approved, declined or expired, ask for the new one again if jaw_session_status does not already show it in force. The earlier request expires at ${row.approveBy.toISOString()}.`
        )
      )
    );
  }
  const url = row.walletUrl;
  const ends = new Date(ask.grant.expiry * 1000);
  return reply({
    url,
    expiresAt: ends.toISOString(),
    summary: lines(
      `Open this link to approve: ${url}`,
      withNext(
        lines(
          sentences(
            `It asks the owner to approve a permission for this connection: ${ask.what}, until ${onDate(ends)}, ${withinWindow(row.approveBy)}.`,
            replacing && 'It replaces the current spend limit.',
            'Limits are enforced on chain, and the owner can revoke it anytime from their wallet.'
          ),
          lost && lost.say
        ),
        sentences(
          'Show the link now with one sentence of what it allows. Then check jaw_session_status on later turns to see it in force; do not wait for the owner to say they approved.',
          replacing &&
            'Once it is approved, this server tries to revoke the current spend limit on chain. Nothing pays from a replaced one, but if the revoke fee cannot be paid it stays approved on chain until it expires or jaw_revoke_permission revokes it.',
          earlier(t, held),
          lost && lost.next
        )
      )
    ),
  });
}

const RETRY_EVERY_MS = 5 * 60_000;
const RETRY_LOCK_WAIT_MS = 1_000;
const lastRetry = new Map<string, number>();

/**
 * After any tool call, retries in the background the revoke of a budget a newer
 * one replaced, at most every few minutes per connection. Only a request holds
 * the session key, so no timer can do it.
 */
export function retryReplacedRevokes(server: McpServer, deps = DEFAULTS): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
    register(name, config, async (...args: unknown[]) => {
      const result = await handler(...args);
      const t = tenant(args.at(-1) as Parameters<typeof tenant>[0]);
      if ((lastRetry.get(t.connectionId) ?? 0) <= Date.now() - RETRY_EVERY_MS) {
        lastRetry.set(t.connectionId, Date.now());
        const after: Promise<void> = revokeOlder(t, {
          ...deps,
          session: { ...deps.session, lockWaitMs: RETRY_LOCK_WAIT_MS },
        }).finally(() => followUps.delete(after));
        followUps.add(after);
      }
      return result;
    })) as typeof server.registerTool;
}

export function registerGrantTool(server: McpServer) {
  server.registerTool(
    'jaw_grant_permissions',
    {
      title: 'Ask the owner for a permission',
      description:
        'Ask the owner to approve a permission in their JAW wallet, once, that lets this connection act within it with no further approvals. ' +
        'Two kinds, requested separately. ' +
        'A spend limit for paid services: pass x402Budget with the USDC per day; it pays web services and the network fees of runs under permissions, and a new one replaces the current one. ' +
        'A custom permission: pass calls (contract and function signature) and spends (a per-period limit on each token those actions move); runs under it go through jaw_session_execute. ' +
        'Offer a permission only when the owner wants an action repeated or run without them, or when you are about to ask approval for the same action a second time; never for something asked once, which is jaw_send_calls. ' +
        'Before asking, say in one sentence what it allows, on which contract, up to how much per period, until when, and that they can revoke it anytime from their wallet, and ask for the narrowest permission that does the job. ' +
        'If the owner has no spend limit for paid services yet, runs under a custom permission cannot pay their network fee: say setup takes two approvals and ask for both. ' +
        'Returns a link: show it on its own line before anything else. ' +
        'Then check jaw_session_status on later turns to see it in force; do not wait for the owner to say they approved. ' +
        'A connection holds at most 5 live permissions, and a permission ends at expiresAt or when the connection ends, whichever comes first.',
      inputSchema: grantInput,
      outputSchema: output,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => {
      const t = tenant(ctx);
      if (!spends(t.scopes)) return refusal(NO_PAY_SCOPE);
      return grantPermissions(t, input);
    }
  );
}
