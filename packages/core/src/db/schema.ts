import { sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
  },
  (t) => [
    uniqueIndex('events_provider_dedup_key_uq').on(t.provider, t.dedupKey),
    index('events_connection_received_idx').on(t.connectionId, t.receivedAt),
    index('events_unenqueued_idx').on(t.receivedAt).where(sql`${t.enqueuedAt} is null`),
  ],
)

export type ConnectionRow = typeof connections.$inferSelect
export type EventRow = typeof events.$inferSelect
export type CredentialKind = (typeof credentialKind.enumValues)[number]
