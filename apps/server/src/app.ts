import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { createActionExecutor, deriveReplyTokenKey, PROMETHEUS_CONTENT_TYPE, type Cipher, type ConnectionStore, type Db, type Queue } from '@relay/core'
import { createDiscordRuntime } from '@relay/provider-discord'
import { createSlackAdapter, createSlackRuntime } from '@relay/provider-slack'
import { createSmsAdapter, createSmsRuntime } from '@relay/provider-sms'
import { createWebhookAdapter, createWebhookRuntime } from '@relay/provider-webhook'
import { actionsRoutes } from './actions'
import { scryptHasher, type PasswordHasher } from './accounts/password'
import { consoleApi, sessionUser } from './console/api'
import { createSessionStore } from './console/session'
import { consoleHeaders, consoleStatic } from './console/static'
import type { ServerConfig } from './config'
import { ingressHandler } from './ingress'
import type { ServerMetrics } from './metrics'
import { discordOAuthProvider, oauthRoutes, slackOAuthProvider } from './oauth'
import { deriveStateKey } from './oauth-state'

export interface AppDeps {
  config: Pick<ServerConfig, 'PUBLIC_URL' | 'SLACK_ALLOWED_USER_IDS' | 'RELAY_MASTER_KEY' | 'SIGNUP_MODE'> &
    Partial<
      Pick<
        ServerConfig,
        | 'SLACK_API_BASE_URL'
        | 'SMS_API_BASE_URL'
        | 'SLACK_SIGNING_SECRET'
        | 'SLACK_CLIENT_ID'
        | 'SLACK_CLIENT_SECRET'
        | 'DISCORD_CLIENT_ID'
        | 'DISCORD_CLIENT_SECRET'
        | 'DISCORD_BOT_TOKEN'
        | 'DISCORD_API_BASE_URL'
        | 'DISCORD_ALLOWED_USER_IDS'
      >
    >
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
  const { SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } = deps.config
  const slackApp = SLACK_SIGNING_SECRET && SLACK_CLIENT_ID && SLACK_CLIENT_SECRET ? { signingSecret: SLACK_SIGNING_SECRET, clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET } : null
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } = deps.config
  const discordApp = DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET ? { clientId: DISCORD_CLIENT_ID, clientSecret: DISCORD_CLIENT_SECRET } : null
  const webhook = createWebhookAdapter({ connections: deps.connections, ...clock })
  const sms = createSmsAdapter({ connections: deps.connections, publicUrl: deps.config.PUBLIC_URL })
  const runtimes = {
    slack: createSlackRuntime({ db: deps.db, ...(deps.config.SLACK_API_BASE_URL ? { apiBase: deps.config.SLACK_API_BASE_URL } : {}) }),
    webhook: createWebhookRuntime(),
    sms: createSmsRuntime({ db: deps.db, ...(deps.config.SMS_API_BASE_URL ? { apiBase: deps.config.SMS_API_BASE_URL } : {}) }),
    discord: createDiscordRuntime({ db: deps.db, botToken: deps.config.DISCORD_BOT_TOKEN, apiBase: deps.config.DISCORD_API_BASE_URL }),
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

  const app = new Hono()
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
    .post('/hooks/webhook/:connectionId', ingressHandler(webhook, ingressDeps))
    .post('/hooks/sms/:connectionId', ingressHandler(sms, ingressDeps))
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
        providers: { slack: slackApp !== null, discord: discordApp !== null },
        nowSeconds,
      }),
    )

  const oauthDeps = {
    publicUrl: deps.config.PUBLIC_URL,
    stateKey: deriveStateKey(deps.config.RELAY_MASTER_KEY),
    metrics: deps.metrics,
    sessionUser: sessionUser(sessions),
    ...clock,
  }
  const fetchOpt = deps.fetch ? { fetch: deps.fetch } : {}

  if (slackApp) {
    const slack = createSlackAdapter({ signingSecret: slackApp.signingSecret, connections: deps.connections, ...clock })
    const provider = slackOAuthProvider({ ...slackApp, allowedUserIds: deps.config.SLACK_ALLOWED_USER_IDS, connections: deps.connections, ...fetchOpt })
    app.post('/hooks/slack', ingressHandler(slack, ingressDeps)).route('/oauth/slack', oauthRoutes(provider, oauthDeps))
  }
  if (discordApp) {
    const provider = discordOAuthProvider({
      ...discordApp,
      allowedUserIds: deps.config.DISCORD_ALLOWED_USER_IDS ?? [],
      connections: deps.connections,
      ...(deps.config.DISCORD_API_BASE_URL ? { apiBase: deps.config.DISCORD_API_BASE_URL } : {}),
      ...fetchOpt,
    })
    app.route('/oauth/discord', oauthRoutes(provider, oauthDeps))
  }

  return app.route('/', consoleStatic(distDir))
}
