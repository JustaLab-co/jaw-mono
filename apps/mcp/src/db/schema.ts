import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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
    sessionAddress: text('session_address').notNull(),
    sealedKey: text('sealed_key').notNull(),
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
    permissionId: text('permission_id'),
  },
  (t) => [
    index().on(t.connectionId, t.createdAt),
    check(
      'approval_evidence',
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null and ${t.previewHash} is null and ${t.payloadHash} is null)`
    ),
    // A decision carries one proof: a signature with its assertion, or a permission approved on chain.
    check(
      'approval_proof',
      sql`(${t.status} = 'pending' and ${t.signature} is null and ${t.assertionRef} is null and ${t.permissionId} is null)
        or (${t.status} <> 'pending' and (${t.signature} is null) = (${t.assertionRef} is null) and (${t.signature} is null) <> (${t.permissionId} is null))`
    ),
  ]
);

// One row per budget the account approved on chain. The newest live one is the connection's budget.
export const grants = pgTable(
  'grants',
  {
    permissionId: text('permission_id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvalRequests.id),
    chainId: integer('chain_id').notNull(),
    account: text('account').notNull(),
    spender: text('spender').notNull(),
    token: text('token').notNull(),
    allowance: text('allowance').notNull(),
    period: text('period', { enum: ['day'] }).notNull(),
    // The struct as approved: the permission manager answers only about a struct, never an id.
    permission: jsonb('permission').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.connectionId, t.createdAt)]
);

// One row per payment attempt, updated in place and never deleted. A trigger
// (migration 0004) freezes settled and failed rows and the signed fields.
export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    permissionId: text('permission_id').notNull(),
    payer: text('payer').notNull(),
    url: text('url').notNull(),
    state: text('state', { enum: ['pending', 'signed', 'settled', 'failed', 'unknown'] })
      .notNull()
      .default('pending'),
    kind: text('kind', { enum: ['free', 'paid', 'refused', 'failed'] }),
    code: text('code'),
    leaseToken: text('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
    reserved: numeric('reserved', { precision: 78, scale: 0 }),
    scheme: text('scheme'),
    asset: text('asset'),
    network: text('network'),
    payTo: text('pay_to'),
    nonce: text('nonce'),
    authorized: numeric('authorized', { precision: 78, scale: 0 }),
    amount: numeric('amount', { precision: 78, scale: 0 }),
    deadline: timestamp('deadline', { withTimezone: true }),
    authorization: jsonb('authorization'),
    txHash: text('tx_hash'),
    blockTime: timestamp('block_time', { withTimezone: true }),
    topUpAmount: numeric('top_up_amount', { precision: 78, scale: 0 }),
    topUpBatchId: text('top_up_batch_id'),
    approvalBatchId: text('approval_batch_id'),
    httpStatus: integer('http_status'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.connectionId, t.idempotencyKey),
    uniqueIndex().on(t.payer, t.nonce),
    index().on(t.connectionId, t.createdAt, t.id),
    index().on(t.permissionId, t.createdAt),
    index()
      .on(t.signedAt)
      .where(sql`${t.state} in ('signed', 'unknown')`),
    check(
      'payment_shape',
      sql`(${t.state} = 'pending' and ${t.nonce} is null and ${t.authorization} is null and ${t.result} is null)
        or (${t.state} in ('signed', 'unknown') and ${t.nonce} is not null and ${t.authorization} is not null
            and ${t.authorized} is not null and ${t.deadline} is not null and ${t.signedAt} is not null)
        or (${t.state} = 'settled' and ${t.kind} = 'free' and ${t.nonce} is null)
        or (${t.state} = 'settled' and ${t.nonce} is not null and ${t.txHash} is not null and ${t.blockTime} is not null)
        or (${t.state} = 'failed' and ${t.finishedAt} is not null)`
    ),
  ]
);
