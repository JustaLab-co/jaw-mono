import { ANY_FN_SEL, ANY_TARGET, EMPTY_CALLDATA_FN_SEL } from '@jaw.id/core';
import { usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import {
  formatUnits,
  isAddress,
  isAddressEqual,
  isHex,
  numberToHex,
  parseUnits,
  toFunctionSelector,
  type Address,
} from 'viem';
import { z } from 'zod';
import { chainClients } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { revokeReplaced, sessionSender, type DisconnectDeps } from '@/connections/disconnect';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { ownerRelay, type Ask, type OpenWallet } from '@/connections/relay';
import { isLive } from '@/connections/rows';
import { spends } from '@/connections/scopes';
import { getDb } from '@/db/client';
import { connections, SPEND_UNITS } from '@/db/schema';
import {
  budgetGrant,
  checkGranted,
  readOnChain,
  recordGrant,
  type GrantRequest,
  type ReadPermission,
} from '@/grants/permission';
import { lostBefore, lostPreamble, openLink, type Claim, type Outcome } from '@/grants/requests';
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
import { forbiddenTargets } from './owner-calls';
import { ACCOUNT_BUSY, NO_PAY_SCOPE, refusal } from './reply';

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
    .describe('The x402 budget preset: a daily USDC allowance that payments, refills and swap quotes draw from'),
  calls: z
    .array(z.strictObject({ target: address, functionSignature: signature }))
    .min(1)
    .max(MAX_ENTRIES)
    .optional()
    .describe('The contract functions the session key may call, each a target and a function signature'),
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
    .describe('How much of each token the session key may move per period'),
  expiresAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When the grant ends; the connection's own end when absent or later"),
});
export type GrantInput = z.input<typeof grantInput>;

interface GrantDeps {
  openWallet: OpenWallet;
  readPermission: ReadPermission;
  /** What revokes replaced budgets as spender. Without it they stay replaced until the disconnect. */
  session?: Pick<DisconnectDeps, 'clients' | 'sender'>;
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

function asked(t: Tenant, input: GrantInput, expiry: number): Asked | string {
  if (input.x402Budget) {
    const usdc = usdcForNetwork(`eip155:${t.chainId}`);
    if (!usdc) return "USDC is not supported on this connection's chain.";
    const allowance = parseUnits(input.x402Budget.perDay, usdc.decimals);
    if (allowance === 0n) return 'A budget of zero would refuse every payment.';
    const grant = budgetGrant({
      chainId: t.chainId,
      spender: t.sessionAddress,
      token: usdc.address,
      allowance,
      expiry,
    });
    return { kind: 'x402-budget', grant, what: `${input.x402Budget.perDay} USDC a day` };
  }
  if (!input.calls) return 'Pass x402Budget for the payment budget, or calls (and any spends) for a custom grant.';
  const forbidden = forbiddenTargets(t).add(ANY_TARGET.toLowerCase());
  const refused = input.calls.find((c) => forbidden.has(c.target.toLowerCase()));
  if (refused) {
    return `call_target_refused: a grant to call ${refused.target} is refused: the account itself, the permission manager, the EntryPoint contracts and the any-contract wildcard cannot be granted.`;
  }
  const wildcard = input.calls.find((c) => WILDCARD_SELECTORS.has(toFunctionSelector(c.functionSignature)));
  if (wildcard) {
    return `call_selector_refused: ${wildcard.functionSignature} hashes to a selector the permission manager reads as any function (or an empty call), so it cannot be granted.`;
  }
  const calls = input.calls.map((c) => ({ target: c.target as Address, functionSignature: c.functionSignature }));
  const spent = (input.spends ?? []).map((s) => ({ ...s, token: s.token as Address, multiplier: s.multiplier ?? 1 }));
  const grant: GrantRequest = {
    spender: t.sessionAddress,
    expiry,
    chainId: numberToHex(t.chainId),
    permissions: { calls, spends: spent },
  };
  return { kind: 'custom', grant, what: `${calls.length} call(s) and ${spent.length} spend limit(s)` };
}

/** Revokes the budgets a newer one replaced. One left approved stays replaced, so nothing pays from it. */
async function revokeOlder(t: Tenant, deps: GrantDeps) {
  if (!deps.session) return;
  const outcome = await revokeReplaced(t, { readPermission: deps.readPermission, ...deps.session }).catch(errorLabel);
  if (typeof outcome === 'string') log('warn', { msg: 'replaced budget not revoked', error: outcome });
  else if (outcome.stillApproved.length || outcome.unread.length) {
    log('warn', { msg: 'replaced budget not revoked', error: [...outcome.stillApproved, ...outcome.unread].join(',') });
  }
}

async function askGrant(t: Tenant, ask: Asked, walletAsk: Ask, claim: Claim, deps: GrantDeps): Promise<Outcome> {
  if (!(await claim())) return { state: 'expired', code: 'session_lost' };
  const answer = await walletAsk('wallet_grantPermissions', [ask.grant]);
  const answered = (answer as { permissionId?: unknown } | null)?.permissionId;
  const permissionId = isHex(answered) ? answered : undefined;
  const checked = await checkGranted(t.chainId, ask.grant, ask.kind, answer, deps.readPermission);
  if (typeof checked === 'string') return { state: 'failed', code: checked, permissionId };
  if (!isAddressEqual(checked.account as Address, t.account)) {
    return { state: 'failed', code: 'wrong_account', permissionId };
  }
  try {
    const recorded = await getDb().transaction(async (tx) => {
      const [live] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, t.connectionId), isLive()))
        .for('update');
      if (live) await recordGrant(tx, t.connectionId, checked);
      return live !== undefined;
    });
    return recorded ? { state: 'approved', permissionId } : { state: 'failed', code: 'connection_ended', permissionId };
  } catch (err) {
    log('warn', { msg: 'granted permission not recorded', permissionId, error: errorLabel(err) });
    return { state: 'failed', code: 'not_recorded', permissionId };
  }
}

