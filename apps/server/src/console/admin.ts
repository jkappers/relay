import { eq, sql } from 'drizzle-orm'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import {
  ClientIdChangeError,
  discordAppInput,
  log,
  PROVIDER_APP_IDS,
  ProviderAppFieldsError,
  schema,
  slackAppInput,
  type Db,
  type DiscordAppConfig,
  type ProviderAppEnv,
  type ProviderAppId,
  type ProviderAppStore,
  type SlackAppConfig,
} from '@relay/core'
import { DISCORD_USER_AGENT } from '@relay/provider-discord'
import { isAdmin } from '../accounts/users'
import type { ServerMetrics } from '../metrics'

export interface AdminApiDeps {
  db: Db
  metrics: ServerMetrics
  providerApps: ProviderAppStore
  providerAppEnv: ProviderAppEnv
  publicUrl: string
  slackApiBase: string
  discordApiBase: string
  fetch: typeof fetch
}

type Env = { Variables: { userId: string } }

const { providerApps, providerAppStatus, users } = schema

const SECRET_FIELDS = { slack: ['clientSecret', 'signingSecret'], discord: ['clientSecret', 'botToken'] } as const
const TEST_TIMEOUT_MS = 10_000
const SLACK_SENTINEL_CODE = 'relay-connection-test'

const providerParam = z.enum(PROVIDER_APP_IDS)
const confirm = { confirmClientIdChange: z.boolean().optional() }
const putBodies = {
  slack: z.strictObject({ ...slackAppInput.shape, ...confirm }),
  discord: z.strictObject({ ...discordAppInput.shape, ...confirm }),
}

type CheckName = 'client_id' | 'client_secret' | 'signing_secret' | 'bot_token' | 'application'
export interface TestCheck {
  check: CheckName
  result: 'ok' | 'failed' | 'error' | 'skipped'
  code?: string
}

const fieldNames = (issues: z.ZodError['issues']) => [...new Set(issues.map((i) => i.path.map(String).join('.') || '(body)'))]

export function publicUrlWarnings(publicUrl: string): string[] {
  const warnings: string[] = []
  let host = ''
  try {
    host = new URL(publicUrl).hostname
  } catch {
    return ['invalid']
  }
  if (!publicUrl.startsWith('https://')) warnings.push('not_https')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0' || /^127\./.test(host)) warnings.push('localhost')
  return warnings
}

const safeCode = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_.]{1,64}$/i.test(v) ? v : 'unexpected_response')
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

