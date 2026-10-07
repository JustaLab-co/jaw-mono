import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import { getDb } from '@/db/client';
import { oauthPayloads } from '@/db/schema';
import { revokeByGrant } from './rows';

const notExpired = or(isNull(oauthPayloads.expiresAt), gt(oauthPayloads.expiresAt, sql`now()`));

export class PgAdapter implements Adapter {
  constructor(private readonly model: string) {}

  private key(id: string) {
    return createHash('sha256').update(`${this.model}:${id}`).digest('hex');
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
    const stored = { ...payload };
    delete stored.jti;
    const row = {
      model: this.model,
      payload: stored,
      grantId: payload.grantId ?? null,
      uid: payload.uid ?? null,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    };
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
    if (row.consumedAt) payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return payload;
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

  // Conditional, so two requests racing with one refresh token or code cannot both win.
  async consume(id: string) {
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
