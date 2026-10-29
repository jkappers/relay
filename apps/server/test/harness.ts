import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import {
  createCipher,
  createConnectionStore,
  createDb,
  PgBossQueue,
  QUEUES,
  type ConnectionStore,
  type Db,
} from '@relay/core'
import { resetDb, startSlackStub, TEST_DATABASE_URL, TEST_MASTER_KEY, type SlackStub } from '@relay/core/testing'
import { computeSlackSignature } from '@relay/provider-slack'
import { computeWebhookSignature } from '@relay/provider-webhook'
import { afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { createApp } from '../src/app'
import { createServerMetrics, type ServerMetrics } from '../src/metrics'

export const SIGNING_SECRET = 'test-signing-secret'
export const PUBLIC_URL = 'http://relay.test'

export interface Harness {
  db: Db
  queue: PgBossQueue
  connections: ConnectionStore
  metrics: ServerMetrics
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  app: ReturnType<typeof createApp>
  slack: SlackStub
}

export function useHarness(): Harness {
  const h = {} as Harness
  let close: () => Promise<void>

  beforeAll(async () => {
    const handle = createDb(TEST_DATABASE_URL, { max: 5 })
    h.db = handle.db
    close = handle.close
    h.connections = createConnectionStore(h.db, await createCipher(TEST_MASTER_KEY))
    h.queue = new PgBossQueue(TEST_DATABASE_URL)
    await h.queue.start()
    await h.queue.ensureQueue(QUEUES.route)
    h.slack = await startSlackStub()
  })

  beforeEach(async () => {
    await resetDb(h.db)
    h.slack.reset()
    h.metrics = createServerMetrics()
    h.fetch = vi.fn<typeof fetch>()
    h.app = createApp({
      config: {
        PUBLIC_URL,
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
        SLACK_CLIENT_ID: 'client-id',
        SLACK_CLIENT_SECRET: 'client-secret',
        SLACK_ALLOWED_USER_IDS: ['U065VRX1T0'],
        RELAY_MASTER_KEY: TEST_MASTER_KEY,
        SLACK_API_BASE_URL: h.slack.url,
      },
      db: h.db,
      queue: h.queue,
      connections: h.connections,
      metrics: h.metrics,
      fetch: h.fetch,
    })
  })

  afterAll(async () => {
    await h.slack?.close()
    await h.queue?.stop()
    await close?.()
  })

  return h
}

export function slackFixture(name: string): Record<string, unknown> {
  const url = new URL(`../../../packages/providers/slack/test/fixtures/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8'))
}

export function slackRequest(app: Harness['app'], body: string, opts: { secret?: string; timestamp?: number } = {}) {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000))
  return app.request('/hooks/slack', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': computeSlackSignature(opts.secret ?? SIGNING_SECRET, ts, body),
    },
    body,
  })
}

export function webhookRequest(
  app: Harness['app'],
  connectionId: string,
  secret: string,
  body: string,
  opts: { eventId?: string; timestamp?: number; signature?: string } = {},
) {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000))
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-relay-timestamp': ts,
    'x-relay-signature': opts.signature ?? computeWebhookSignature(secret, ts, body),
  }
  if (opts.eventId) headers['x-relay-event-id'] = opts.eventId
  return app.request(`/hooks/webhook/${connectionId}`, { method: 'POST', headers, body })
}

export async function routeJobCount(db: Db, eventId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.route} and data->>'eventId' = ${eventId}`,
  )
  return rows[0]?.n ?? 0
}
