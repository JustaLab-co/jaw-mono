import { clientIdentity, connectionsSignInTypedData, usdcForNetwork, type ClientIdentity } from '@jaw.id/agent';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { erc20Abi, isAddress, isHex, type Address } from 'viem';
import { readOnChain, type ReadPermission } from '@/approvals/page-api';
import { getDb } from '@/db/client';
import { auditEvents, connections, grants } from '@/db/schema';
import { outstandingRevokes } from '@/grants/store';
import { publicClientFor, verifyOnChain, type VerifySignature } from '@/lib/chain';
import { errorLabel, log } from '@/lib/edge';
import { FloatBusy, LOCK_WAIT_MS, lockTimedOut, withFloat } from '@/payments/float-lock';
import { config } from './config';
import { endConnection, ownedBy, type ConnectionRow } from './rows';

/** How far ahead a sign-in may expire: the page asks for ten minutes. */
export const SIGN_IN_MAX_MS = 15 * 60_000;
const RECENT_EVENTS = 10;

export type ReadFloats = (chainId: number, payers: Address[]) => Promise<(bigint | null)[]>;

export interface PageDeps {
  verify: VerifySignature;
  readPermission: ReadPermission;
  readFloats: ReadFloats;
  lockWaitMs?: number;
}

export interface ConnectionView {
  id: string;
  status: 'active' | 'expired' | 'revoked';
  chainId: number;
  client: ClientIdentity;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** The session address, which holds the float. Null before the first token exchange. */
  payer: Address | null;
  /** USDC base units in the payer, null when the chain could not be read. */
  float: string | null;
  budgets: {
    permissionId: string;
    allowance: string;
    period: string;
    expiresAt: string;
    state: 'active' | 'revoke_on_chain' | 'revoked' | 'expired';
  }[];
  events: { tool: string; outcome: string; requestId: string | null; at: string }[];
}

export type PageOutcome =
  | { kind: 'ok'; body: ConnectionView | ConnectionView[] }
  | { kind: 'invalid_request' | 'bad_signature' | 'verification_unavailable' | 'not_found' | 'busy' };
type Refusal = Exclude<PageOutcome, { kind: 'ok' }>;

const floatsOnChain: ReadFloats = async (chainId, payers) => {
  const usdc = usdcForNetwork(`eip155:${chainId}`);
  if (!usdc) return payers.map(() => null);
  const contracts = payers.map((payer) => ({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf' as const,
    args: [payer] as const,
  }));
  const results = await publicClientFor(chainId)
    .multicall({ contracts, allowFailure: true })
    .catch((err) => {
      log('error', { msg: 'float read unavailable', error: errorLabel(err) });
      return [];
    });
  return payers.map((_, i) => (results[i]?.status === 'success' ? results[i].result : null));
};

const DEFAULTS: PageDeps = { verify: verifyOnChain, readPermission: readOnChain, readFloats: floatsOnChain };

async function signedIn(post: unknown, verify: VerifySignature, now: Date): Promise<Address | Refusal> {
  const { account, chainId, expires, signature } = (post ?? {}) as Record<string, unknown>;
  if (typeof account !== 'string' || !isAddress(account) || !isHex(signature)) return { kind: 'invalid_request' };
  // The connections live on the server's chain, and an account's owners can differ between chains.
  if (chainId !== config().chain.id || typeof expires !== 'string') {
    return { kind: 'invalid_request' };
  }
  const left = new Date(expires).getTime() - now.getTime();
  if (!(left > 0 && left <= SIGN_IN_MAX_MS)) return { kind: 'invalid_request' };

  const typedData = connectionsSignInTypedData(chainId, { issuer: config().issuer, expires });
  const valid = await verify({
    chainId,
    address: account,
    payload: { type: 'typed_data', typedData },
    signature,
  }).catch((err) => {
    log('error', { msg: 'sign-in verification unavailable', error: errorLabel(err) });
    return undefined;
  });
  if (valid === undefined) return { kind: 'verification_unavailable' };
  return valid ? account : { kind: 'bad_signature' };
}

export async function listFromPage(post: unknown, deps = DEFAULTS, now = new Date()): Promise<PageOutcome> {
  const account = await signedIn(post, deps.verify, now);
  if (typeof account !== 'string') return account;
  const rows = await getDb()
    .select()
    .from(connections)
    .where(and(ownedBy(account), eq(connections.chainId, config().chain.id), ne(connections.status, 'pending')))
    .orderBy(desc(connections.createdAt));
  return { kind: 'ok', body: await viewsOf(rows, deps, now) };
}

