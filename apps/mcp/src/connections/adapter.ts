import { createHash } from 'node:crypto';
import { hasUnstorableText } from '@jaw.id/agent';
import { and, eq, gt, isNotNull, isNull, lt, or, sql, inArray } from 'drizzle-orm';
import Provider, { errors, type Adapter, type AdapterPayload, type KoaContextWithOIDC } from 'oidc-provider';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { getDb } from '@/db/client';
import { connections, oauthPayloads } from '@/db/schema';
import { errorLabel, log } from '@/lib/edge';
import { revokeByGrant, setSessionAddress } from './rows';
import { unwrap, wrap, type KeyRing, type Wrapped } from './seal';

// A client whose refresh response was lost retries with the token it still holds.
// Judged when find reads the token; the unused successor is what stops a replay.
export const RETRY_WINDOW_MS = 60_000;
// On the database clock, the one every replica shares.
const windowStart = sql.raw(`now() - interval '${RETRY_WINDOW_MS} milliseconds'`);

export const wrapPastWindow = and(
  eq(oauthPayloads.model, 'RefreshToken'),
  lt(oauthPayloads.consumedAt, windowStart),
  isNotNull(oauthPayloads.keyWrap)
);

// Request parameters land in jsonb, which refuses NUL and unpaired surrogates.
const unstorable = (value: unknown): boolean =>
  typeof value === 'string'
    ? hasUnstorableText(value)
    : typeof value === 'object' && value !== null && Object.values(value).some(unstorable);

const notExpired = or(isNull(oauthPayloads.expiresAt), gt(oauthPayloads.expiresAt, sql`now()`));

// The key a token request issues for, made by whichever token the provider
// saves first: the access token in a code exchange, the refresh token in a refresh.
const requestKeys = new WeakMap<object, Hex>();
// Requests whose find saw a used token it may retry, with the wrap it saw then,
// so a sweep running before the rotation cannot take it. One that saw the token
// live and lost the race to its own sibling is refused, not taken for a retry.
const retries = new WeakMap<object, Wrapped | null>();

function requestContext(): KoaContextWithOIDC {
  const ctx = Provider.ctx;
  if (!ctx) throw new Error('no token request in progress');
  return ctx;
}

export async function sessionKey(connectionId: string): Promise<Hex> {
  const ctx = requestContext();
  const known = requestKeys.get(ctx);
  if (known) return known;
  const key = generatePrivateKey();
  if (!(await setSessionAddress(connectionId, privateKeyToAddress(key)))) {
    throw new Error('connection already has a session key');
  }
  requestKeys.set(ctx, key);
  return key;
}

export class PgAdapter implements Adapter {
  constructor(
    private readonly model: string,
    private readonly ring: KeyRing
  ) {}

  private key(id: string) {
    return createHash('sha256').update(`${this.model}:${id}`).digest('hex');
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
    const stored = { ...payload };
    delete stored.jti;
    if (unstorable(stored)) throw new errors.InvalidRequest('the request contains characters that cannot be stored');
    const row = {
      model: this.model,
      payload: stored,
      grantId: payload.grantId ?? null,
      uid: payload.uid ?? null,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    };
    if (this.model === 'RefreshToken') return this.rotate(id, row);
    await getDb()
      .insert(oauthPayloads)
      .values({ key: this.key(id), ...row })
      .onConflictDoUpdate({ target: oauthPayloads.key, set: row });
  }

  async find(id: string) {
    // Used once, but within the window and with its successor still unused: the
    // client never saw the successor, so this is a retry and not a replay.
    const [found] = await getDb()
      .select({
        row: oauthPayloads,
        retryable: sql<boolean>`oauth_payloads.consumed_at > ${windowStart} and exists (
          select 1 from oauth_payloads s where s.key = oauth_payloads.successor_key and s.consumed_at is null)`,
      })
      .from(oauthPayloads)
      .where(and(eq(oauthPayloads.key, this.key(id)), notExpired));
    if (!found) return undefined;
    const { row, retryable } = found;
    const payload = { ...(row.payload as AdapterPayload), jti: id };
    if (!row.consumedAt) return payload;
    if (retryable) retries.set(requestContext(), row.keyWrap as Wrapped | null);
    else payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return payload;
  }

