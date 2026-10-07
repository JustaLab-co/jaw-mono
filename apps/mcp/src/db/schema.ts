import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })]
);

// Keys are sha256 of `${model}:${id}` and payloads carry no `jti`, so a dump
// holds no code, session or refresh token a client could present.
export const oauthPayloads = pgTable(
  'oauth_payloads',
  {
    key: text('key').primaryKey(),
    model: text('model').notNull(),
    payload: jsonb('payload').notNull(),
    grantId: text('grant_id'),
    uid: text('uid'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    // Refresh tokens only: the connection's session key, wrapped under this token.
    keyWrap: text('key_wrap'),
    // Refresh tokens only: the token issued from this one, so a retry can tell it was never used.
    successorKey: text('successor_key'),
  },
  (t) => [index().on(t.grantId), index().on(t.uid), index().on(t.expiresAt)]
);

export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    status: text('status', { enum: ['pending', 'active', 'revoked'] }).notNull(),
    account: text('account').notNull(),
    chainId: integer('chain_id').notNull(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name').notNull(),
    scopes: text('scopes').array().notNull(),
    // Null until the first token exchange creates the session key.
    sessionAddress: text('session_address'),
    interactionUid: text('interaction_uid').notNull().unique(),
    ticketHash: text('ticket_hash'),
    // Pending: the consent must be claimed before this. Active: the connection ends here.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    grantId: text('grant_id').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'connection_status_shape',
      sql`(${t.status} = 'pending' and ${t.ticketHash} is not null and ${t.grantId} is null)
        or (${t.status} = 'active' and ${t.ticketHash} is null and ${t.grantId} is not null and ${t.activatedAt} is not null)
        or (${t.status} = 'revoked' and ${t.ticketHash} is null and ${t.revokedAt} is not null)`
    ),
  ]
);

// Expiry is derived from expires_at, never written: the decision is the only
// update a row gets.
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    account: text('account').notNull(),
    chainId: integer('chain_id').notNull(),
    requester: text('requester').notNull(),
    requesterClientId: text('requester_client_id').notNull(),
    kind: text('kind').notNull(),
    body: jsonb('body').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    previewHash: text('preview_hash'),
    payloadHash: text('payload_hash'),
    signature: text('signature'),
    assertionRef: text('assertion_ref'),
  },
  (t) => [
    index().on(t.connectionId, t.createdAt),
    check(
      'approval_evidence',
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null and ${t.previewHash} is null and ${t.payloadHash} is null and ${t.signature} is null and ${t.assertionRef} is null)`
    ),
  ]
);
