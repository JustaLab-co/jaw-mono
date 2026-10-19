import { usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import { isAddressEqual, parseUnits } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { ownerRelay, WalletBusy, type OpenWallet, type Wallet } from '@/connections/relay';
import { CONNECTION_TTL_MS, isLive } from '@/connections/rows';
import { spends } from '@/connections/scopes';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import { budgetGrant, checkGranted, readOnChain, recordGrant, type ReadPermission } from '@/grants/permission';
import { liveGrants, LIVE_GRANTS_PER_CONNECTION } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { NO_PAY_SCOPE, refusal } from './reply';

const PER_DAY = /^\d{1,9}(\.\d{1,6})?$/;

export interface BudgetDeps {
  openWallet: OpenWallet;
  readPermission: ReadPermission;
}

const DEFAULTS: BudgetDeps = { openWallet: ownerRelay, readPermission: readOnChain };

const output = z.object({ url: z.url(), summary: z.string() });

/** The link of the request still open, per connection: asking again while it waits hands out the same one. */
const open = new Map<string, { url: string; until: Date }>();

export async function requestBudget(t: Tenant, perDay: string, deps = DEFAULTS) {
  const waiting = open.get(t.connectionId);
  if (waiting) {
    return refusal(
      `A budget request is still waiting for the owner at ${waiting.url}. Ask again once they approve or it expires at ${waiting.until.toISOString()}.`
    );
  }
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!usdc) return refusal("USDC is not supported on this connection's chain.");
  const allowance = parseUnits(perDay, usdc.decimals);
  if (allowance === 0n) return refusal('A budget of zero would refuse every payment.');
  if ((await liveGrants(t.connectionId)).length >= LIVE_GRANTS_PER_CONNECTION) {
    return refusal(
      `This connection already holds ${LIVE_GRANTS_PER_CONNECTION} live grants, the most one connection may hold. ` +
        'Wait for one to expire, or call jaw_session_disconnect, which revokes them all, and connect again.'
    );
  }
  const grant = budgetGrant({
    chainId: t.chainId,
    spender: t.sessionAddress,
    token: usdc.address,
    allowance,
    expiry: Math.floor((Date.now() + CONNECTION_TTL_MS) / 1000),
  });
  const until = new Date(Date.now() + APPROVE_WITHIN_MS);
  let wallet: Wallet;
  try {
    wallet = await deps.openWallet(t.chainId, until, t);
  } catch (err) {
    if (err instanceof WalletBusy) return refusal('Too many owners are approving right now. Try again in a minute.');
    throw err;
  }
  open.set(t.connectionId, { url: wallet.url, until });
  void wallet
    .run(async (ask) => {
      const checked = await checkGranted(
        t.chainId,
        grant,
        await ask('wallet_grantPermissions', [grant]),
        deps.readPermission
      );
      if (typeof checked === 'string') throw new Error(checked);
      if (!isAddressEqual(checked.account as `0x${string}`, t.account)) throw new Error('granted from another account');
      await getDb().transaction(async (tx) => {
        const [live] = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(and(eq(connections.id, t.connectionId), isLive()))
          .for('update');
        if (!live) throw new Error('connection ended');
        await recordGrant(tx, t.connectionId, checked);
      });
    })
    .catch((err: unknown) => log('warn', { msg: 'budget not granted', error: errorLabel(err) }))
    .finally(() => open.delete(t.connectionId));
  const out = {
    url: wallet.url,
    summary:
      `Ask the account owner to open ${wallet.url} and approve ${perDay} USDC a day in their wallet. ` +
      'Once they do, payments draw from it with no further prompts; jaw_status shows the budget in force. ' +
      'A budget approved earlier on this connection stays approved on chain until it expires or jaw_session_disconnect revokes it.',
  };
  return reply(out);
}

export function registerBudgetTool(server: McpServer) {
  server.registerTool(
    'jaw_request_budget',
    {
      description:
        "Ask the account owner for a daily USDC budget, approved once in their JAW wallet. The budget covers USDC only: payments, refills and swap quotes run with no further prompts, up to it. For any other contract call use jaw_send_calls, which asks the owner each time. Returns a link for the owner. Ask again for a different amount; payments then draw from the newest budget, and the older ones stay approved until they expire or jaw_session_disconnect revokes them.",
      inputSchema: z.strictObject({
        perDay: z.string().regex(PER_DAY).describe('USDC per day, as a decimal such as "1" or "0.5"'),
      }),
      outputSchema: output,
    },
    async ({ perDay }, ctx) => {
      const t = tenant(ctx);
      if (!spends(t.scopes)) return refusal(NO_PAY_SCOPE);
      return requestBudget(t, perDay);
    }
  );
}