/** What the connection's live grants let the session key move, summed per token and period. */
function liveTotals(t: Tenant, held: LiveGrant[]): string {
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  const sums = new Map<string, { token: string; per: string; amount: bigint }>();
  for (const { token, unit, multiplier, allowance } of held.flatMap((g) => g.permission.spends)) {
    const per = unit === 'forever' ? 'in total' : multiplier === 1 ? `per ${unit}` : `per ${multiplier} ${unit}s`;
    const key = `${token.toLowerCase()}:${per}`;
    const sum = sums.get(key) ?? { token, per, amount: 0n };
    sums.set(key, { ...sum, amount: sum.amount + BigInt(allowance) });
  }
  if (!sums.size) return 'No grant approved on chain for this connection lets the session key move tokens yet. ';
  const lines = [...sums.values()].map(({ token, per, amount }) =>
    usdc && isAddressEqual(token as Address, usdc.address)
      ? `${formatUnits(amount, usdc.decimals)} USDC ${per}`
      : `${amount} base units of ${token} ${per}`
  );
  return `The ${held.length} grant(s) approved on chain for this connection already let the session key move up to ${lines.join(', ')}. `;
}

export async function grantPermissions(t: Tenant, input: GrantInput, deps = DEFAULTS) {
  if (input.x402Budget && (input.calls || input.spends || input.expiresAt)) {
    return refusal('x402Budget is a preset: pass it alone, or pass calls and spends without it.');
  }
  const requested = input.expiresAt ? new Date(input.expiresAt) : t.expiresAt;
  if (requested.getTime() <= Date.now()) {
    return refusal(`expiry_in_past: the expiry ${requested.toISOString()} has already passed. Ask for a later one.`);
  }
  const until = new Date(Date.now() + APPROVE_WITHIN_MS);
  const expiresAt = requested < t.expiresAt ? requested : t.expiresAt;
  if (expiresAt <= until) {
    return refusal(
      `expiry_too_soon: the grant would end at ${expiresAt.toISOString()}, before the owner's ${APPROVE_WITHIN_MS / 60_000} minutes to approve it are up. Ask for a later expiry.`
    );
  }
  const ask = asked(t, input, Math.floor(expiresAt.getTime() / 1000));
  if (typeof ask === 'string') return refusal(ask);
  if ((await grantsBeside(t.connectionId, ask.kind)) >= LIVE_GRANTS_PER_CONNECTION) await revokeOlder(t, deps);
  if ((await grantsBeside(t.connectionId, ask.kind)) >= LIVE_GRANTS_PER_CONNECTION) {
    return refusal(
      `This connection already holds ${LIVE_GRANTS_PER_CONNECTION} live grants, the most one connection may hold. ` +
        'Wait for one to expire, revoke one listed by jaw_connections with jaw_revoke_permission, or call jaw_session_disconnect, which revokes them all, and connect again.'
    );
  }
  const held = await liveGrants(t.connectionId);
  const replacing = ask.kind === 'x402-budget' && (await x402Budget(t.connectionId)) !== undefined;
  const opened = await openLink(
    t,
    {
      method: 'grant',
      chainId: t.chainId,
      approveBy: until,
      work: (walletAsk, claim) => askGrant(t, ask, walletAsk, claim, deps),
      settled: async ({ state }) => {
        if (state === 'approved') await revokeOlder(t, deps);
      },
    },
    deps.openWallet
  );
  if (opened === 'wallet_busy') return refusal('Too many owners are approving right now. Try again in a minute.');
  if (opened === 'account_busy') return refusal(ACCOUNT_BUSY);
  const row = 'waiting' in opened ? opened.waiting : opened.opened;
  const lost = await lostBefore(row);
  const warning = lost
    ? lostPreamble(lost, 'grant') +
      'Tell the owner not to approve that one: a grant approved there can go live on chain without this server recording it, and then only jaw_revoke_permission with its id from the wallet ends it. '
    : '';
  if ('waiting' in opened) {
    return refusal(
      `${warning}A grant request is still waiting for the owner at ${row.walletUrl}. Ask again once they approve or it expires at ${row.approveBy.toISOString()}.`
    );
  }
  const url = row.walletUrl;
  const ends = new Date(ask.grant.expiry * 1000).toISOString();
  return reply({
    url,
    expiresAt: ends,
    summary:
      warning +
      `Ask the account owner to open ${url} and approve ${ask.what} until ${ends} in their wallet. ` +
      'Once they do, the session key acts within it with no further prompts. ' +
      liveTotals(t, held) +
      (replacing
        ? 'Approving this budget replaces the current one, which this server then revokes on chain; jaw_session_status shows the budget in force. '
        : '') +
      'Other grants approved earlier on this connection stay approved on chain until they expire or jaw_session_disconnect revokes them.',
  });
}

export function registerGrantTool(server: McpServer) {
  server.registerTool(
    'jaw_grant_permissions',
    {
      description:
        'Ask the account owner to grant this session key a permission, approved once in their JAW wallet. ' +
        'Pass x402Budget for the payment budget: a daily USDC allowance that payments, refills and swap quotes draw from with no further prompts; payments use the newest one. ' +
        'Or pass calls, the contract functions the session key may call, and spends, how much of each token it may move per period, for a custom grant. ' +
        'A new x402Budget replaces the current one, which the server then revokes on chain. ' +
        'The grant ends at expiresAt, or with the connection when that comes first. A connection holds at most 5 live grants. Returns a link for the owner. For a one-off contract call use jaw_send_calls, which asks the owner each time.',
      inputSchema: grantInput,
      outputSchema: output,
    },
    async (input, ctx) => {
      const t = tenant(ctx);
      if (!spends(t.scopes)) return refusal(NO_PAY_SCOPE);
      return grantPermissions(t, input);
    }
  );
}
