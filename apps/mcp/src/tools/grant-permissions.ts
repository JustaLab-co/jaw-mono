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
import { countHit } from '@/db/settings';
import { SPEND_UNITS } from '@/db/schema';
import { budgetGrant, readOnChain, type GrantRequest, type ReadPermission } from '@/grants/permission';
import {
  followUps,
  LINK_LOST,
  lostBefore,
  lostLinkSaid,
  openLink,
  RECONNECTING,
  reconnecting,
  requestById,
  type PermissionRequestRow,
} from '@/grants/requests';
import { grantAsked, grantWork, type GrantPayload } from '@/grants/resume';
import {
  grantsBeside,
  liveGrants,
  LIVE_GRANTS_PER_CONNECTION,
  replacedBudgets,
  standingOf,
  x402Budget,
  type Standing,
  type GrantKind,
  type LiveGrant,
} from '@/grants/store';
import { errorLabel, log, RATE_WINDOW_MS } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { counted, expiresIn, formatAmount, listed, onDate, spendLimits, withinWindow } from '@/lib/owner-text';
import { MAX_WAIT_SECONDS, SUGGESTED_WAIT_SECONDS, waiterOf, waitFor, type Waiter } from '@/lib/wait';
import { gateCode } from '@/payments/render';
import { forbiddenTargets } from './owner-calls';
import { ACCOUNT_BUSY, NO_PAY_SCOPE, refusal, withNext } from './reply';

const MAX_ENTRIES = 10;
const STATUS_RATE_LIMIT = 30;
const APPROVE_MINUTES = APPROVE_WITHIN_MS / 60_000;

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

const statusInput = z.strictObject({
  id: z
    .string()
    .regex(/^pr_[A-Za-z0-9_-]{22}$/)
    .describe('The id jaw_grant_permissions returned'),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(`Wait up to this many seconds (at most ${MAX_WAIT_SECONDS}) for the owner to answer before answering`),
});
export type GrantStatusInput = z.infer<typeof statusInput>;

/** What jaw_grant_permissions answers when it opens a link, and what jaw_get_grant_status answers after. */
const output = z.object({
  id: z.string(),
  state: z.enum(['awaiting_owner', 'approved', 'owner_declined', 'expired', 'failed']),
  kind: z.enum(['x402-budget', 'custom']),
  url: z.url().optional().describe('Link for the owner, while awaiting_owner'),
  approveBy: z.string(),
  expiresAt: z.string().describe('When the permission ends once approved'),
  permissionId: z
    .string()
    .optional()
    .describe('Once approved; on failed, a permission the wallet answered that may be in force on chain'),
  refusal: z.object({ code: z.string() }).optional(),
  summary: z.string(),
});

type GrantResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: z.infer<typeof output>;
  isError?: boolean;
  [gateCode]?: string;
};

/** A refusal: its code first for the agent's logic, then what the owner hears, then what the agent does about it. */
const refuse = (code: string, say: string, next?: string): GrantResult => ({
  content: [{ type: 'text', text: `${code}: ${withNext(say, next)}` }],
  isError: true,
  [gateCode]: code,
});

interface Asked {
  kind: GrantKind;
  grant: GrantRequest;
  what: string;
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
    // The session pays its own first op's fee from what the wallet sends along.
    capabilities: { prefundSpender: true },
  };
  const targets = [...new Map(calls.map((c) => [c.target.toLowerCase(), c.target])).values()];
  const on = targets.length === 1 ? targets[0] : `${targets.length} contracts (${listed(targets)})`;
  const actions = `${counted(calls.length, 'allowed action')} on ${on}`;
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
    return refuse(
      'grant_in_progress',
      lines(
        `An earlier permission request is still ${open ? 'open' : 'waiting'} for the owner, so this one was not opened. It ${expiresIn(row.approveBy)}.`,
        `To approve or decline the earlier request: ${row.walletUrl}`,
        lost && lost.say
      ),
      sentences(
        'This link is for the earlier request, not the one just asked for: never present it as the new one.',
        open && RECONNECTING.trim(),
        lost && lost.next,
        `Follow ${row.id} with jaw_get_grant_status. Once the earlier request is approved, declined or expired, ask for the new one again if the earlier one does not already cover it. The earlier request expires at ${row.approveBy.toISOString()}.`
      )
    );
  }
  const url = row.walletUrl;
  const ends = new Date(ask.grant.expiry * 1000);
  return answer(
    row,
    payload,
    lines(
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
          'Show the link now with one sentence of what it allows.',
          `Then call jaw_get_grant_status with id ${row.id} and waitSeconds ${SUGGESTED_WAIT_SECONDS}, and again while it answers awaiting_owner, until ${row.approveBy.toISOString()}.`,
          'Do not wait for the owner to say they approved.',
          replacing &&
            'Once it is approved, this server tries to revoke the current spend limit on chain. Nothing pays from a replaced one, but if the revoke fee cannot be paid it stays approved on chain until it expires or jaw_revoke_permission revokes it.',
          earlier(t, held),
          lost && lost.next
        )
      )
    )
  );
}

