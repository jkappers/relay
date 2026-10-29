import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { PROMETHEUS_CONTENT_TYPE, type ConnectionStore, type Db, type Queue } from '@relay/core'
import { createSlackAdapter } from '@relay/provider-slack'
import { createWebhookAdapter } from '@relay/provider-webhook'
import type { ServerConfig } from './config'
import { ingressHandler } from './ingress'
import type { ServerMetrics } from './metrics'
import { slackOAuthRoutes } from './oauth'
import { deriveStateKey } from './oauth-state'

export interface AppDeps {
  config: Pick<ServerConfig, 'PUBLIC_URL' | 'SLACK_SIGNING_SECRET' | 'SLACK_CLIENT_ID' | 'SLACK_CLIENT_SECRET' | 'SLACK_ALLOWED_USER_IDS' | 'RELAY_MASTER_KEY'>
  db: Db
  queue: Queue
  connections: ConnectionStore
  metrics: ServerMetrics
  fetch?: typeof fetch
  nowSeconds?: () => number
}

export function createApp(deps: AppDeps) {
  const clock = deps.nowSeconds ? { nowSeconds: deps.nowSeconds } : {}
  const slack = createSlackAdapter({ signingSecret: deps.config.SLACK_SIGNING_SECRET, connections: deps.connections, ...clock })
  const webhook = createWebhookAdapter({ connections: deps.connections, ...clock })
  const ingressDeps = { db: deps.db, queue: deps.queue, metrics: deps.metrics }

  return new Hono()
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
      '/oauth/slack',
      slackOAuthRoutes({
        clientId: deps.config.SLACK_CLIENT_ID,
        clientSecret: deps.config.SLACK_CLIENT_SECRET,
        allowedUserIds: deps.config.SLACK_ALLOWED_USER_IDS,
        publicUrl: deps.config.PUBLIC_URL,
        stateKey: deriveStateKey(deps.config.RELAY_MASTER_KEY),
        connections: deps.connections,
        metrics: deps.metrics,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...clock,
      }),
    )
}
