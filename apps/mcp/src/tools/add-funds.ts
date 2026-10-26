import { handleGetCapabilitiesRequest } from '@jaw.id/core';
import type { McpServer } from '@modelcontextprotocol/server';
import { withTimeout } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS, config } from '@/connections/config';
import { ownerRelay, type OpenWallet } from '@/connections/relay';
import { countHit } from '@/db/settings';
import { addFundsHeldOn, openLink, type PermissionRequestRow } from '@/grants/requests';
import { addFundsWork, type AddFundsPayload } from '@/grants/resume';
import { caip2, isProxyChain } from '@/lib/chain';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { chainName, expiresIn, listed, withinWindow } from '@/lib/owner-text';
import { LINK_RATE_LIMIT, MAX_ADD_FUNDS_PER_ACCOUNT } from '@/owner-calls/cap';
import { reasonOf, refusal, withNext } from './reply';

/** How long the reply waits on the supported networks before it names the ones it already knows. */
const NETWORKS_WAIT_MS = 3_000;

const input = z.strictObject({
  chainId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "The network the Add Funds screen opens on: a chain jaw_get_capabilities lists for this account, mainnets only on a mainnet server; defaults to this connection's chain"
    ),
});

const output = z.object({
  url: z.url().describe('Link for the owner, which opens the Add Funds screen in their wallet'),
  approveBy: z.string(),
  address: z.string(),
  chains: z
    .array(z.string())
    .describe(
      'CAIP-2 chains this address accepts deposits on: every network the wallet supports, the one the screen opens on first'
    ),
  summary: z.string(),
});

export interface AddFundsDeps {
  openWallet: OpenWallet;
  /** The chains the proxy lists capabilities for, as jaw_get_capabilities reads them. */
  capabilityChains: (account: string, showTestnets: boolean) => Promise<number[]>;
}

const capabilityChains: AddFundsDeps['capabilityChains'] = async (account, showTestnets) =>
  Object.keys(
    await handleGetCapabilitiesRequest(
      { method: 'wallet_getCapabilities', params: [account] },
      config().paymasterApiKey,
      showTestnets
    )
  ).map(Number);

const DEFAULTS: AddFundsDeps = { openWallet: ownerRelay, capabilityChains };

const showTestnets = () => config().chain.testnet === true;

/**
 * Every network the account's address takes deposits on, `first` leading: the address is the same on all of them.
 * The chains already known when the capabilities cannot be read.
 */
async function networksOf(t: Tenant, first: number, deps: AddFundsDeps, chains?: number[]): Promise<number[]> {
  let found = chains;
  if (!found) {
    try {
      found = await withTimeout(() => deps.capabilityChains(t.account, showTestnets()), {
        timeout: NETWORKS_WAIT_MS,
        errorInstance: new Error('the supported networks were not read in time'),
      });
    } catch {
      found = [];
    }
  }
  return [...new Set([first, t.chainId, ...found])];
}

/** Where the owner can send funds without the screen: the address once, then the networks it works on. */
function depositLine(t: Tenant, networks: number[], can: 'also' | 'still'): string {
  const where =
    networks.length > 1
      ? `on any network the wallet supports: ${networks.map(chainName).join(', ')}`
      : `on ${chainName(networks[0])}`;
  return `Funds can ${can} be sent directly to ${t.account} ${where}.`;
}

/**
 * A refusal to open the link still names where to deposit, since that needs no wallet. A link already waiting goes
 * last, on its own line, with nothing after it.
 */
const refusedWithAddress = (t: Tenant, networks: number[], say: string, next?: string, waiting?: string) =>
  refusal(
    withNext(
      `${say} ${depositLine(t, networks, 'still')}${waiting ? `\nOpen this link to add funds: ${waiting}` : ''}`,
      next
    )
  );

/** How long the link works, as it opens: "for the next 30 minutes". */
const openFor = (approveBy: Date) => withinWindow(approveBy).replace(/^within /, 'for ');

function answer(t: Tenant, networks: number[], row: PermissionRequestRow) {
  return reply(
    output.parse({
      url: row.walletUrl,
      approveBy: row.approveBy.toISOString(),
      address: t.account,
      chains: networks.map(caip2),
      summary: withNext(
        `Open this link to add funds: ${row.walletUrl}\n` +
          `It shows the wallet address and a QR code, and works ${openFor(row.approveBy)}. ${depositLine(t, networks, 'also')}`,
        'Do not read the balance now. ' +
          "On the owner's next messages, read it with jaw_get_assets before answering, and continue the original request once it covers it. " +
          'The screen closing does not mean funds arrived.'
      ),
    })
  );
}