export function adminApi(deps: AdminApiDeps) {
  const { db, metrics, providerApps: store } = deps
  const base = (u: string) => u.replace(/\/+$/, '')

  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    if (!(await isAdmin(db, c.var.userId))) {
      metrics.adminDenied.inc({})
      return c.json({ error: 'not_found' }, 404)
    }
    await next()
  }

  const providerOf = (c: Context) => {
    const parsed = providerParam.safeParse(c.req.param('provider'))
    return parsed.success ? parsed.data : null
  }

  async function describeProvider(p: ProviderAppId) {
    const [current, [row], [status], connections] = await Promise.all([
      store.get(p, { fresh: true }),
      db
        .select({
          clientId: providerApps.clientId,
          clientSecretSet: sql<boolean>`${providerApps.clientSecretCt} is not null`,
          signingSecretSet: sql<boolean>`${providerApps.signingSecretCt} is not null`,
          botTokenSet: sql<boolean>`${providerApps.botTokenCt} is not null`,
          allowedUserIds: providerApps.allowedUserIds,
          version: providerApps.version,
          updatedAt: providerApps.updatedAt,
          updatedBy: users.email,
        })
        .from(providerApps)
        .leftJoin(users, eq(users.id, providerApps.updatedBy))
        .where(eq(providerApps.provider, p)),
      db.select().from(providerAppStatus).where(eq(providerAppStatus.provider, p)),
      store.activeConnections(p),
    ])
    const env = deps.providerAppEnv[p]
    const envHas = (field: string) => env !== null && (env as unknown as Record<string, unknown>)[field] != null
    const rowSet = (field: string) =>
      row !== undefined && (field === 'clientSecret' ? row.clientSecretSet : field === 'signingSecret' ? row.signingSecretSet : row.botTokenSet)

    const secrets = Object.fromEntries(
      SECRET_FIELDS[p].map((field) => [
        field,
        row
          ? { set: rowSet(field), source: 'db', updatedAt: row.updatedAt, updatedBy: row.updatedBy ?? null }
          : { set: envHas(field), source: envHas(field) ? 'env' : null, updatedAt: null, updatedBy: null },
      ]),
    )

    let state: 'ready' | 'needs_setup' | 'invalid'
    if (current.state === 'invalid') state = 'invalid'
    else if (current.state === 'missing') state = 'needs_setup'
    else if (p === 'discord') {
      const d = current.config as DiscordAppConfig
      state = d.clientId && d.clientSecret && d.botToken ? 'ready' : 'needs_setup'
    } else state = 'ready'

    const pub = deps.publicUrl
    return {
      provider: p,
      state,
      source: current.source,
      ...(current.state === 'invalid' ? { invalidReason: current.reason } : {}),
      version: current.version,
      clientId: row?.clientId ?? env?.clientId ?? null,
      secrets,
      allowedUserIds: row?.allowedUserIds ?? env?.allowedUserIds ?? [],
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      urls:
        p === 'slack'
          ? { redirect: `${pub}/oauth/slack/callback`, events: `${pub}/hooks/slack` }
          : { redirect: `${pub}/oauth/discord/callback` },
      status: status
        ? { state: status.state, lastReadyAt: status.lastReadyAt, lastCloseCode: status.lastCloseCode, lastSignedOkAt: status.lastSignedOkAt, updatedAt: status.updatedAt }
        : null,
      connections,
    }
  }

  async function call(url: string, init: RequestInit): Promise<{ status: number; json: unknown } | { error: 'timeout' | 'network' }> {
    try {
      const res = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })
      const json = await res.json().catch(() => null)
      return { status: res.status, json }
    } catch (err) {
      return { error: err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network' }
    }
  }

  async function testSlack(cfg: SlackAppConfig): Promise<TestCheck[]> {
    const signing: TestCheck = { check: 'signing_secret', result: 'skipped', code: 'not_testable' }
    const r = await call(`${base(deps.slackApiBase)}/oauth.v2.access`, {
      method: 'POST',
      headers: { authorization: basic(cfg.clientId, cfg.clientSecret), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: SLACK_SENTINEL_CODE }).toString(),
    })
    if ('error' in r) return [{ check: 'client_id', result: 'error', code: r.error }, signing]
    if (r.status !== 200) return [{ check: 'client_id', result: 'error', code: `http_${r.status}` }, signing]
    const body = (r.json ?? {}) as { ok?: unknown; error?: unknown }
    const code = body.ok === true ? 'unexpected_ok' : safeCode(body.error)
    if (code === 'invalid_code') return [{ check: 'client_id', result: 'ok' }, { check: 'client_secret', result: 'ok' }, signing]
    if (code === 'invalid_client_id') return [{ check: 'client_id', result: 'failed', code }, signing]
    if (code === 'bad_client_secret') return [{ check: 'client_id', result: 'ok' }, { check: 'client_secret', result: 'failed', code }, signing]
    return [{ check: 'client_id', result: 'error', code }, signing]
  }

  async function testDiscord(cfg: DiscordAppConfig): Promise<TestCheck[]> {
    const api = base(deps.discordApiBase)
    const checks: TestCheck[] = []
    const httpResult = (status: number): TestCheck['result'] => (status === 401 || status === 403 ? 'failed' : 'error')

    if (!cfg.botToken) {
      checks.push({ check: 'bot_token', result: 'skipped', code: 'missing' }, { check: 'application', result: 'skipped', code: 'missing' })
    } else {
      const bot = { authorization: `Bot ${cfg.botToken}`, 'user-agent': DISCORD_USER_AGENT }
      const me = await call(`${api}/users/@me`, { headers: bot })
      if ('error' in me) checks.push({ check: 'bot_token', result: 'error', code: me.error })
      else if (me.status !== 200) checks.push({ check: 'bot_token', result: httpResult(me.status), code: `http_${me.status}` })
      else checks.push({ check: 'bot_token', result: 'ok' })

      if (checks[0]!.result !== 'ok') checks.push({ check: 'application', result: 'skipped', code: 'bot_token' })
      else {
        const app = await call(`${api}/oauth2/applications/@me`, { headers: bot })
        if ('error' in app) checks.push({ check: 'application', result: 'error', code: app.error })
        else if (app.status !== 200) checks.push({ check: 'application', result: httpResult(app.status), code: `http_${app.status}` })
        else {
          const id = (app.json as { id?: unknown } | null)?.id
          if (!cfg.clientId) checks.push({ check: 'application', result: 'skipped', code: 'missing_client_id' })
          else if (id === cfg.clientId) checks.push({ check: 'application', result: 'ok' })
          else checks.push({ check: 'application', result: 'failed', code: 'app_mismatch' })
        }
      }
    }

    if (!cfg.clientId || !cfg.clientSecret) {
      checks.push({ check: 'client_secret', result: 'skipped', code: 'missing' })
    } else {
      const tok = await call(`${api}/oauth2/token`, {
        method: 'POST',
        headers: { authorization: basic(cfg.clientId, cfg.clientSecret), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': DISCORD_USER_AGENT },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }).toString(),
      })
      if ('error' in tok) checks.push({ check: 'client_secret', result: 'error', code: tok.error })
      else if (tok.status >= 200 && tok.status < 300) checks.push({ check: 'client_secret', result: 'ok' })
      else if (tok.status === 400 || tok.status === 401) {
        const err = (tok.json as { error?: unknown } | null)?.error
        checks.push({ check: 'client_secret', result: 'failed', code: err === undefined ? `http_${tok.status}` : safeCode(err) })
      } else checks.push({ check: 'client_secret', result: 'error', code: `http_${tok.status}` })
    }
    return checks
  }

  const admin = new Hono<Env>()
  admin.onError((err, c) => {
    log.error('admin api error', { name: err.name, path: c.req.path })
    return c.json({ error: 'internal' }, 500)
  })
  admin.use('*', requireAdmin)

  admin.get('/integrations', async (c) => {
    const [slack, discord] = await Promise.all([describeProvider('slack'), describeProvider('discord')])
    return c.json({ publicUrl: deps.publicUrl, warnings: publicUrlWarnings(deps.publicUrl), providers: { slack, discord } })
  })

  admin.put('/integrations/:provider', async (c) => {
    const p = providerOf(c)
    if (!p) return c.json({ error: 'not_found' }, 404)
    const raw = await c.req.json().catch(() => undefined)
    const parsed = putBodies[p].safeParse(raw)
    if (!parsed.success) return c.json({ error: 'validation', fields: fieldNames(parsed.error.issues) }, 400)
    const { confirmClientIdChange, ...input } = parsed.data
    try {
      const saved = await store.save(p, input, { updatedBy: c.var.userId, confirmClientIdChange: confirmClientIdChange === true })
      metrics.providerAppChanges.inc({ provider: p })
      log.info('provider app saved', { provider: p, fields: saved.fields, version: saved.version, by: c.var.userId })
    } catch (err) {
      if (err instanceof ClientIdChangeError) return c.json({ error: 'client_id_change', connections: err.connections }, 409)
      if (err instanceof ProviderAppFieldsError) return c.json({ error: 'validation', fields: err.fields }, 400)
      throw err
    }
    return c.body(null, 204)
  })

  admin.delete('/integrations/:provider', async (c) => {
    const p = providerOf(c)
    if (!p) return c.json({ error: 'not_found' }, 404)
    try {
      const removed = await store.remove(p, { confirmClientIdChange: c.req.query('confirmClientIdChange') === 'true' })
      if (!removed) return c.json({ error: 'not_found' }, 404)
    } catch (err) {
      if (err instanceof ClientIdChangeError) return c.json({ error: 'client_id_change', connections: err.connections }, 409)
      throw err
    }
    metrics.providerAppChanges.inc({ provider: p })
    log.info('provider app removed', { provider: p, by: c.var.userId })
    return c.body(null, 204)
  })

  admin.post('/integrations/:provider/test', async (c) => {
    const p = providerOf(c)
    if (!p) return c.json({ error: 'not_found' }, 404)
    const current = await store.get(p, { fresh: true })
    if (current.state !== 'ready') {
      metrics.providerAppTests.inc({ provider: p, result: 'not_configured' })
      return c.json({ provider: p, ok: false, state: current.state === 'invalid' ? 'invalid' : 'needs_setup', checks: [] })
    }
    const checks = p === 'slack' ? await testSlack(current.config as SlackAppConfig) : await testDiscord(current.config as DiscordAppConfig)
    const result = checks.some((x) => x.result === 'failed')
      ? 'failed'
      : checks.some((x) => x.result === 'error')
        ? 'error'
        : checks.some((x) => x.result === 'skipped' && x.code !== 'not_testable')
          ? 'incomplete'
          : 'ok'
    metrics.providerAppTests.inc({ provider: p, result })
    log.info('provider app tested', { provider: p, result, by: c.var.userId })
    const extra: Record<string, unknown> = {}
    if (p === 'slack') {
      const [status] = await db.select({ at: providerAppStatus.lastSignedOkAt }).from(providerAppStatus).where(eq(providerAppStatus.provider, 'slack'))
      extra.lastSignedOkAt = status?.at ?? null
    }
    return c.json({ provider: p, ok: result === 'ok', result, source: current.source, checks, ...extra })
  })

  return admin
}