export async function revokeFromPage(
  id: string,
  post: unknown,
  deps = DEFAULTS,
  now = new Date()
): Promise<PageOutcome> {
  const account = await signedIn(post, deps.verify, now);
  if (typeof account !== 'string') return account;
  // Read before the lock, so nobody can queue on the float of a connection that is not theirs.
  const [found] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), ownedBy(account), ne(connections.status, 'pending')));
  if (!found) return { kind: 'not_found' };
  let row: ConnectionRow | undefined = found;
  if (found.status !== 'revoked') {
    try {
      // After the funding turn in flight, so the float read below includes its refill.
      const waitMs = deps.lockWaitMs ?? LOCK_WAIT_MS;
      row = await withFloat(id, waitMs, (hold) =>
        hold.tx(async (tx) => {
          // A token rotation holding the row past the wait is busy too.
          await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
          return endConnection(id, account, now, tx);
        })
      );
    } catch (err) {
      if (err instanceof FloatBusy || lockTimedOut(err)) return { kind: 'busy' };
      throw err;
    }
  }
  if (!row) return { kind: 'not_found' };
  const [view] = await viewsOf([row], deps, now);
  return { kind: 'ok', body: view };
}

type GrantRow = typeof grants.$inferSelect;

function budgetState(g: GrantRow, outstanding: string[], now: Date): ConnectionView['budgets'][number]['state'] {
  if (outstanding.includes(g.permissionId)) return 'revoke_on_chain';
  if (g.revokedAt) return 'revoked';
  return g.expiresAt <= now ? 'expired' : 'active';
}

async function viewsOf(
  rows: (typeof connections.$inferSelect)[],
  deps: PageDeps,
  now: Date
): Promise<ConnectionView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // First, since it records the budgets the chain now shows revoked.
  const outstanding = await Promise.all(rows.map((r) => outstandingRevokes(r.id, deps.readPermission)));
  const [budgets, events, floats] = await Promise.all([
    getDb().select().from(grants).where(inArray(grants.connectionId, ids)).orderBy(desc(grants.createdAt)),
    recentEvents(ids),
    floatsOf(rows, deps.readFloats),
  ]);
  return rows.map((row, i) => ({
    id: row.id,
    status: row.status === 'active' && row.expiresAt <= now ? 'expired' : (row.status as ConnectionView['status']),
    chainId: row.chainId,
    client: clientIdentity(row.clientId, row.clientName),
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    payer: row.sessionAddress as Address | null,
    float: floats.get(row.id)?.toString() ?? null,
    budgets: budgets
      .filter((g) => g.connectionId === row.id)
      .map((g) => ({
        permissionId: g.permissionId,
        allowance: g.allowance,
        period: g.period,
        expiresAt: g.expiresAt.toISOString(),
        state: budgetState(g, outstanding[i], now),
      })),
    events: events
      .filter((e) => e.connectionId === row.id)
      .map((e) => ({ tool: e.tool, outcome: e.outcome, requestId: e.requestId, at: e.createdAt.toISOString() })),
  }));
}

// One query per connection, so each reads its newest rows off the index and stops at ten.
async function recentEvents(ids: string[]) {
  const perConnection = await Promise.all(
    ids.map((id) =>
      getDb()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.connectionId, id))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(RECENT_EVENTS)
    )
  );
  return perConnection.flat();
}

async function floatsOf(rows: (typeof connections.$inferSelect)[], read: ReadFloats): Promise<Map<string, bigint>> {
  const floats = new Map<string, bigint>();
  for (const chainId of new Set(rows.map((r) => r.chainId))) {
    const funded = rows.filter((r) => r.chainId === chainId && r.sessionAddress);
    const balances = await read(
      chainId,
      funded.map((r) => r.sessionAddress as Address)
    );
    funded.forEach((r, i) => balances[i] !== null && floats.set(r.id, balances[i]));
  }
  return floats;
}

const STATUS: Record<PageOutcome['kind'], number> = {
  ok: 200,
  invalid_request: 400,
  bad_signature: 403,
  not_found: 404,
  busy: 409,
  verification_unavailable: 503,
};

export function pageResponse(outcome: PageOutcome): Response {
  const body = outcome.kind === 'ok' ? outcome.body : { error: outcome.kind };
  return Response.json(body, { status: STATUS[outcome.kind] });
}
