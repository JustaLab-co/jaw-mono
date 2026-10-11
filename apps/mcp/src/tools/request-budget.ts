import { usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import { getAddress, isAddressEqual, parseUnits, toFunctionSelector } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { openRelay, type OpenWallet } from '@/connections/relay';
import { CONNECTION_TTL_MS, isLive } from '@/connections/rows';
import { spends } from '@/connections/scopes';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import {
  budgetGrant,
  checkGranted,
  readOnChain,
  recordGrant,
  type PermissionCall,
  type ReadPermission,
} from '@/grants/permission';
import { errorLabel, log } from '@/lib/edge';
import { NO_PAY_SCOPE, refusal } from './reply';

export const PER_DAY = /^\d{1,9}(\.\d{1,6})?$/;
const MAX_CALLS = 10;

export interface BudgetDeps {
  openWallet: OpenWallet;
  readPermission: ReadPermission;
}

const DEFAULTS: BudgetDeps = { openWallet: openRelay, readPermission: readOnChain };

const callInput = z.strictObject({
  to: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe('The contract'),
  functionSignature: z.string().max(256).describe('Such as "approve(address,uint256)"'),
});

const output = z.object({ url: z.url(), summary: z.string() });

const validSignature = (signature: string) => {
  try {
    toFunctionSelector(signature);
    return true;
  } catch {
    return false;
  }
};

/** Asks the owner's wallet for the permission, and makes it the connection's budget once the chain shows it. */
export async function requestBudget(t: Tenant, perDay: string, calls: PermissionCall[], deps = DEFAULTS) {
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!usdc) return refusal("USDC is not supported on this connection's chain.");
  const allowance = parseUnits(perDay, usdc.decimals);
  if (allowance === 0n) return refusal('A budget of zero would refuse every payment.');
  const grant = budgetGrant({
    chainId: t.chainId,
    spender: t.sessionAddress,
    token: usdc.address,
    allowance,
    expiry: Math.floor((Date.now() + CONNECTION_TTL_MS) / 1000),
    calls,
  });
  const wallet = await deps.openWallet(t.chainId);
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
          .for('share');
        if (!live) throw new Error('connection ended');
        await recordGrant(tx, t.connectionId, checked);
      });
    })
    .catch((err: unknown) => log('warn', { msg: 'budget not granted', error: errorLabel(err) }));
  const out = {
    url: wallet.url,
    summary:
      `Ask the account owner to open ${wallet.url} and approve ${perDay} USDC a day in their wallet. ` +
      'Once they do, payments draw from it with no further prompts; jaw_status shows the budget in force.',
  };
  return { content: [{ type: 'text' as const, text: out.summary }], structuredContent: out };
}

export function registerBudgetTool(server: McpServer) {
  server.registerTool(
    'jaw_request_budget',
    {
      description:
        "Ask the account owner for a daily USDC budget, approved once in their JAW wallet. Payments, transfers and the contract calls it lists then run with no further prompts, up to the budget. Returns a link for the owner. Ask again for more, or to add calls; the new budget replaces this connection's current one.",
      inputSchema: z.strictObject({
        perDay: z.string().regex(PER_DAY).describe('USDC per day, as a decimal such as "1" or "0.5"'),
        calls: z
          .array(callInput)
          .max(MAX_CALLS)
          .optional()
          .describe(
            'Contract functions jaw_send_calls may call within the budget. USDC transfers are always included.'
          ),
      }),
      outputSchema: output,
    },
    async ({ perDay, calls = [] }, ctx) => {
      const t = tenant(ctx);
      if (!spends(t.scopes)) return refusal(NO_PAY_SCOPE);
      if (!calls.every((c) => validSignature(c.functionSignature))) {
        return refusal('A function signature is not valid, such as "approve(address,uint256)".');
      }
      const asked = calls.map((c) => ({ target: getAddress(c.to), functionSignature: c.functionSignature }));
      return requestBudget(t, perDay, asked);
    }
  );
}