/** The reply for a grant request row, from the link it opened or a later status read. */
function answer(row: PermissionRequestRow, ask: GrantPayload, summary: string): GrantResult {
  const ended = row.state !== 'awaiting_owner' && row.state !== 'approved';
  return reply(
    output.parse({
      id: row.id,
      state: row.state,
      kind: ask.kind,
      url: row.state === 'awaiting_owner' ? row.walletUrl : undefined,
      approveBy: row.approveBy.toISOString(),
      expiresAt: new Date(ask.grant.expiry * 1000).toISOString(),
      permissionId: row.permissionId ?? undefined,
      refusal: ended ? { code: row.code ?? row.state } : undefined,
      summary,
    })
  );
}

/** What the owner hears, then what the agent does next. */
type Said = { say: string; next?: string };

const ASK_AGAIN = 'Ask again with jaw_grant_permissions if the owner still wants it.';

/** What happened to an approved permission since, and how many budgets it replaced are still approved on chain. */
type Since = { standing: Standing; olderLeft: number };

/** A status read: the agent already showed the link, so it shows it again only when the owner asks. */
function statusSaid(row: PermissionRequestRow, ask: GrantPayload, since: Since): Said {
  switch (row.state) {
    case 'awaiting_owner':
      return {
        say: `Still waiting for the owner to approve the permission. It ${expiresIn(row.approveBy)}.`,
        next: sentences(
          reconnecting(row) && RECONNECTING.trim(),
          `Call jaw_get_grant_status again with id ${row.id} and waitSeconds ${SUGGESTED_WAIT_SECONDS} until ${row.approveBy.toISOString()}. If the owner asks for the link, show it: ${row.walletUrl}`
        ),
      };
    case 'approved':
      return approvedSaid(row, ask, since);
    case 'owner_declined':
      return {
        say: 'The owner declined the permission. Nothing changed.',
        next: 'Do not ask for it again unless the owner asks.',
      };
    case 'expired':
      if (row.code === LINK_LOST) {
        return {
          say: 'The permission link stopped working after the owner opened it, so an answer given there may never arrive. If it is still open, do not approve it there.',
          next: `A permission approved on that link can go live on chain without this server recording it, and then only jaw_revoke_permission with its id from the wallet ends it. ${ASK_AGAIN}`,
        };
      }
      if (row.code === 'session_lost') {
        return {
          say: 'The permission link stopped working before the owner saw it. Nothing changed.',
          next: `The server lost the wallet session before the owner was asked. ${ASK_AGAIN}`,
        };
      }
      // An approval given in the last moments may land on chain after the window closed, unrecorded here.
      return {
        say: `The owner did not approve within ${APPROVE_MINUTES} minutes.`,
        next: `If they approved at the last moment, the permission may still be in force on chain: jaw_get_permissions lists the account's permissions. ${ASK_AGAIN}`,
      };
    case 'failed':
      if (row.code === 'wrong_account') {
        return {
          say: 'The owner approved with another account than the one connected here, so nothing was recorded for this connection.',
          next: sentences(
            row.permissionId !== null && `That account can revoke ${row.permissionId} from its own wallet.`,
            ASK_AGAIN
          ),
        };
      }
      if (row.permissionId) {
        return {
          say: 'The wallet approved a permission this server could not record, so it may be in force on chain without this connection using it.',
          next: `The request ended with ${row.code}. Revoke ${row.permissionId} with jaw_revoke_permission, then ask again if the owner still wants it.`,
        };
      }
      return {
        say: 'The wallet could not approve this permission. Nothing changed.',
        next: `The request ended with ${row.code}. ${ASK_AGAIN}`,
      };
  }
}

