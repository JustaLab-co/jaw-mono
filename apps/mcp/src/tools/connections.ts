import { usdcForNetwork, type ChainClients } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { erc20Abi, formatUnits, isAddressEqual, isHex, stringToHex, type Address } from 'viem';
import { z } from 'zod';
import { chainClients } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { ownerRelay, WalletBusy, type OpenWallet, type Wallet } from '@/connections/relay';
import { endConnection, ownedBy, TopUpInFlight, type ConnectionRow } from '@/connections/rows';
import { getDb } from '@/db/client';
import { connections, grants } from '@/db/schema';
import { FloatBusy, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import { LEASE_MS } from '@/payments/store';
import { verifyOnChain, type VerifySignature } from '@/lib/chain';
import { errorLabel, log } from '@/lib/edge';
import { refusal } from './reply';

const connectionView = z.object({
  id: z.string(),
  current: z.boolean().describe('The connection this call came from'),
  client: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(['active', 'expired', 'revoked']),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  payer: z.string().nullable().describe("The connection's session address, which holds its float"),
  budget: z
    .object({ permissionId: z.string(), perDay: z.string().describe('USDC base units'), expiresAt: z.string() })
    .nullable()
    .describe('The budget in force, if any'),
});

type View = z.infer<typeof connectionView>;

async function viewsOf(t: Tenant, rows: (typeof connections.$inferSelect)[]): Promise<View[]> {
  const ids = rows.map((r) => r.id);
  const budgets = ids.length
    ? await getDb().select().from(grants).where(inArray(grants.connectionId, ids)).orderBy(desc(grants.createdAt))
    : [];
  const now = new Date();
  return rows.map((row) => {
    // Newest first, so the first unreplaced one is the budget in force.
    const budget = budgets.find((g) => g.connectionId === row.id && !g.replacedAt && !g.revokedAt && g.expiresAt > now);
    return {
      id: row.id,
      current: row.id === t.connectionId,
      client: row.clientName,
      scopes: row.scopes,
      status: row.status === 'active' && row.expiresAt <= now ? 'expired' : (row.status as View['status']),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      payer: row.sessionAddress,
      budget: budget
        ? { permissionId: budget.permissionId, perDay: budget.allowance, expiresAt: budget.expiresAt.toISOString() }
        : null,
    };
  });
}

const reply = <T extends object>(summary: string, structured: T) => ({
  content: [{ type: 'text' as const, text: summary }],
  structuredContent: { ...structured, summary },
});

export function registerConnectionTools(server: McpServer) {
  server.registerTool(
    'jaw_connections',
    {
      description:
        "Every app connected to this account through this server, this one included, with each one's budget.",
      inputSchema: z.strictObject({}),
      outputSchema: z.object({ connections: z.array(connectionView), summary: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (_input, ctx) => {
      const t = tenant(ctx);
      const rows = await getDb()
        .select()
        .from(connections)
        .where(and(ownedBy(t.account), eq(connections.chainId, t.chainId), ne(connections.status, 'pending')))
        .orderBy(desc(connections.createdAt));
      const views = await viewsOf(t, rows);
      const live = views.filter((v) => v.status === 'active').length;
      return reply(`${views.length} connection(s), ${live} active.`, { connections: views });
    }
  );

  server.registerTool(
    'jaw_revoke_connection',
    {
      description:
        "End another app's connection to this account, once the owner confirms it in their wallet: its tokens stop working and its session key is gone, so its budget can no longer be spent. The float at its payer stays there, since only that key could move it; jaw_disconnect called from that app returns it instead. Returns a link for the owner; jaw_connections shows it revoked once they confirm. To end this connection, and return its float, use jaw_disconnect.",
      inputSchema: z.strictObject({ id: z.string().max(64).describe('From jaw_connections') }),
      outputSchema: z.object({
        url: z.url(),
        payer: z.string().describe("The other connection's session address"),
        left: z
          .string()
          .nullable()
          .describe('USDC base units at its payer, which stay there once it ends; null when unreadable'),
        summary: z.string(),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }, ctx) => revokeConnection(tenant(ctx), id)
  );
}

export interface RevokeDeps {
  openWallet: OpenWallet;
  verify: VerifySignature;
  clients: ChainClients;
}

const DEFAULTS: RevokeDeps = { openWallet: ownerRelay, verify: verifyOnChain, clients: chainClients };
const CONFIRM_WITHIN_MS = 10 * 60_000;
/** The link of the revoke still open, per connection it ends: asking again while it waits hands out the same one. */
const open = new Map<string, Promise<string | undefined>>();

/** The text the owner signs to end a connection. It names the connection, so it ends no other. */
export const revokeMessage = (row: { id: string; clientName: string }, account: Address, until: Date) =>
  [
    `Revoke ${row.clientName} on ${new URL(config().issuer).host}`,
    `Connection: ${row.id}`,
    '',
    `Account: ${account}`,
    `Expires: ${until.toISOString()}`,
  ].join('\n');

/**
 * Ending another app is the owner's call, not this connection's: any connection
 * can ask, and the owner confirms in their wallet with a signature over the
 * connection it ends.
 */
export async function revokeConnection(t: Tenant, id: string, deps = DEFAULTS) {
  if (id === t.connectionId)
    return refusal('That is this connection. Use jaw_disconnect, which also returns its float.');
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), ownedBy(t.account), eq(connections.status, 'active')));
  if (!row) return refusal('No active connection with that id for this account.');

  let asked = open.get(id);
  if (!asked) {
    asked = askOwner(t, row, deps);
    open.set(id, asked);
    // Without a session there is nothing to wait on, so the next call tries again.
    void asked.then(
      (url) => url ?? open.delete(id),
      () => open.delete(id)
    );
  }
  const url = await asked;
  if (!url) return refusal('Too many owners are approving right now. Try again in a minute.');

  const payer = row.sessionAddress as Address;
  const left = await floatAt(t.chainId, payer, deps.clients);
  const said = [
    `Ask the account owner to open ${url} and confirm ending ${row.clientName}.`,
    'jaw_connections shows it revoked once they do. Its budget stays approved on chain until it expires, with no key left to spend it.',
  ];
  // The key that could move it goes with the connection, and this server cannot open it.
  if (left === null) {
    said.push(
      `Whatever float is at ${payer} stays there once it ends; jaw_disconnect called from that app returns it.`
    );
  } else if (left > 0n) {
    said.push(
      `${formatUnits(left, 6)} USDC stays at ${payer} once it ends, and nothing can move it. To get it back, call jaw_disconnect from that app instead, if it still works.`
    );
  }
  const summary = said.join(' ');
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: { url, payer, left: left?.toString() ?? null, summary },
  };
}

/** Asks the owner to sign the revoke, and ends the connection once they do. Undefined when no session is free. */
async function askOwner(t: Tenant, row: ConnectionRow, deps: RevokeDeps): Promise<string | undefined> {
  const id = row.id;
  const until = new Date(Date.now() + CONFIRM_WITHIN_MS);
  let wallet: Wallet;
  try {
    wallet = await deps.openWallet(t.chainId, until);
  } catch (err) {
    if (err instanceof WalletBusy) return undefined;
    throw err;
  }
  void wallet
    .run(async (ask) => {
      const [account] = (await ask('eth_requestAccounts', [])) as unknown[];
      if (typeof account !== 'string' || !isAddressEqual(account as Address, t.account)) {
        throw new Error('the wallet is signed in to another account');
      }
      const message = revokeMessage(row, t.account, until);
      const signature = await ask('personal_sign', [stringToHex(message), account]);
      const valid =
        isHex(signature) &&
        (await deps.verify({
          chainId: t.chainId,
          address: t.account,
          payload: { type: 'message', message },
          signature,
        }));
      if (!valid) throw new Error('bad_signature');
      await endSigned(id, t.account);
    })
    .catch((err: unknown) => log('warn', { msg: 'connection not revoked', error: errorLabel(err) }))
    .finally(() => open.delete(id));
  return wallet.url;
}

const RETRY_MS = 1_000;

/**
 * Ends a connection the owner signed off, after the funding turn in flight, so
 * nothing is mid-refill when its key goes. A top-up still landing lasts at most
 * the lease of the payment that sent it, so it tries again until then.
 */
async function endSigned(id: string, account: Address) {
  const deadline = Date.now() + LEASE_MS;
  for (;;) {
    try {
      return await withFloat(id, LOCK_WAIT_MS, (hold) => hold.tx((tx) => endConnection(id, account, new Date(), tx)));
    } catch (err) {
      if (!(err instanceof TopUpInFlight || err instanceof FloatBusy) || Date.now() > deadline) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

async function floatAt(chainId: number, payer: Address, clients: ChainClients): Promise<bigint | null> {
  const usdc = usdcForNetwork(`eip155:${chainId}`);
  if (!usdc) return null;
  return clients
    .publicClient(chainId)
    .readContract({ address: usdc.address, abi: erc20Abi, functionName: 'balanceOf', args: [payer] })
    .catch(() => null);
}
