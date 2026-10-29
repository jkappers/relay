import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import {
  createCipher,
  createConnectionStore,
  createDb,
  PgBossQueue,
  QUEUES,
  type Cipher,
  type ConnectionStore,
  type Db,
} from '@relay/core'
import { resetDb, startSlackStub, TEST_DATABASE_URL, TEST_MASTER_KEY, type SlackStub } from '@relay/core/testing'
import { computeSlackSignature } from '@relay/provider-slack'
import { computeWebhookSignature } from '@relay/provider-webhook'
import { afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { scryptHasher } from '../src/accounts/password'
import { createUser } from '../src/accounts/users'
import { createApp } from '../src/app'
import { createServerMetrics, type ServerMetrics } from '../src/metrics'

export const SIGNING_SECRET = 'test-signing-secret'
export const PUBLIC_URL = 'http://relay.test'
export const PASSWORD = 'correct horse battery staple'
export const CSRF = { 'x-relay-console': '1' }
export const INDEX_HTML = '<!doctype html><title>console</title><div id="root"></div><script type="module" src="/assets/app.js"></script>'

export interface Harness {
  db: Db
  queue: PgBossQueue
  connections: ConnectionStore
  cipher: Cipher
  metrics: ServerMetrics
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  app: ReturnType<typeof createApp>
  slack: SlackStub
  distDir: string
}

export function useHarness(): Harness {
  const h = {} as Harness
  let close: () => Promise<void>

  beforeAll(async () => {
    const handle = createDb(TEST_DATABASE_URL, { max: 5 })
    h.db = handle.db
    close = handle.close
    h.cipher = await createCipher(TEST_MASTER_KEY)
    h.connections = createConnectionStore(h.db, h.cipher)
    h.queue = new PgBossQueue(TEST_DATABASE_URL)
    await h.queue.start()
    await h.queue.ensureQueue(QUEUES.route)
    await h.queue.ensureQueue(QUEUES.dispatch)
    h.distDir = mkdtempSync(join(tmpdir(), 'relay-console-dist-'))
    mkdirSync(join(h.distDir, 'assets'))
    writeFileSync(join(h.distDir, 'index.html'), INDEX_HTML)
    writeFileSync(join(h.distDir, 'assets', 'app.js'), 'console.log(1)')
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
        SIGNUP_MODE: 'closed',
        SLACK_API_BASE_URL: h.slack.url,
      },
      db: h.db,
      queue: h.queue,
      connections: h.connections,
      cipher: h.cipher,
      consoleDistDir: h.distDir,
      metrics: h.metrics,
      fetch: h.fetch,
    })
  })

  afterAll(async () => {
    if (h.distDir) rmSync(h.distDir, { recursive: true, force: true })
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

export async function login(app: Harness['app'], email: string, password = PASSWORD) {
  const res = await app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CSRF },
    body: JSON.stringify({ email, password }),
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  return { res, cookie }
}

export interface Api {
  (method: string, path: string, body?: unknown): Response | Promise<Response>
}

export function apiAs(app: Harness['app'], cookie: string): Api {
  return (method, path, body) =>
    app.request(path, {
      method,
      headers: { cookie, ...CSRF, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
}

export interface Account {
  userId: string
  email: string
  cookie: string
  api: Api
}

/** Creates a user, signs in through the API, and returns a client for that session. */
export async function signIn(h: Harness, email = 'owner@example.com'): Promise<Account> {
  const user = await createUser(h.db, scryptHasher, { email, password: PASSWORD })
  const { res, cookie } = await login(h.app, email)
  if (res.status !== 204) throw new Error(`login failed: ${res.status}`)
  return { userId: user.id, email, cookie, api: apiAs(h.app, cookie) }
}