function approvedSaid(row: PermissionRequestRow, ask: GrantPayload, { standing, olderLeft }: Since): Said {
  const what = ask.kind === 'x402-budget' ? 'spend limit for paid services' : 'permission';
  switch (standing) {
    case 'revoked':
      return {
        say: `The owner approved the ${what}, and it has since been revoked.`,
        next: `Permission ${row.permissionId} no longer lets this connection act. ${ASK_AGAIN}`,
      };
    case 'expired':
      return {
        say: `The owner approved the ${what}, and it has since expired.`,
        next: ASK_AGAIN,
      };
    case 'replaced':
      return {
        say: `The owner approved the ${what}, and a newer one has since replaced it.`,
        next: `Nothing pays from ${row.permissionId}; jaw_session_status shows the current spend limit.`,
      };
    case 'in_force':
      break;
  }
  const ends = onDate(new Date(ask.grant.expiry * 1000));
  if (ask.kind === 'custom') {
    return {
      say: `The owner approved the permission. It is in force until ${ends}.`,
      next: `Its permission id is ${row.permissionId}. Run the actions it allows with jaw_session_execute.`,
    };
  }
  return {
    say: `The owner approved the spend limit for paid services. It is in force until ${ends}.`,
    next: sentences(
      `Its permission id is ${row.permissionId}; payments draw from it now.`,
      olderLeft > 0 &&
        'The spend limit it replaced is still approved on chain: nothing pays from it, this server keeps trying to revoke it, and jaw_connections lists it until then.'
    ),
  };
}

async function statusOf(t: Tenant, row: PermissionRequestRow): Promise<GrantResult> {
  const ask = grantAsked(row);
  const found = await lostBefore(row);
  const since: Since = { standing: 'in_force', olderLeft: 0 };
  if (row.state === 'approved' && row.permissionId) {
    since.standing = await standingOf(t.connectionId, row.permissionId);
    if (ask.kind === 'x402-budget' && since.standing === 'in_force') {
      since.olderLeft = (await replacedBudgets(t.connectionId)).length;
    }
  }
  const said = [statusSaid(row, ask, since), ...(found ? [lostLink(found)] : [])];
  const next = said.flatMap((s) => (s.next ? [s.next] : [])).join(' ');
  return answer(row, ask, withNext(said.map((s) => s.say).join('\n'), next || undefined));
}

export async function grantStatus(
  t: Tenant,
  { id, waitSeconds = 0 }: GrantStatusInput,
  deps: { pollMs?: number } = {},
  waiter: Waiter = {}
): Promise<GrantResult> {
  if ((await countHit(`owner-grant-status:${t.connectionId}`, RATE_WINDOW_MS)) > STATUS_RATE_LIMIT) {
    return refuse(
      'rate_limited',
      'Too many checks in a short time.',
      'Too many status reads on this connection. Wait a minute, then call jaw_get_grant_status again.'
    );
  }
  const until = Date.now() + waitSeconds * 1000;
  const read = async () => {
    const row = await requestById(t, 'grant', id);
    return row
      ? statusOf(t, row)
      : refuse(
          'not_found',
          'That permission request was not found on this connection.',
          'No grant request on this connection has that id.'
        );
  };
  const settled = (r: GrantResult) => r.structuredContent?.state !== 'awaiting_owner';
  return waitFor(await read(), { key: `grant:${t.connectionId}`, until, read, settled, pollMs: deps.pollMs }, waiter);
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
        'Returns a link and an id right away: show the link on its own line before anything else. ' +
        `Then call jaw_get_grant_status with the id and waitSeconds ${SUGGESTED_WAIT_SECONDS}, and repeat while it answers awaiting_owner, up to ${APPROVE_MINUTES} minutes, without waiting for the owner to say they approved. ` +
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
  server.registerTool(
    'jaw_get_grant_status',
    {
      title: 'Check a permission request',
      description:
        'Follow a request jaw_grant_permissions opened: whether the owner approved, declined or let it expire, and the permission id once approved. ' +
        `Call it right after showing the link with waitSeconds ${SUGGESTED_WAIT_SECONDS}, and again each time it answers awaiting_owner, until the request's approveBy. ` +
        'While it waits, its result carries the link, so show it again if the owner asks. ' +
        'Never ask the owner whether they approved; this tool knows first.',
      inputSchema: statusInput,
      outputSchema: output,
      annotations: { readOnlyHint: true },
    },
    async (input, ctx) => grantStatus(tenant(ctx), input, {}, waiterOf(ctx, input.waitSeconds ?? 0))
  );
}