  // One transaction consumes the presented token and stores its successor with
  // the key wrapped under it, so a failure anywhere leaves the presented token usable.
  // A retry consumes the successor it replaces instead, which makes that one a replay.
  private async rotate(id: string, row: Omit<typeof oauthPayloads.$inferInsert, 'key'>) {
    const ctx = requestContext();
    const connectionId = (row.payload as AdapterPayload).accountId!;
    const presented = ctx.oidc.entities.RotatedRefreshToken?.jti;
    await getDb().transaction(async (tx) => {
      // Ending a connection locks its row before deleting the tokens, so a rotation
      // either commits first and is deleted with them, or sees the connection ended.
      const [live] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, connectionId), eq(connections.status, 'active')))
        .for('share');
      if (!live) throw new errors.InvalidGrant('connection ended');
      let key = requestKeys.get(ctx);
      if (presented) {
        const [from] = await tx
          .select()
          .from(oauthPayloads)
          .where(eq(oauthPayloads.key, this.key(presented)));
        if (!from) throw new errors.InvalidGrant('refresh token not found');
        const retry = from.consumedAt !== null;
        if (retry && !retries.has(ctx)) throw new errors.InvalidGrant('grant already used');
        const wrapped = retry ? retries.get(ctx) : (from.keyWrap as Wrapped | null);
        if (!wrapped) throw new errors.InvalidGrant('refresh token holds no key');
        key = unwrap(this.ring, wrapped, connectionId, presented);
        // Taken after the lock wait, which then does not shorten the client's window.
        const consumedAt = sql`statement_timestamp()`;
        // The replaced successor never reached the client, so its wrap goes with it.
        const consumed = await tx
          .update(oauthPayloads)
          .set(retry ? { consumedAt, keyWrap: null } : { consumedAt })
          .where(
            and(eq(oauthPayloads.key, (retry ? from.successorKey : from.key) ?? ''), isNull(oauthPayloads.consumedAt))
          )
          .returning({ key: oauthPayloads.key });
        if (consumed.length === 0) throw new errors.InvalidGrant('grant already used');
        // Using a token ends its predecessor's retry window, and with it the need for that wrap.
        if (!retry)
          await tx.update(oauthPayloads).set({ keyWrap: null }).where(eq(oauthPayloads.successorKey, from.key));
        await tx
          .update(oauthPayloads)
          .set({ successorKey: this.key(id) })
          .where(eq(oauthPayloads.key, from.key));
      }
      if (!key) throw new Error('no session key for this refresh token');
      await tx
        .insert(oauthPayloads)
        .values({ key: this.key(id), ...row, keyWrap: wrap(this.ring, key, connectionId, id) });
      requestKeys.set(ctx, key);
    });
    await sweepWraps();
  }

  async findByUid(uid: string) {
    const [row] = await getDb()
      .select()
      .from(oauthPayloads)
      .where(and(eq(oauthPayloads.model, this.model), eq(oauthPayloads.uid, uid), notExpired));
    // The raw session id is not stored. Only session-bound tokens look sessions
    // up by uid, and this server issues none.
    return row ? (row.payload as AdapterPayload) : undefined;
  }

  async findByUserCode() {
    return undefined;
  }

  // Conditional, so two requests racing with one code cannot both win. A refresh
  // token is consumed by the rotation that stores its successor.
  async consume(id: string) {
    if (this.model === 'RefreshToken') return;
    const rows = await getDb()
      .update(oauthPayloads)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthPayloads.key, this.key(id)), isNull(oauthPayloads.consumedAt)))
      .returning({ key: oauthPayloads.key });
    if (rows.length === 0) throw new errors.InvalidGrant('grant already used');
  }

  async destroy(id: string) {
    await getDb()
      .delete(oauthPayloads)
      .where(eq(oauthPayloads.key, this.key(id)));
    // The provider awaits this when it revokes a grant, so the connection dies with it.
    if (this.model === 'Grant') await revokeByGrant(id);
  }

  async revokeByGrantId(grantId: string) {
    await getDb().delete(oauthPayloads).where(eq(oauthPayloads.grantId, grantId));
  }
}

// A used token past its window can no longer start a retry, and an admitted one
// carries the wrap find read, so the stored wrap would only serve whoever kept
// the old token. Swept after every rotation, for every grant, and by the cron.
// Outside the rotation, which then locks only its own grant's rows; SKIP LOCKED
// leaves a row another request holds to the next sweep, so the sweep never waits
// and cannot deadlock. A failure is logged, never thrown: the rotation before it
// has committed and its client must get the new pair.
export async function sweepWraps(): Promise<void> {
  try {
    await getDb()
      .update(oauthPayloads)
      .set({ keyWrap: null })
      .where(
        inArray(
          oauthPayloads.key,
          getDb()
            .select({ key: oauthPayloads.key })
            .from(oauthPayloads)
            .where(wrapPastWindow)
            .for('update', { skipLocked: true })
        )
      );
  } catch (err) {
    log('error', { msg: 'wrap sweep failed', error: errorLabel(err) });
  }
}
