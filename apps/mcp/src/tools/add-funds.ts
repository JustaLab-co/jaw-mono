import { usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { ownerRelay, type OpenWallet } from '@/connections/relay';
import { countHit } from '@/db/settings';
import { addFundsHeld, openLink, type PermissionRequestRow } from '@/grants/requests';
import { addFundsWork, type AddFundsPayload } from '@/grants/resume';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { LINK_RATE_LIMIT } from '@/owner-calls/cap';
import { ACCOUNT_BUSY, refusal } from './reply';

const caip2 = (chainId: number) => `eip155:${chainId}`;
const caip19 = (network: string, token: string) => `${network}/erc20:${token}`;

const output = z.object({
  url: z.url().describe('Link for the owner, which opens the Add Funds screen in their wallet'),
  approveBy: z.string(),
  address: z.string(),
  chains: z.array(z.string()).describe('CAIP-2 chains this address accepts deposits on'),
  asset: z.string().optional().describe('CAIP-19 USDC to send, on a chain with USDC'),
  paymentUri: z.string().optional().describe('EIP-681 URI for a USDC transfer to the account'),
  summary: z.string(),
});

export interface AddFundsDeps {
  openWallet: OpenWallet;
}

const DEFAULTS: AddFundsDeps = { openWallet: ownerRelay };

function answer(t: Tenant, row: PermissionRequestRow) {
  const network = caip2(t.chainId);
  const usdc = usdcForNetwork(network);
  const by = row.approveBy.toISOString();
  return reply(
    output.parse({
      url: row.walletUrl,
      approveBy: by,
      address: t.account,
      chains: [network],
      asset: usdc && caip19(network, usdc.address),
      // EIP-681 ERC-20 transfer: a wallet that opens it sends USDC, not ETH, to the account.
      paymentUri: usdc && `ethereum:${usdc.address}@${t.chainId}/transfer?address=${t.account}`,
      summary:
        `Ask the account owner to open ${row.walletUrl} before ${by}: it shows the Add Funds screen in their wallet, with the address and a QR code to deposit to ${t.account} on ${network}. ` +
        (usdc
          ? `Without the wallet, anyone can send USDC on ${network} to ${t.account}, or open paymentUri. `
          : `Without the wallet, anyone can send funds on ${network} to ${t.account}. `) +
        'The wallet does not say whether funds arrived, only that the screen closed. ' +
        'Right after showing the link, call jaw_get_assets yourself to see the balance, and again on later turns; do not wait for the owner to say they sent funds.',
    })
  );
}

export async function addFunds(t: Tenant, deps = DEFAULTS) {
  if (
    !(await addFundsHeld(t)) &&
    (await countHit(`owner-add-funds:${t.connectionId}`, RATE_WINDOW_MS)) > LINK_RATE_LIMIT
  ) {
    return refusal('rate_limited: too many Add Funds requests on this connection. Wait a minute.');
  }
  const payload: AddFundsPayload = { chainId: t.chainId };
  const opened = await openLink(
    t,
    {
      method: 'add_funds',
      chainId: t.chainId,
      approveBy: new Date(Date.now() + APPROVE_WITHIN_MS),
      payload,
      rebuild: addFundsWork,
    },
    deps.openWallet
  );
  if (opened === 'wallet_busy') return refusal('Too many owners are approving right now. Try again in a minute.');
  if (opened === 'account_busy') return refusal(ACCOUNT_BUSY);
  return answer(t, 'opened' in opened ? opened.opened : opened.waiting);
}

export function registerAddFundsTool(server: McpServer) {
  server.registerTool(
    'jaw_add_funds',
    {
      description:
        "Show the account owner the Add Funds screen in their JAW wallet: the account's address and a QR code to deposit to on this connection's chain. No fiat on-ramp. " +
        'Returns a link for the owner; asking again while it waits returns the same link. ' +
        'Also returns the address and, on a chain with USDC, an EIP-681 USDC payment link to share without the wallet. ' +
        'The screen closing does not mean funds arrived: read the balance with jaw_get_assets.',
      inputSchema: z.strictObject({}),
      outputSchema: output,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (_args, ctx) => addFunds(tenant(ctx))
  );
}
