import { sql } from 'drizzle-orm';
import {
  bigserial,
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
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index().on(t.windowStart)]
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
  (t) => [
    index().on(t.grantId),
    index().on(t.uid),
    index().on(t.expiresAt),
    // The wrap sweep on every refresh reads only rows that still hold a wrap.
    index('oauth_payloads_wrap_sweep_index')
      .on(t.consumedAt)
      .where(sql`${t.keyWrap} is not null`),
  ]
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
    permissionId: text('permission_id'),
    callsId: text('calls_id'),
    txHash: text('tx_hash'),
    // How to fetch a payment's resource again. Never loaded with the request: the agent's headers can carry secrets.
    sellerRequest: jsonb('seller_request'),
  },
  (t) => [
    index().on(t.connectionId, t.createdAt),
    // One userOp proves one approval.
    uniqueIndex()
      .on(t.callsId)
      .where(sql`${t.callsId} is not null`),
    check('approval_seller_request', sql`${t.kind} = 'payment' or ${t.sellerRequest} is null`),
    check(
      'approval_evidence',
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null and ${t.previewHash} is null and ${t.payloadHash} is null)`
    ),
    check(
      'approval_proof',
      sql`(${t.status} = 'pending' and ${t.signature} is null and ${t.assertionRef} is null and ${t.permissionId} is null and ${t.callsId} is null and ${t.txHash} is null)
        or (${t.status} <> 'pending' and (${t.signature} is null) = (${t.assertionRef} is null) and (${t.callsId} is null) = (${t.txHash} is null)
          and (${t.signature} is not null)::int + (${t.permissionId} is not null)::int + (${t.callsId} is not null)::int = 1)`
    ),
  ]
);

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
    // A newer budget was approved, so this one should be revoked; revokedAt once the chain shows it.
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index().on(t.connectionId, t.createdAt)]
);

export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    permissionId: text('permission_id'),
    // Set when the account owner approved paying this one request, instead of a budget.
    approvalId: text('approval_id').references(() => approvalRequests.id),
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
    // The fenced seller text the first answer carried, so a replay returns the same words.
    fenced: jsonb('fenced').$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    reconcilingUntil: timestamp('reconciling_until', { withTimezone: true }),
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.connectionId, t.idempotencyKey),
    uniqueIndex().on(t.payer, t.nonce),
    uniqueIndex()
      .on(t.approvalId)
      .where(sql`${t.approvalId} is not null`),
    index().on(t.connectionId, t.createdAt, t.id),
    index().on(t.permissionId, t.createdAt),
    index()
      .on(t.signedAt)
      .where(sql`${t.state} in ('signed', 'unknown')`),
    check('payment_source', sql`(${t.permissionId} is null) <> (${t.approvalId} is null)`),
    check(
      'payment_shape',
      sql`(${t.state} = 'pending' and ${t.nonce} is null and ${t.authorization} is null and ${t.fenced} is null)
        or (${t.state} in ('signed', 'unknown') and ${t.nonce} is not null and ${t.authorization} is not null
            and ${t.authorized} is not null and ${t.deadline} is not null and ${t.signedAt} is not null)
        or (${t.state} = 'settled' and ${t.kind} = 'free' and ${t.nonce} is null)
        or (${t.state} = 'settled' and ${t.kind} = 'paid' and ${t.nonce} is not null and ${t.amount} is not null)
        or (${t.state} = 'failed' and ${t.finishedAt} is not null)`
    ),
  ]
);

// One row per tool call. Arguments and results are never stored: they can carry
// seller headers, signatures and amounts the owner did not ask to keep.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    tool: text('tool').notNull(),
    outcome: text('outcome', { enum: ['ok', 'error'] }).notNull(),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.connectionId, t.createdAt)]
);
