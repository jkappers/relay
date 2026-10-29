import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { createActionExecutor, deriveReplyTokenKey, PROMETHEUS_CONTENT_TYPE, type Cipher, type ConnectionStore, type Db, type Queue } from '@relay/core'
import { createSlackAdapter, createSlackRuntime } from '@relay/provider-slack'
import { createWebhookAdapter, createWebhookRuntime } from '@relay/provider-webhook'
import { actionsRoutes } from './actions'
import { scryptHasher, type PasswordHasher } from './accounts/password'
import { consoleApi, sessionUser } from './console/api'
import { createSessionStore } from './console/session'
import { consoleHeaders, consoleStatic } from './console/static'
import type { ServerConfig } from './config'
import { ingressHandler } from './ingress'
import type { ServerMetrics } from './metrics'
import { slackOAuthRoutes } from './oauth'
import { deriveStateKey } from './oauth-state'

export interface AppDeps {
  config: Pick<ServerConfig, 'PUBLIC_URL' | 'SLACK_SIGNING_SECRET' | 'SLACK_CLIENT_ID' | 'SLACK_CLIENT_SECRET' | 'SLACK_ALLOWED_USER_IDS' | 'RELAY_MASTER_KEY' | 'SIGNUP_MODE'> & Partial<Pick<ServerConfig, 'SLACK_API_BASE_URL'>>
  db: Db
  queue: Queue
  connections: ConnectionStore
  cipher: Cipher
  consoleDistDir?: string
  metrics: ServerMetrics
  fetch?: typeof fetch
  nowSeconds?: () => number
  hasher?: PasswordHasher
}

export function createApp(deps: AppDeps) {
  const clock = deps.nowSeconds ? { nowSeconds: deps.nowSeconds } : {}
  const slack = createSlackAdapter({ signingSecret: deps.config.SLACK_SIGNING_SECRET, connections: deps.connections, ...clock })
  const webhook = createWebhookAdapter({ connections: deps.connections, ...clock })
  const runtimes = {
    slack: createSlackRuntime({ db: deps.db, ...(deps.config.SLACK_API_BASE_URL ? { apiBase: deps.config.SLACK_API_BASE_URL } : {}) }),
    webhook: createWebhookRuntime(),
  }
  const execute = createActionExecutor({
    db: deps.db,
    connections: deps.connections,
    runtimes,
    counters: deps.metrics,
  })
  const ingressDeps = { db: deps.db, queue: deps.queue, metrics: deps.metrics }

  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const sessions = createSessionStore(deps.db, nowSeconds)
  const distDir = deps.consoleDistDir ?? fileURLToPath(new URL('../../console/dist', import.meta.url))

  return new Hono()
    .use('*', consoleHeaders)
    .get('/healthz', async (c) => {
      try {
        await deps.db.execute(sql`select 1`)
        return c.json({ ok: true })
      } catch {
        return c.json({ ok: false }, 503)
      }
    })
    .get('/metrics', (c) => c.body(deps.metrics.registry.render(), 200, { 'content-type': PROMETHEUS_CONTENT_TYPE }))
    .post('/hooks/slack', ingressHandler(slack, ingressDeps))
    .post('/hooks/webhook/:connectionId', ingressHandler(webhook, ingressDeps))
    .route(
      '/actions',
      actionsRoutes({
        db: deps.db,
        replyKey: deriveReplyTokenKey(deps.config.RELAY_MASTER_KEY),
        runtimes,
        execute,
        metrics: deps.metrics,
        ...clock,
      }),
    )
    .route(
      '/api',
      consoleApi({
        db: deps.db,
        queue: deps.queue,
        cipher: deps.cipher,
        connections: deps.connections,
        runtimes,
        metrics: deps.metrics,
        sessions,
        hasher: deps.hasher ?? scryptHasher,
        signupMode: deps.config.SIGNUP_MODE,
        publicUrl: deps.config.PUBLIC_URL,
        nowSeconds,
      }),
    )
    .route(
      '/oauth/slack',
      slackOAuthRoutes({
        clientId: deps.config.SLACK_CLIENT_ID,
        clientSecret: deps.config.SLACK_CLIENT_SECRET,
        allowedUserIds: deps.config.SLACK_ALLOWED_USER_IDS,
        publicUrl: deps.config.PUBLIC_URL,
        stateKey: deriveStateKey(deps.config.RELAY_MASTER_KEY),
        connections: deps.connections,
        metrics: deps.metrics,
        sessionUser: sessionUser(sessions),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...clock,
      }),
    )
    .route('/', consoleStatic(distDir))
}
