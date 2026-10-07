import { createHash } from 'node:crypto';
import { hasUnstorableText } from '@jaw.id/agent';
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import Provider, { errors, type Adapter, type AdapterPayload, type KoaContextWithOIDC } from 'oidc-provider';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { getDb } from '@/db/client';
import { oauthPayloads } from '@/db/schema';
import { revokeByGrant, setSessionAddress } from './rows';
import { unwrap, wrap, type KeyRing, type Wrapped } from './seal';

// A client whose refresh response was lost retries with the token it still holds.
export const RETRY_WINDOW_MS = 60_000;

// Request parameters land in jsonb, which refuses NUL and unpaired surrogates.
const unstorable = (value: unknown): boolean =>
  typeof value === 'string'
    ? hasUnstorableText(value)
    : typeof value === 'object' && value !== null && Object.values(value).some(unstorable);

const notExpired = or(isNull(oauthPayloads.expiresAt), gt(oauthPayloads.expiresAt, sql`now()`));

// The key a token request issues for, made by whichever token the provider
// saves first: the access token in a code exchange, the refresh token in a refresh.
const requestKeys = new WeakMap<object, Hex>();
// Requests whose find saw a used token it may retry. One that saw the token
// live and lost the race to its own sibling is refused, not taken for a retry.
const retries = new WeakSet<object>();

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
    const [row] = await getDb()
      .select()
      .from(oauthPayloads)
      .where(and(eq(oauthPayloads.key, this.key(id)), notExpired));
    if (!row) return undefined;
    const payload = { ...(row.payload as AdapterPayload), jti: id };
    if (!row.consumedAt) return payload;
    if (await this.retryable(row)) retries.add(requestContext());
    else payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return payload;
  }

  // Used once, but within the window and with its successor still unused: the
  // client never saw the successor, so this is a retry and not a replay.
  private async retryable(row: typeof oauthPayloads.$inferSelect): Promise<boolean> {
    if (!row.successorKey || Date.now() - row.consumedAt!.getTime() >= RETRY_WINDOW_MS) return false;
    const [successor] = await getDb()
      .select({ consumedAt: oauthPayloads.consumedAt })
      .from(oauthPayloads)
      .where(eq(oauthPayloads.key, row.successorKey));
    return successor !== undefined && successor.consumedAt === null;
  }

  // One transaction consumes the presented token and stores its successor with
  // the key wrapped under it, so a failure anywhere leaves the presented token usable.
  // A retry consumes the successor it replaces instead, which makes that one a replay.
  private async rotate(id: string, row: Omit<typeof oauthPayloads.$inferInsert, 'key'>) {
    const ctx = requestContext();
    const connectionId = (row.payload as AdapterPayload).accountId!;
    const presented = ctx.oidc.entities.RotatedRefreshToken?.jti;
    await getDb().transaction(async (tx) => {
      // A used token past its window can never be retried, so its wrap would only
      // serve whoever kept the old token. Swept on every rotation, for every grant.
      await tx
        .update(oauthPayloads)
        .set({ keyWrap: null })
        .where(
          and(
            eq(oauthPayloads.model, 'RefreshToken'),
            lt(oauthPayloads.consumedAt, new Date(Date.now() - RETRY_WINDOW_MS)),
            isNotNull(oauthPayloads.keyWrap)
          )
        );
      let key = requestKeys.get(ctx);
      if (presented) {
        const [from] = await tx
          .select()
          .from(oauthPayloads)
          .where(eq(oauthPayloads.key, this.key(presented)));
        if (!from?.keyWrap) throw new errors.InvalidGrant('refresh token holds no key');
        key = unwrap(this.ring, from.keyWrap as Wrapped, connectionId, presented);
        const retry = from.consumedAt !== null;
        if (retry && !retries.has(ctx)) throw new errors.InvalidGrant('grant already used');
        // The replaced successor never reached the client, so its wrap goes with it.
        const consumed = await tx
          .update(oauthPayloads)
          .set(retry ? { consumedAt: new Date(), keyWrap: null } : { consumedAt: new Date() })
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