const unsupported = (chainId: number, networks: number[]) =>
  refusal(
    withNext(
      `unsupported_chain: The wallet cannot receive on that network here. It can on ${listed(networks.map(chainName))}.`,
      `Chain ${chainId} is not one the wallet supports here; jaw_get_capabilities lists the networks.`
    )
  );

export async function addFunds(t: Tenant, args: { chainId?: number } = {}, given: Partial<AddFundsDeps> = {}) {
  const deps = { ...DEFAULTS, ...given };
  const chainId = args.chainId ?? t.chainId;
  // The chains the proxy lists, once read to check the asked one.
  let chains: number[] | undefined;
  // A link waiting on the asked chain was checked when it opened, so asking again needs no lookup.
  const heldOn = await addFundsHeldOn(t);
  if (chainId !== t.chainId && chainId !== heldOn) {
    if (!isProxyChain(chainId)) return unsupported(chainId, await networksOf(t, t.chainId, deps));
    // A mainnet server takes mainnets only, as jaw_get_assets reads balances on those and the connection's chain.
    try {
      chains = await deps.capabilityChains(t.account, showTestnets());
    } catch (err) {
      return refusedWithAddress(
        t,
        [t.chainId],
        'proxy_error: The networks the wallet supports could not be checked right now, so the screen did not open.',
        `Chain ${chainId} could not be checked: ${reasonOf(err).replace(/\.?$/, '.')} Ask again, or leave chainId out for this connection's chain.`
      );
    }
    if (!chains.includes(chainId)) return unsupported(chainId, await networksOf(t, t.chainId, deps, chains));
  }
  if (heldOn === undefined && (await countHit(`owner-add-funds:${t.connectionId}`, RATE_WINDOW_MS)) > LINK_RATE_LIMIT) {
    // No lookup for a request refused this fast: the networks already known are enough to deposit on.
    return refusedWithAddress(
      t,
      [...new Set([chainId, t.chainId])],
      'rate_limited: Too many Add Funds requests in a short time, so the screen did not open.',
      'Wait a minute, then try again.'
    );
  }
  // Read beside the link, for the networks every answer from here names.
  const networks = networksOf(t, chainId, deps, chains);
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
  // Names no other connection's link, since that link is for another app.
  if (opened === 'add_funds_busy') {
    return refusedWithAddress(
      t,
      await networks,
      `add_funds_busy: The wallet already has ${MAX_ADD_FUNDS_PER_ACCOUNT} Add Funds screens waiting. One has to close or expire before a new one can open.`,
      'Wait, then try again.'
    );
  }
  if (opened === 'wallet_busy') {
    return refusedWithAddress(
      t,
      await networks,
      'Too many owners are approving right now, so the screen did not open.',
      'Try again in a minute.'
    );
  }
  const row = 'opened' in opened ? opened.opened : opened.waiting;
  // One link waits per connection, so a link on another chain is named rather than handed back.
  if (row.chainId !== chainId) {
    return refusedWithAddress(
      t,
      await networks,
      `add_funds_in_progress: An Add Funds link for ${chainName(row.chainId)} is already open; it ${expiresIn(row.approveBy)}.`,
      `Ask again with chainId ${row.chainId} to get that link, or with ${chainId} once it ends.`,
      row.walletUrl
    );
  }
  return answer(t, await networks, row);
}

export function registerAddFundsTool(server: McpServer) {
  server.registerTool(
    'jaw_add_funds',
    {
      title: 'Add funds to the wallet',
      description:
        "Open the Add Funds screen in the owner's JAW wallet: their address and a QR code to receive tokens. " +
        'The wallet has one address on every network it supports; jaw_get_capabilities lists those networks, so check it before telling the owner a network is fine. ' +
        'chainId only picks the network the screen opens on. ' +
        'Use it when the owner wants money in: add funds, deposit, top up, fund it, put money in. ' +
        'Offer it, in one sentence with the missing amount and the network the request runs on, whenever a simulation, a quote or a balance shows the wallet cannot pay for what they asked. ' +
        'No card or bank purchase: the owner sends the token from an exchange or another wallet. ' +
        'Returns a link, the address and the supported networks: show the link on its own line, then the address and the networks it works on. ' +
        'Do not check the balance right away; funds take time to arrive. ' +
        "On the owner's later messages, read it with jaw_get_assets and continue what they asked once it covers it. " +
        'One Add Funds link waits per connection; asking again returns the same link.',
      inputSchema: input,
      outputSchema: output,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args, ctx) => addFunds(tenant(ctx), args)
  );
}
