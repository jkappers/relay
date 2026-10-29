import { randomBytes } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { getConnInfo } from '@hono/node-server/conninfo'
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { smsWebhookUrl } from '@relay/provider-sms'
import {
  AdminError,
  ConnectionOwnedError,
  createAgentDestination,
  createAgentDestinationInput,
  createDestination,
  createDestinationInput,
  createRoute,
  createRouteInput,
  deleteDestination,
  deleteRoute,
  isMember,
  log,
  matchRoute,
  replayDelivery,
  replayEvent,
  revokeConnection,
  revokeReplyToken,
  rotateDestinationSecret,
  schema,
  setRouteEnabled,
  updateDestination,
  updateRoute,
  type Cipher,
  type ConnectionStore,
  type Db,
  type Envelope,
  type ProviderRuntime,
  type Queue,
} from '@relay/core'
import { HasherBusyError, PASSWORD_MAX, type PasswordHasher } from '../accounts/password'
import { createUser, credentialsInput, EmailTakenError, findUserByEmail } from '../accounts/users'
import type { ServerMetrics } from '../metrics'
import {
  createLoginLimiter,
  EMAIL_MAX_FAILURES,
  IP_MAX_FAILURES,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type SessionStore,
} from './session'

export interface ConsoleApiDeps {
  db: Db
  queue: Queue
  cipher: Cipher
  connections: ConnectionStore
  runtimes: Record<string, ProviderRuntime>
  metrics: ServerMetrics
  sessions: SessionStore
  hasher: PasswordHasher
  signupMode: 'open' | 'closed'
  publicUrl: string
  /** Which OAuth installs the server has app settings for. */
  providers?: { slack: boolean; discord: boolean }
  nowSeconds: () => number
}

type Env = { Variables: { userId: string; connectionId: string } }

type DestinationRow = typeof schema.destinations.$inferSelect
type RouteRow = typeof schema.routes.$inferSelect

const { connections, destinations, routes, routeDestinations, deliveries, events, actionsLog, agentRuns, users } = schema

const uuid = z.uuid()
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function sessionUser(sessions: SessionStore) {
  return async (c: Context): Promise<string | null> => (await sessions.lookup(getCookie(c, SESSION_COOKIE)))?.userId ?? null
}

const fail = (path: PropertyKey[], message: string) => ({ path: path.join('.'), message })

const validated = <T extends 'json' | 'query'>(target: T, s: z.ZodType) =>
  zValidator(target, s, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'validation', issues: result.error.issues.map((i) => fail(i.path, i.message)) }, 400)
    }
  })

function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const serializeDestination = (d: DestinationRow, routeCount?: number) => ({
  id: d.id,
  name: d.name,
  kind: d.kind,
  url: d.url,
  enabled: d.enabled,
  maxAttempts: d.maxAttempts,
  timeoutMs: d.timeoutMs,
  allowedActions: d.allowedActions,
  config: d.config,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  ...(routeCount === undefined ? {} : { routeCount }),
})

const serializeRoute = (r: RouteRow, destinationIds: string[]) => ({
  id: r.id,
  name: r.name,
  connectionId: r.connectionId,
  eventType: r.eventType,
  textContains: r.textContains,
  textRegex: r.textRegex,
  includeSubtypes: r.includeSubtypes,
  enabled: r.enabled,
  destinationIds,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})

const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url')
function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed = z.tuple([z.string().min(1).max(64), z.uuid()]).safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

interface StatusCounts {
  pending: number
  succeeded: number
  failed: number
}

interface EventTrace {
  routed: 'pending' | 'inactive' | 'echo' | 'routed' | 'unmatched'
  deliveries: StatusCounts
  actions: StatusCounts
  failedDelivery: { id: string; lastError: string | null } | null
}

const FACETS = ['failed', 'pending', 'unrouted', 'echo', 'ok'] as const
type Facet = (typeof FACETS)[number]

const facetsQuery = z.object({
  provider: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
})

