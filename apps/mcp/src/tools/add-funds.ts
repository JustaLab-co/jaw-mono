import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { ownerRelay, type OpenWallet } from '@/connections/relay';
import { countHit } from '@/db/settings';
import { addFundsHeld, openLink, type PermissionRequestRow } from '@/grants/requests';
import { addFundsWork, type AddFundsPayload } from '@/grants/resume';
import { caip2, isProxyChain } from '@/lib/chain';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { LINK_RATE_LIMIT } from '@/owner-calls/cap';
import { ACCOUNT_BUSY, refusal } from './reply';

const input = z.strictObject({
  chainId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("A chain the JAW wallet supports; defaults to this connection's chain"),
});

const output = z.object({
  url: z.url().describe('Link for the owner, which opens the Add Funds screen in their wallet'),
  approveBy: z.string(),
  address: z.string(),
  chains: z.array(z.string()).describe('CAIP-2 chains this address accepts deposits on'),
  summary: z.string(),
});

export interface AddFundsDeps {
  openWallet: OpenWallet;
}

const DEFAULTS: AddFundsDeps = { openWallet: ownerRelay };

const withoutWallet = (t: Tenant, chainId: number) =>
  `Without the wallet, anyone can send funds on ${caip2(chainId)} to ${t.account}.`;

/** A refusal to open the link still names where to deposit, since that needs no wallet. */
const refusedWithAddress = (t: Tenant, chainId: number, text: string) =>
  refusal(`${text} ${withoutWallet(t, chainId)}`);

function answer(t: Tenant, chainId: number, row: PermissionRequestRow) {
  const network = caip2(chainId);
  const by = row.approveBy.toISOString();
  return reply(
    output.parse({
      url: row.walletUrl,
      approveBy: by,
      address: t.account,
      chains: [network],
      summary:
        `Ask the account owner to open ${row.walletUrl} before ${by}: it shows the Add Funds screen in their wallet, with the address and a QR code to deposit to ${t.account} on ${network}. ` +
        `${withoutWallet(t, chainId)} ` +
        'The wallet does not say whether funds arrived, only that the screen closed. ' +
        'Right after showing the link, call jaw_get_assets yourself to see the balance, and again on later turns; do not wait for the owner to say they sent funds.',
    })
  );
}

export async function addFunds(t: Tenant, args: { chainId?: number } = {}, deps = DEFAULTS) {
  const chainId = args.chainId ?? t.chainId;
  if (!isProxyChain(chainId)) {
    return refusal(`unsupported_chain: Chain ${chainId} is not one the JAW wallet supports.`);
  }
  if (
    !(await addFundsHeld(t)) &&
    (await countHit(`owner-add-funds:${t.connectionId}`, RATE_WINDOW_MS)) > LINK_RATE_LIMIT
  ) {
    return refusedWithAddress(
      t,
      chainId,
      'rate_limited: too many Add Funds requests on this connection. Wait a minute.'
    );
  }
  const payload: AddFundsPayload = { chainId };
  const opened = await openLink(
    t,
    {
      method: 'add_funds',
      chainId,
      approveBy: new Date(Date.now() + APPROVE_WITHIN_MS),
      payload,
      rebuild: addFundsWork,
    },
    deps.openWallet
  );
  if (opened === 'wallet_busy') {
    return refusedWithAddress(t, chainId, 'Too many owners are approving right now. Try again in a minute.');
  }
  if (opened === 'account_busy') return refusedWithAddress(t, chainId, ACCOUNT_BUSY);
  const row = 'opened' in opened ? opened.opened : opened.waiting;
  // One link waits per connection, so a link on another chain is named rather than handed back.
  if (row.chainId !== chainId) {
    return refusedWithAddress(
      t,
      chainId,
      `add_funds_in_progress: This connection already asked the owner to add funds on ${caip2(row.chainId)} at ${row.walletUrl}, until ${row.approveBy.toISOString()}. ` +
        `Ask again for chain ${row.chainId} to get that link, or for ${chainId} once it ends.`
    );
  }
  return answer(t, chainId, row);
}

export function registerAddFundsTool(server: McpServer) {
  server.registerTool(
    'jaw_add_funds',
    {
      description:
        "Show the account owner the Add Funds screen in their JAW wallet: the account's address and a QR code to deposit any token to on one chain, this connection's chain unless chainId names another. No fiat on-ramp. " +
        'Returns a link for the owner; asking again while it waits returns the same link, and a connection waits on one Add Funds link at a time. ' +
        'Also returns the address and its chain, to send funds to without the wallet. ' +
        'The screen closing does not mean funds arrived: read the balance with jaw_get_assets.',
      inputSchema: input,
      outputSchema: output,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args, ctx) => addFunds(tenant(ctx), args)
  );
}
