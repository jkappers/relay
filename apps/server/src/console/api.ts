import { zValidator } from '@hono/zod-validator'
import { getConnInfo } from '@hono/node-server/conninfo'
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import {
  AdminError,
  createAgentDestination,
  createAgentDestinationInput,
  createDestination,
  createDestinationInput,
  createRoute,
  createRouteInput,
  deleteDestination,
  deleteRoute,
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
import type { ServerMetrics } from '../metrics'
import {
  checkSessionToken,
  createLoginLimiter,
  createSessionToken,
  passwordMatches,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from './session'

export interface ConsoleApiDeps {
  db: Db
  queue: Queue
  cipher: Cipher
  connections: ConnectionStore
  runtimes: Record<string, ProviderRuntime>
  metrics: ServerMetrics
  password: string
  sessionKey: Buffer
  publicUrl: string
  nowSeconds: () => number
}

type DestinationRow = typeof schema.destinations.$inferSelect
type RouteRow = typeof schema.routes.$inferSelect

const { connections, destinations, routes, routeDestinations, deliveries, events, actionsLog, agentRuns } = schema

const uuid = z.uuid()
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function sessionGuard(deps: Pick<ConsoleApiDeps, 'sessionKey' | 'nowSeconds'>) {
  return (c: Context) => checkSessionToken(deps.sessionKey, getCookie(c, SESSION_COOKIE), deps.nowSeconds())
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

const eventsQuery = z.object({
  provider: z.string().min(1).optional(),
  connectionId: z.uuid().optional(),
  type: z.string().min(1).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
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

export function consoleApi(deps: ConsoleApiDeps) {
  const { db, queue, metrics } = deps
  const limiter = createLoginLimiter()
  const hasSession = sessionGuard(deps)
  const secure = deps.publicUrl.startsWith('https://')
  const mutated = (resource: string, action: string) => metrics.consoleMutations.inc({ resource, action })

  const csrf: MiddlewareHandler = async (c, next) => {
    if (MUTATING.has(c.req.method) && c.req.header('x-relay-console') !== '1') {
      return c.json({ error: 'csrf', message: 'missing X-Relay-Console header' }, 403)
    }
    await next()
  }

  const auth: MiddlewareHandler = async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === '/api/session') return next()
    if (!hasSession(c)) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }

  const api = new Hono()
  api.use('*', csrf)
  api.use('*', auth)

  api.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: 'validation', issues: err.issues.map((i) => fail(i.path, i.message)) }, 400)
    }
    if (err instanceof AdminError) {
      const status = err.kind === 'not_found' ? 404 : err.kind === 'conflict' ? 409 : 400
      return c.json({ error: err.kind, message: err.message }, status)
    }
    log.error('console api error', { err: err instanceof Error ? err.message : String(err), path: c.req.path })
    return c.json({ error: 'internal' }, 500)
  })

  const notFound = (message: string) => new AdminError(message, 'not_found')
  const idParam = (c: Context, name = 'id') => {
    const parsed = uuid.safeParse(c.req.param(name))
    if (!parsed.success) throw notFound('not found')
    return parsed.data
  }

  api.post('/session', validated('json', z.object({ password: z.string().max(1000) })), (c) => {
    const ip = clientIp(c)
    const now = deps.nowSeconds()
    if (limiter.blocked(ip, now)) {
      metrics.consoleLogins.inc({ outcome: 'throttled' })
      return c.json({ error: 'throttled', message: 'too many failed logins; try again later' }, 429, { 'retry-after': '900' })
    }
    const { password } = c.req.valid('json') as { password: string }
    if (!passwordMatches(deps.sessionKey, deps.password, password)) {
      limiter.fail(ip, now)
      metrics.consoleLogins.inc({ outcome: 'bad_password' })
      return c.json({ error: 'bad_password' }, 401)
    }
    limiter.clear(ip)
    metrics.consoleLogins.inc({ outcome: 'success' })
    setCookie(c, SESSION_COOKIE, createSessionToken(deps.sessionKey, now), {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'Strict',
      maxAge: SESSION_TTL_SECONDS,
    })
    return c.body(null, 204)
  })

  api.delete('/session', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure })
    return c.body(null, 204)
  })

  api.get('/session', (c) => c.json({ ok: true }))

  api.get('/overview', async (c) => {
    const since = sql`now() - interval '24 hours'`
    const [[ev], deliveryRows, [act], [runs]] = await Promise.all([
      db.select({ n: count() }).from(events).where(sql`${events.receivedAt} >= ${since}`),
      db
        .select({ status: deliveries.status, n: count() })
        .from(deliveries)
        .where(sql`${deliveries.createdAt} >= ${since}`)
        .groupBy(deliveries.status),
      db
        .select({ n: count() })
        .from(actionsLog)
        .where(and(eq(actionsLog.status, 'failed'), sql`${actionsLog.updatedAt} >= ${since}`)),
      db
        .select({ n: count(), cost: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)::text` })
        .from(agentRuns)
        .where(sql`${agentRuns.startedAt} >= ${since}`),
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

  api.get('/connections', async (c) => {
    const rows = await db.select().from(connections).orderBy(desc(connections.createdAt))
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        teamId: r.teamId,
        userId: r.userId,
        status: r.status,
        createdAt: r.createdAt,
      })),
    })
  })

  api.get('/connections/slack-url', (c) => c.json({ url: `${deps.publicUrl}/oauth/slack/start` }))

  api.post('/connections/webhook', async (c) => {
    const { connection, secret } = await deps.connections.createWebhook()
    mutated('connection', 'create')
    return c.json(
      {
        id: connection.id,
        provider: connection.provider,
        status: connection.status,
        createdAt: connection.createdAt,
        url: `${deps.publicUrl}/hooks/webhook/${connection.id}`,
        secret,
      },
      201,
    )
  })

  api.post('/connections/:id/revoke', async (c) => {
    await revokeConnection(db, idParam(c))
    mutated('connection', 'revoke')
    return c.body(null, 204)
  })

  api.get('/destinations', async (c) => {
    const rows = await db
      .select({
        d: destinations,
        routeCount: sql<number>`(select count(*)::int from route_destinations rd where rd.destination_id = destinations.id)`,
      })
      .from(destinations)
      .orderBy(desc(destinations.createdAt))
    return c.json({ items: rows.map((r) => serializeDestination(r.d, r.routeCount)) })
  })

  api.get('/destinations/:id', async (c) => {
    const id = idParam(c)
    const [row] = await db.select().from(destinations).where(eq(destinations.id, id))
    if (!row) throw notFound('destination not found')
    const [n] = await db.select({ n: count() }).from(routeDestinations).where(eq(routeDestinations.destinationId, id))
    return c.json(serializeDestination(row, n?.n ?? 0))
  })

  api.post('/destinations', validated('json', createDestinationBody), async (c) => {
    const body = c.req.valid('json') as z.output<typeof createDestinationBody>
    if (body.kind === 'http') {
      const { destination, secret } = await createDestination(db, deps.cipher, body)
      mutated('destination', 'create')
      return c.json({ ...serializeDestination(destination), secret }, 201)
    }
    const destination = await createAgentDestination(db, body)
    mutated('destination', 'create')
    return c.json(serializeDestination(destination), 201)
  })

  api.patch('/destinations/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'validation', issues: [fail([], 'body must be a JSON object')] }, 400)
    }
    const row = await updateDestination(db, idParam(c), body)
    mutated('destination', 'update')
    return c.json(serializeDestination(row))
  })

  api.delete('/destinations/:id', async (c) => {
    await deleteDestination(db, idParam(c))
    mutated('destination', 'delete')
    return c.body(null, 204)
  })

  api.post('/destinations/:id/rotate-secret', async (c) => {
    const secret = await rotateDestinationSecret(db, deps.cipher, idParam(c))
    mutated('destination', 'rotate_secret')
    return c.json({ secret })
  })

  const routesWithDestinations = async (where?: SQL) => {
    const rows = await (where ? db.select().from(routes).where(where) : db.select().from(routes)).orderBy(desc(routes.createdAt))
    const links = rows.length
      ? await db.select().from(routeDestinations).where(inArray(routeDestinations.routeId, rows.map((r) => r.id)))
      : []
    return rows.map((r) =>
      serializeRoute(
        r,
        links.filter((l) => l.routeId === r.id).map((l) => l.destinationId),
      ),
    )
  }

  api.get('/routes', async (c) => c.json({ items: await routesWithDestinations() }))

  api.post('/routes/preview', validated('json', previewBody), async (c) => {
    const def = c.req.valid('json') as z.output<typeof previewBody>
    const rows = await db
      .select({ id: events.id, receivedAt: events.receivedAt, envelope: events.envelope })
      .from(events)
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

  api.get('/routes/:id', async (c) => {
    const [row] = await routesWithDestinations(eq(routes.id, idParam(c)))
    if (!row) throw notFound('route not found')
    return c.json(row)
  })

  api.post('/routes', validated('json', routeBody), async (c) => {
    const route = await createRoute(db, c.req.valid('json') as z.input<typeof routeBody>)
    mutated('route', 'create')
    const [row] = await routesWithDestinations(eq(routes.id, route.id))
    return c.json(row, 201)
  })

  api.put('/routes/:id', validated('json', routeBody), async (c) => {
    const id = idParam(c)
    await updateRoute(db, id, c.req.valid('json') as z.input<typeof routeBody>)
    mutated('route', 'update')
    const [row] = await routesWithDestinations(eq(routes.id, id))
    return c.json(row)
  })

  api.delete('/routes/:id', async (c) => {
    await deleteRoute(db, idParam(c))
    mutated('route', 'delete')
    return c.body(null, 204)
  })

  for (const [action, enabled] of [['enable', true], ['disable', false]] as const) {
    api.post(`/routes/:id/${action}`, async (c) => {
      const id = idParam(c)
      await setRouteEnabled(db, id, enabled)
      mutated('route', action)
      const [row] = await routesWithDestinations(eq(routes.id, id))
      return c.json(row)
    })
  }

  api.get('/events', validated('query', eventsQuery), async (c) => {
    const q = c.req.valid('query') as z.output<typeof eventsQuery>
    const conds: SQL[] = []
    if (q.provider) conds.push(eq(events.provider, q.provider))
    if (q.connectionId) conds.push(eq(events.connectionId, q.connectionId))
    if (q.type) conds.push(sql`starts_with(${events.envelope}->>'type', ${q.type})`)
    if (q.since) conds.push(sql`${events.receivedAt} >= ${q.since}::timestamptz`)
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor)
      if (!cursor) return c.json({ error: 'validation', issues: [fail(['cursor'], 'invalid cursor')] }, 400)
      conds.push(sql`(${events.receivedAt}, ${events.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`)
    }
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
      })
      .from(events)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(q.limit + 1)
    const page = rows.slice(0, q.limit)
    const last = page[page.length - 1]
    return c.json({
      items: page.map(({ cursorTs: _ts, ...rest }) => rest),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs, last.id) : null,
    })
  })

  api.get('/events/:id', async (c) => {
    const id = idParam(c)
    const [event] = await db.select().from(events).where(eq(events.id, id))
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
      .where(eq(deliveries.eventId, id))
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

  api.post('/events/:id/replay', async (c) => {
    await replayEvent(db, queue, idParam(c))
    mutated('event', 'replay')
    return c.json({ queued: true }, 202)
  })

  api.get('/deliveries', validated('query', deliveriesQuery), async (c) => {
    const q = c.req.valid('query') as z.output<typeof deliveriesQuery>
    const conds: SQL[] = []
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
      .where(conds.length ? and(...conds) : undefined)
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

  api.post('/deliveries/:id/replay', async (c) => {
    const id = idParam(c)
    const [row] = await db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.id, id))
    if (!row) throw notFound('delivery not found')
    await replayDelivery(db, queue, id)
    mutated('delivery', 'replay')
    return c.json({ queued: true }, 202)
  })

  api.post('/tokens/revoke', validated('json', z.object({ jti: z.string().min(1).max(200) })), async (c) => {
    await revokeReplyToken(db, (c.req.valid('json') as { jti: string }).jti)
    mutated('token', 'revoke')
    return c.body(null, 204)
  })

  api.all('*', (c) => c.json({ error: 'not_found' }, 404))

  return api
}
