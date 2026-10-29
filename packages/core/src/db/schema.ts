import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
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
    status: connectionStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connections_provider_team_user_uq').on(t.provider, t.teamId, t.userId)],
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

export const destinationKind = pgEnum('destination_kind', ['http'])

export const destinations = pgTable('destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: destinationKind('kind').notNull().default('http'),
  url: text('url').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  maxAttempts: integer('max_attempts').notNull().default(8),
  timeoutMs: integer('timeout_ms').notNull().default(10000),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const routes = pgTable('routes', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  connectionId: uuid('connection_id').references(() => connections.id),
  eventType: text('event_type').notNull(),
  textContains: text('text_contains'),
  textRegex: text('text_regex'),
  includeSubtypes: boolean('include_subtypes').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

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
  },
  (t) => [
    uniqueIndex('deliveries_event_route_destination_uq').on(t.eventId, t.routeId, t.destinationId),
    index('deliveries_status_idx').on(t.status, t.createdAt),
  ],
)

export type ConnectionRow = typeof connections.$inferSelect
export type EventRow = typeof events.$inferSelect
export type CredentialKind = (typeof credentialKind.enumValues)[number]
export type DestinationRow = typeof destinations.$inferSelect
export type RouteRow = typeof routes.$inferSelect
export type DeliveryRow = typeof deliveries.$inferSelect
