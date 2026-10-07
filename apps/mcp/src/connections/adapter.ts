import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { getDb } from '@/db/client';
import { oauthPayloads } from '@/db/schema';

const notExpired = or(isNull(oauthPayloads.expiresAt), gt(oauthPayloads.expiresAt, sql`now()`));

/** node-oidc-provider storage on one table. Ids are hashed before they reach the database. */
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
    // Only Session is looked up by uid, and its id is not stored; the provider needs it back.
    return row ? (row.payload as AdapterPayload) : undefined;
  }

  async findByUserCode() {
    return undefined;
  }

  async consume(id: string) {
    await getDb()
      .update(oauthPayloads)
      .set({ consumedAt: new Date() })
      .where(eq(oauthPayloads.key, this.key(id)));
  }

  async destroy(id: string) {
    await getDb()
      .delete(oauthPayloads)
      .where(eq(oauthPayloads.key, this.key(id)));
  }

  async revokeByGrantId(grantId: string) {
    await getDb().delete(oauthPayloads).where(eq(oauthPayloads.grantId, grantId));
  }
}
