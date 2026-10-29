import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const connectionStatus = pgEnum('connection_status', ['active', 'revoked'])

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    teamId: text('team_id'),
    userId: text('user_id'),
    name: text('name'),
    status: connectionStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connections_provider_team_user_uq').on(t.provider, t.teamId, t.userId)],
)

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const memberRole = pgEnum('member_role', ['owner'])

export const connectionMembers = pgTable(
  'connection_members',
  {
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.userId] }), index('connection_members_user_idx').on(t.userId)],
)

export const credentialKind = pgEnum('credential_kind', ['slack_user_token', 'webhook_secret'])

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    kind: credentialKind('kind').notNull(),
    ciphertext: text('ciphertext').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credentials_connection_kind_uq').on(t.connectionId, t.kind)],
)

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    dedupKey: text('dedup_key').notNull(),
    raw: jsonb('raw').notNull(),
    envelope: jsonb('envelope').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    routedAt: timestamp('routed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('events_provider_dedup_key_uq').on(t.provider, t.dedupKey),
    index('events_connection_received_idx').on(t.connectionId, t.receivedAt),
    index('events_unenqueued_idx').on(t.receivedAt).where(sql`${t.enqueuedAt} is null`),
  ],
)

export const destinationKind = pgEnum('destination_kind', ['http', 'agent'])

export const destinations = pgTable(
  'destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    name: text('name').notNull(),
    kind: destinationKind('kind').notNull().default('http'),
    url: text('url'),
    secretCiphertext: text('secret_ciphertext'),
    enabled: boolean('enabled').notNull().default(true),
    maxAttempts: integer('max_attempts').notNull().default(8),
    timeoutMs: integer('timeout_ms').notNull().default(10000),
    allowedActions: text('allowed_actions').array(),
    config: jsonb('config'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('destinations_connection_idx').on(t.connectionId),
    check('destinations_http_needs_url_and_secret', sql`${t.kind} <> 'http' or (${t.url} is not null and ${t.secretCiphertext} is not null)`),
  ],
)

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    eventType: text('event_type').notNull(),
    textContains: text('text_contains'),
    textRegex: text('text_regex'),
    includeSubtypes: boolean('include_subtypes').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('routes_connection_idx').on(t.connectionId)],
)

export const routeDestinations = pgTable(
  'route_destinations',
  {
    routeId: uuid('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => destinations.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.routeId, t.destinationId] })],
)

export const deliveryStatus = pgEnum('delivery_status', ['pending', 'succeeded', 'failed'])

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    routeId: uuid('route_id')
      .notNull()
      .references(() => routes.id),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => destinations.id),
    status: deliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    responseBody: jsonb('response_body'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastReplyJti: text('last_reply_jti'),
    actionsDoneAt: timestamp('actions_done_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('deliveries_event_route_destination_uq').on(t.eventId, t.routeId, t.destinationId),
    index('deliveries_status_idx').on(t.status, t.createdAt),
  ],
)

export const actionStatus = pgEnum('action_status', ['pending', 'succeeded', 'failed'])

export const actionsLog = pgTable(
  'actions_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    idempotencyKey: text('idempotency_key').notNull(),
    type: text('type').notNull(),
    params: jsonb('params').notNull(),
    status: actionStatus('status').notNull().default('pending'),
    result: jsonb('result'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('actions_log_delivery_key_uq').on(t.deliveryId, t.idempotencyKey)],
)

export const sentMessages = pgTable(
  'sent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    ts: text('ts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sent_messages_connection_channel_ts_uq').on(t.connectionId, t.channel, t.ts)],
)

export const agentRunStatus = pgEnum('agent_run_status', ['running', 'succeeded', 'failed'])

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id')
    .notNull()
    .unique()
    .references(() => deliveries.id),
  status: agentRunStatus('status').notNull().default('running'),
  attempts: integer('attempts').notNull().default(1),
  mutated: boolean('mutated').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  turns: integer('turns').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  finalText: text('final_text'),
  toolCalls: jsonb('tool_calls').notNull().default(sql`'[]'::jsonb`),
  error: text('error'),
})

export const revokedTokens = pgTable('revoked_tokens', {
  jti: text('jti').primaryKey(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
})

export type UserRow = typeof users.$inferSelect
export type ConnectionRow = typeof connections.$inferSelect
export type EventRow = typeof events.$inferSelect
export type CredentialKind = (typeof credentialKind.enumValues)[number]
export type DestinationRow = typeof destinations.$inferSelect
export type AgentRunRow = typeof agentRuns.$inferSelect
export type RouteRow = typeof routes.$inferSelect
export type DeliveryRow = typeof deliveries.$inferSelect