const eventsQuery = facetsQuery.extend({
  outcome: z.enum(FACETS).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const deliveriesQuery = z.object({
  status: z.enum(['pending', 'succeeded', 'failed']).optional(),
  eventId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const createDestinationBody = z.discriminatedUnion('kind', [
  createDestinationInput.extend({ kind: z.literal('http') }),
  createAgentDestinationInput.extend({ kind: z.literal('agent') }),
])

const routeBody = createRouteInput
const previewBody = createRouteInput.omit({ name: true, destinationIds: true })

const loginBody = z.object({ email: z.string().trim().toLowerCase().min(1).max(254), password: z.string().max(PASSWORD_MAX) })
const webhookBody = z.object({ name: z.string().trim().min(1).max(100).optional() })
const smsBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  accountSid: z.string().trim().regex(/^AC[0-9a-f]{32}$/i),
  number: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  authToken: z.string().trim().min(8).max(200),
})

export function consoleApi(deps: ConsoleApiDeps) {
  const { db, queue, metrics } = deps
  const ipLimiter = createLoginLimiter(IP_MAX_FAILURES)
  const emailLimiter = createLoginLimiter(EMAIL_MAX_FAILURES)
  const signupLimiter = createLoginLimiter(IP_MAX_FAILURES)
  const dummyHash = deps.hasher.hash(randomBytes(32).toString('base64url'))
  dummyHash.catch(() => {})
  const secure = deps.publicUrl.startsWith('https://')
  const mutated = (resource: string, action: string) => metrics.consoleMutations.inc({ resource, action })

  const csrf: MiddlewareHandler = async (c, next) => {
    if (MUTATING.has(c.req.method) && c.req.header('x-relay-console') !== '1') {
      return c.json({ error: 'csrf', message: 'missing X-Relay-Console header' }, 403)
    }
    await next()
  }

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    if (c.req.method === 'POST' && (c.req.path === '/api/session' || c.req.path === '/api/users')) return next()
    const session = await deps.sessions.lookup(getCookie(c, SESSION_COOKIE))
    if (!session) return c.json({ error: 'unauthorized', signup: deps.signupMode }, 401)
    c.set('userId', session.userId)
    await next()
  }

  const startSession = async (c: Context, userId: string) => {
    setCookie(c, SESSION_COOKIE, await deps.sessions.create(userId), {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'Strict',
      maxAge: SESSION_TTL_SECONDS,
    })
  }

  const onError = (err: Error, c: Context) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: 'validation', issues: err.issues.map((i) => fail(i.path, i.message)) }, 400)
    }
    if (err instanceof AdminError) {
      const status = err.kind === 'not_found' ? 404 : err.kind === 'conflict' ? 409 : 400
      return c.json({ error: err.kind, message: err.message }, status)
    }
    log.error('console api error', { err: err instanceof Error ? err.message : String(err), path: c.req.path })
    return c.json({ error: 'internal' }, 500)
  }

  const api = new Hono<Env>()
  api.use('*', csrf)
  api.use('*', auth)
  api.onError(onError)

  const notFound = (message: string) => new AdminError(message, 'not_found')
  const idParam = (c: Context, name = 'id') => {
    const parsed = uuid.safeParse(c.req.param(name))
    if (!parsed.success) throw notFound('not found')
    return parsed.data
  }
  const busy = (c: Context) => c.json({ error: 'busy', message: 'too many sign-ins at once; try again' }, 503, { 'retry-after': '5' })

  api.post('/session', validated('json', loginBody), async (c) => {
    const ip = clientIp(c)
    const now = deps.nowSeconds()
    const { email, password } = c.req.valid('json') as z.output<typeof loginBody>
    if (ipLimiter.blocked(ip, now)) {
      metrics.consoleLogins.inc({ outcome: 'throttled' })
      return c.json({ error: 'throttled', message: 'too many failed logins; try again later' }, 429, { 'retry-after': '900' })
    }
    if (emailLimiter.blocked(email, now)) {
      metrics.consoleLogins.inc({ outcome: 'rate_limited' })
      return c.json({ error: 'throttled', message: 'too many failed logins; try again later' }, 429, { 'retry-after': '900' })
    }
    const user = await findUserByEmail(db, email)
    let ok: boolean
    try {
      // Unknown emails check against a dummy hash so both paths cost one scrypt.
      ok = await deps.hasher.verify(user?.passwordHash ?? (await dummyHash), password)
    } catch (err) {
      if (!(err instanceof HasherBusyError)) throw err
      metrics.consoleLogins.inc({ outcome: 'busy' })
      return busy(c)
    }
    if (!user || !ok) {
      ipLimiter.fail(ip, now)
      emailLimiter.fail(email, now)
      metrics.consoleLogins.inc({ outcome: 'bad_credentials' })
      return c.json({ error: 'bad_credentials' }, 401)
    }
    ipLimiter.clear(ip)
    emailLimiter.clear(email)
    metrics.consoleLogins.inc({ outcome: 'success' })
    await startSession(c, user.id)
    return c.body(null, 204)
  })

  api.post('/users', validated('json', credentialsInput), async (c) => {
    if (deps.signupMode !== 'open') {
      metrics.consoleSignups.inc({ outcome: 'closed' })
      return c.json({ error: 'signup_closed', message: 'sign-up is closed; ask the operator for an account' }, 403)
    }
    const ip = clientIp(c)
    const now = deps.nowSeconds()
    if (signupLimiter.blocked(ip, now)) {
      metrics.consoleSignups.inc({ outcome: 'rate_limited' })
      return c.json({ error: 'throttled', message: 'too many sign-ups; try again later' }, 429, { 'retry-after': '900' })
    }
    signupLimiter.fail(ip, now)
    let user: schema.UserRow
    try {
      user = await createUser(db, deps.hasher, c.req.valid('json') as z.output<typeof credentialsInput>)
    } catch (err) {
      if (err instanceof EmailTakenError) {
        metrics.consoleSignups.inc({ outcome: 'email_taken' })
        return c.json({ error: 'email_taken', message: err.message }, 409)
      }
      if (!(err instanceof HasherBusyError)) throw err
      metrics.consoleSignups.inc({ outcome: 'busy' })
      return busy(c)
    }
    metrics.consoleSignups.inc({ outcome: 'created' })
    await startSession(c, user.id)
    return c.json({ id: user.id, email: user.email }, 201)
  })

  api.delete('/session', async (c) => {
    await deps.sessions.revoke(getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure })
    return c.body(null, 204)
  })

  const serializeConnection = (r: Awaited<ReturnType<ConnectionStore['listForUser']>>[number]) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    teamId: r.teamId,
    userId: r.userId,
    status: r.status,
    role: r.role,
    createdAt: r.createdAt,
  })

  api.get('/session', async (c) => {
    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, c.var.userId))
    const mine = await deps.connections.listForUser(c.var.userId)
    return c.json({ user, connections: mine.map(serializeConnection), signup: deps.signupMode })
  })

  api.get('/connections', async (c) => {
    const mine = await deps.connections.listForUser(c.var.userId)
    return c.json({ items: mine.map(serializeConnection) })
  })

  api.get('/connections/slack-url', (c) => c.json({ url: `${deps.publicUrl}/oauth/slack/start` }))

  api.get('/connections/providers', (c) => {
    const enabled = deps.providers ?? { slack: true, discord: false }
    const start = (id: string, on: boolean) => (on ? `${deps.publicUrl}/oauth/${id}/start` : null)
    return c.json({ slack: start('slack', enabled.slack), discord: start('discord', enabled.discord) })
  })

  api.post('/connections/webhook', validated('json', webhookBody), async (c) => {
    const { name } = c.req.valid('json') as z.output<typeof webhookBody>
    const { connection, secret } = await deps.connections.createWebhook({ ...(name ? { name } : {}), ownerUserId: c.var.userId })
    mutated('connection', 'create')
    return c.json(
      {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        status: connection.status,
        createdAt: connection.createdAt,
        url: `${deps.publicUrl}/hooks/webhook/${connection.id}`,
        secret,
      },
      201,
    )
  })

  api.post('/connections/sms', validated('json', smsBody), async (c) => {
    const { name, ...input } = c.req.valid('json') as z.output<typeof smsBody>
    let connection
    try {
      connection = await deps.connections.createSms({ ...input, ...(name ? { name } : {}), ownerUserId: c.var.userId })
    } catch (err) {
      if (err instanceof ConnectionOwnedError) return c.json({ error: 'number_already_connected' }, 409)
      throw err
    }
    mutated('connection', 'create')
    return c.json(
      {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        status: connection.status,
        createdAt: connection.createdAt,
        url: smsWebhookUrl(deps.publicUrl, connection.id),
      },
      201,
    )
  })

  // Jtis are unguessable and revoking one only stops a token, so this stays account-level.
  api.post('/tokens/revoke', validated('json', z.object({ jti: z.string().min(1).max(200) })), async (c) => {
    await revokeReplyToken(db, (c.req.valid('json') as { jti: string }).jti)
    mutated('token', 'revoke')
    return c.body(null, 204)
  })

  const t = new Hono<Env>()
  t.onError(onError)
  t.use('*', async (c, next) => {
    const id = uuid.safeParse(c.req.param('connectionId'))
    if (!id.success || !(await isMember(db, c.var.userId, id.data))) {
      metrics.tenantDenied.inc({})
      return c.json({ error: 'not_found' }, 404)
    }
    c.set('connectionId', id.data)
    await next()
  })

  t.get('/overview', async (c) => {
    const tenant = c.var.connectionId
    const since = sql`now() - interval '24 hours'`
    const [[ev], deliveryRows, [act], [runs]] = await Promise.all([
      db
        .select({ n: count() })
        .from(events)
        .where(and(eq(events.connectionId, tenant), sql`${events.receivedAt} >= ${since}`)),
      db
        .select({ status: deliveries.status, n: count() })
        .from(deliveries)
        .innerJoin(events, eq(events.id, deliveries.eventId))
        .where(and(eq(events.connectionId, tenant), sql`${deliveries.createdAt} >= ${since}`))
        .groupBy(deliveries.status),
      db
        .select({ n: count() })
        .from(actionsLog)
        .innerJoin(deliveries, eq(deliveries.id, actionsLog.deliveryId))
        .innerJoin(events, eq(events.id, deliveries.eventId))
        .where(and(eq(events.connectionId, tenant), eq(actionsLog.status, 'failed'), sql`${actionsLog.updatedAt} >= ${since}`)),
      db
        .select({ n: count(), cost: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)::text` })
        .from(agentRuns)
        .innerJoin(deliveries, eq(deliveries.id, agentRuns.deliveryId))
        .innerJoin(events, eq(events.id, deliveries.eventId))
        .where(and(eq(events.connectionId, tenant), sql`${agentRuns.startedAt} >= ${since}`)),
    ])
    const byStatus = { pending: 0, succeeded: 0, failed: 0 }
    for (const r of deliveryRows) byStatus[r.status] = r.n
    return c.json({
      windowHours: 24,
      events: ev?.n ?? 0,
      deliveries: byStatus,
      failedActions: act?.n ?? 0,
      agentRuns: runs?.n ?? 0,
      agentCostUsd: runs?.cost ?? '0',
    })
  })

  t.post('/revoke', async (c) => {
    await revokeConnection(db, c.var.connectionId)
    mutated('connection', 'revoke')
    return c.body(null, 204)
  })

  const linkedRouteCount = sql<number>`(select count(*)::int from route_destinations rd join routes r on r.id = rd.route_id
    where rd.destination_id = destinations.id and r.connection_id = destinations.connection_id)`

  t.get('/destinations', async (c) => {
    const rows = await db
      .select({ d: destinations, routeCount: linkedRouteCount })
      .from(destinations)
      .where(eq(destinations.connectionId, c.var.connectionId))
      .orderBy(desc(destinations.createdAt))
    return c.json({ items: rows.map((r) => serializeDestination(r.d, r.routeCount)) })
  })

  t.get('/destinations/:id', async (c) => {
    const [row] = await db
      .select({ d: destinations, routeCount: linkedRouteCount })
      .from(destinations)
      .where(and(eq(destinations.id, idParam(c)), eq(destinations.connectionId, c.var.connectionId)))
    if (!row) throw notFound('destination not found')
    return c.json(serializeDestination(row.d, row.routeCount))
  })

  t.post('/destinations', validated('json', createDestinationBody), async (c) => {
    const body = c.req.valid('json') as z.output<typeof createDestinationBody>
    if (body.kind === 'http') {
      const { destination, secret } = await createDestination(db, deps.cipher, c.var.connectionId, body)
      mutated('destination', 'create')
      return c.json({ ...serializeDestination(destination), secret }, 201)
    }
    const destination = await createAgentDestination(db, c.var.connectionId, body)
    mutated('destination', 'create')
    return c.json(serializeDestination(destination), 201)
  })

  t.patch('/destinations/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'validation', issues: [fail([], 'body must be a JSON object')] }, 400)
    }
    const row = await updateDestination(db, c.var.connectionId, idParam(c), body)
    mutated('destination', 'update')
    return c.json(serializeDestination(row))
  })

  t.delete('/destinations/:id', async (c) => {
    await deleteDestination(db, c.var.connectionId, idParam(c))
    mutated('destination', 'delete')
    return c.body(null, 204)
  })

  t.post('/destinations/:id/rotate-secret', async (c) => {
    const secret = await rotateDestinationSecret(db, deps.cipher, c.var.connectionId, idParam(c))
    mutated('destination', 'rotate_secret')
    return c.json({ secret })
  })

  const routesWithDestinations = async (tenant: string, where?: SQL) => {
    const rows = await db
      .select()
      .from(routes)
      .where(and(eq(routes.connectionId, tenant), where))
      .orderBy(desc(routes.createdAt))
    const links = rows.length
      ? await db
          .select({ routeId: routeDestinations.routeId, destinationId: routeDestinations.destinationId })
          .from(routeDestinations)
          .innerJoin(destinations, eq(destinations.id, routeDestinations.destinationId))
          .where(and(inArray(routeDestinations.routeId, rows.map((r) => r.id)), eq(destinations.connectionId, tenant)))
      : []
    return rows.map((r) =>
      serializeRoute(
        r,
        links.filter((l) => l.routeId === r.id).map((l) => l.destinationId),
      ),
    )
  }

  t.get('/routes', async (c) => c.json({ items: await routesWithDestinations(c.var.connectionId) }))

  t.post('/routes/preview', validated('json', previewBody), async (c) => {
    const tenant = c.var.connectionId
    const def = { ...(c.req.valid('json') as z.output<typeof previewBody>), connectionId: tenant }
    const rows = await db
      .select({ id: events.id, receivedAt: events.receivedAt, envelope: events.envelope })
      .from(events)
      .where(eq(events.connectionId, tenant))
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(50)
    const matches = rows
      .filter((r) => matchRoute(def, r.envelope as Envelope))
      .map((r) => {
        const env = r.envelope as Envelope
        return { id: r.id, receivedAt: r.receivedAt, type: env.type, subtype: env.subtype, text: env.text?.slice(0, 200) ?? null }
      })
    return c.json({ scanned: rows.length, matches })
  })

  t.get('/routes/:id', async (c) => {
    const [row] = await routesWithDestinations(c.var.connectionId, eq(routes.id, idParam(c)))
    if (!row) throw notFound('route not found')
    return c.json(row)
  })

  t.post('/routes', validated('json', routeBody), async (c) => {
    const tenant = c.var.connectionId
    const route = await createRoute(db, tenant, c.req.valid('json') as z.input<typeof routeBody>)
    mutated('route', 'create')
    const [row] = await routesWithDestinations(tenant, eq(routes.id, route.id))
    return c.json(row, 201)
  })

  t.put('/routes/:id', validated('json', routeBody), async (c) => {
    const tenant = c.var.connectionId
    const id = idParam(c)
    await updateRoute(db, tenant, id, c.req.valid('json') as z.input<typeof routeBody>)
    mutated('route', 'update')
    const [row] = await routesWithDestinations(tenant, eq(routes.id, id))
    return c.json(row)
  })

  t.delete('/routes/:id', async (c) => {
    await deleteRoute(db, c.var.connectionId, idParam(c))
    mutated('route', 'delete')
    return c.body(null, 204)
  })

  for (const [action, enabled] of [['enable', true], ['disable', false]] as const) {
    t.post(`/routes/:id/${action}`, async (c) => {
      const tenant = c.var.connectionId
      const id = idParam(c)
      await setRouteEnabled(db, tenant, id, enabled)
      mutated('route', action)
      const [row] = await routesWithDestinations(tenant, eq(routes.id, id))
      return c.json(row)
    })
  }

  const routedState = sql`case
            when ${events.routedAt} is null then 'pending'
            when ${connections.status} is distinct from 'active' then 'inactive'
            when exists (
              select 1 from sent_messages s
              where s.connection_id = events.connection_id
                and s.channel = ${events.envelope}->'context'->>'channelId'
                and s.ts = ${events.envelope}->'context'->>'messageId'
            ) then 'echo'
            when exists (select 1 from deliveries d where d.event_id = events.id) then 'routed'
            else 'unmatched'
          end`
  const has = (status: string) => sql`(
        exists (select 1 from deliveries d where d.event_id = events.id and d.status = ${status})
        or exists (select 1 from actions_log a join deliveries d on d.id = a.delivery_id where d.event_id = events.id and a.status = ${status})
      )`
  const failed = has('failed')
  const settled = sql`not ${failed} and not ${has('pending')}`
  const facets: Record<Facet, SQL> = {
    failed,
    pending: sql`not ${failed} and (${events.routedAt} is null or ${has('pending')})`,
    unrouted: sql`${settled} and ${events.routedAt} is not null and ${routedState} in ('unmatched', 'inactive')`,
    echo: sql`${settled} and ${events.routedAt} is not null and ${routedState} = 'echo'`,
    ok: sql`${settled} and ${routedState} = 'routed'`,
  }
  const filterConds = (tenant: string, q: z.output<typeof facetsQuery>) => {
    const conds: SQL[] = [eq(events.connectionId, tenant)]
    if (q.provider) conds.push(eq(events.provider, q.provider))
    if (q.type) conds.push(sql`starts_with(${events.envelope}->>'type', ${q.type})`)
    if (q.since) conds.push(sql`${events.receivedAt} >= ${q.since}::timestamptz`)
    return conds
  }

  t.get('/events/facets', validated('query', facetsQuery), async (c) => {
    const conds = filterConds(c.var.connectionId, c.req.valid('query') as z.output<typeof facetsQuery>)
    const [row] = await db
      .select({
        all: sql<number>`count(*)::int`,
        failed: sql<number>`(count(*) filter (where ${facets.failed}))::int`,
        pending: sql<number>`(count(*) filter (where ${facets.pending}))::int`,
        unrouted: sql<number>`(count(*) filter (where ${facets.unrouted}))::int`,
        echo: sql<number>`(count(*) filter (where ${facets.echo}))::int`,
        ok: sql<number>`(count(*) filter (where ${facets.ok}))::int`,
      })
      .from(events)
      .leftJoin(connections, eq(connections.id, events.connectionId))
      .where(and(...conds))
    return c.json(row)
  })

  t.get('/events', validated('query', eventsQuery), async (c) => {
    const q = c.req.valid('query') as z.output<typeof eventsQuery>
    const conds = filterConds(c.var.connectionId, q)
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor)
      if (!cursor) return c.json({ error: 'validation', issues: [fail(['cursor'], 'invalid cursor')] }, 400)
      conds.push(sql`(${events.receivedAt}, ${events.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`)
    }
    if (q.outcome) conds.push(facets[q.outcome])
    const rows = await db
      .select({
        id: events.id,
        provider: events.provider,
        connectionId: events.connectionId,
        type: sql<string>`${events.envelope}->>'type'`,
        subtype: sql<string | null>`${events.envelope}->>'subtype'`,
        actor: sql<string | null>`${events.envelope}->>'actor'`,
        text: sql<string | null>`left(${events.envelope}->>'text', 200)`,
        receivedAt: events.receivedAt,
        routedAt: events.routedAt,
        cursorTs: sql<string>`${events.receivedAt}::text`,
        deliveryCount: sql<number>`(select count(*)::int from deliveries d where d.event_id = events.id)`,
        failedCount: sql<number>`(select count(*)::int from deliveries d where d.event_id = events.id and d.status = 'failed')`,
        trace: sql<EventTrace>`json_build_object(
          'routed', ${routedState},
          'deliveries', (
            select json_build_object(
              'pending', count(*) filter (where d.status = 'pending')::int,
              'succeeded', count(*) filter (where d.status = 'succeeded')::int,
              'failed', count(*) filter (where d.status = 'failed')::int
            ) from deliveries d where d.event_id = events.id
          ),
          'actions', (
            select json_build_object(
              'pending', count(*) filter (where a.status = 'pending')::int,
              'succeeded', count(*) filter (where a.status = 'succeeded')::int,
              'failed', count(*) filter (where a.status = 'failed')::int
            ) from actions_log a join deliveries d on d.id = a.delivery_id where d.event_id = events.id
          ),
          'failedDelivery', (
            select json_build_object('id', d.id, 'lastError', d.last_error)
            from deliveries d where d.event_id = events.id and d.status = 'failed'
            order by d.updated_at desc, d.id desc limit 1
          )
        )`,
      })
      .from(events)
      .leftJoin(connections, eq(connections.id, events.connectionId))
      .where(and(...conds))
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(q.limit + 1)
    const page = rows.slice(0, q.limit)
    const last = page[page.length - 1]
    return c.json({
      items: page.map(({ cursorTs: _ts, ...rest }) => rest),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs, last.id) : null,
    })
  })

  t.get('/events/:id', async (c) => {
    const id = idParam(c)
    const tenant = c.var.connectionId
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.connectionId, tenant)))
    if (!event) throw notFound('event not found')
    const [connection] = await db.select().from(connections).where(eq(connections.id, event.connectionId))
    const deliveryRows = await db
      .select({
        d: deliveries,
        routeName: routes.name,
        destinationName: destinations.name,
        destinationKind: destinations.kind,
      })
      .from(deliveries)
      .innerJoin(routes, eq(routes.id, deliveries.routeId))
      .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
      .where(and(eq(deliveries.eventId, id), eq(routes.connectionId, tenant), eq(destinations.connectionId, tenant)))
      .orderBy(deliveries.createdAt)
    const ids = deliveryRows.map((r) => r.d.id)
    const [actionRows, runRows] = ids.length
      ? await Promise.all([
          db.select().from(actionsLog).where(inArray(actionsLog.deliveryId, ids)).orderBy(actionsLog.createdAt),
          db.select().from(agentRuns).where(inArray(agentRuns.deliveryId, ids)).orderBy(agentRuns.startedAt),
        ])
      : [[], []]

    const envelope = event.envelope as Envelope
    let echo = false
    const runtime = deps.runtimes[event.provider]
    if (runtime && connection) {
      try {
        echo = await runtime.isSelfEcho(envelope, connection)
      } catch {
        echo = false
      }
    }
    const state =
      event.routedAt === null
        ? 'pending'
        : connection?.status !== 'active'
          ? 'skipped_inactive'
          : echo
            ? 'skipped_echo'
            : deliveryRows.length > 0
              ? 'routed'
              : 'unmatched'

    return c.json({
      id: event.id,
      provider: event.provider,
      connectionId: event.connectionId,
      dedupKey: event.dedupKey,
      receivedAt: event.receivedAt,
      enqueuedAt: event.enqueuedAt,
      routedAt: event.routedAt,
      state,
      echo,
      routed: event.routedAt !== null,
      envelope: event.envelope,
      raw: event.raw,
      deliveries: deliveryRows.map((r) => ({
        ...r.d,
        routeName: r.routeName,
        destinationName: r.destinationName,
        destinationKind: r.destinationKind,
      })),
      actions: actionRows,
      agentRuns: runRows,
    })
  })

  t.post('/events/:id/replay', async (c) => {
    await replayEvent(db, queue, c.var.connectionId, idParam(c))
    mutated('event', 'replay')
    return c.json({ queued: true }, 202)
  })

  t.get('/deliveries', validated('query', deliveriesQuery), async (c) => {
    const q = c.req.valid('query') as z.output<typeof deliveriesQuery>
    const tenant = c.var.connectionId
    const conds: SQL[] = [eq(events.connectionId, tenant), eq(routes.connectionId, tenant), eq(destinations.connectionId, tenant)]
    if (q.status) conds.push(eq(deliveries.status, q.status))
    if (q.eventId) conds.push(eq(deliveries.eventId, q.eventId))
    const rows = await db
      .select({
        d: deliveries,
        routeName: routes.name,
        destinationName: destinations.name,
        eventType: sql<string>`${events.envelope}->>'type'`,
      })
      .from(deliveries)
      .innerJoin(routes, eq(routes.id, deliveries.routeId))
      .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .where(and(...conds))
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
      .limit(q.limit)
    return c.json({
      items: rows.map((r) => ({
        ...r.d,
        routeName: r.routeName,
        destinationName: r.destinationName,
        eventType: r.eventType,
      })),
    })
  })

  t.post('/deliveries/:id/replay', async (c) => {
    const id = idParam(c)
    const [row] = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .where(and(eq(deliveries.id, id), eq(events.connectionId, c.var.connectionId)))
    if (!row) throw notFound('delivery not found')
    await replayDelivery(db, queue, c.var.connectionId, id)
    mutated('delivery', 'replay')
    return c.json({ queued: true }, 202)
  })

  api.route('/c/:connectionId', t)
  api.all('*', (c) => c.json({ error: 'not_found' }, 404))

  return api
}
