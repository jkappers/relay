import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createDestination, createRoute, schema, type Envelope } from '@relay/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { signIn, useHarness, type Account } from './harness'

const h = useHarness()
const body = async (r: Response | Promise<Response>): Promise<any> => (await r).json()

const TABLES = [
  'users',
  'connections',
  'connection_members',
  'credentials',
  'destinations',
  'routes',
  'route_destinations',
  'events',
  'deliveries',
  'actions_log',
  'agent_runs',
  'revoked_tokens',
] as const

async function snapshot(): Promise<string> {
  const out: Record<string, unknown> = {}
  for (const t of TABLES) out[t] = await h.db.execute(sql.raw(`select * from ${t} order by 1`))
  out.jobs = await h.db.execute(sql`select name, data from pgboss.job order by created_on, id`)
  return JSON.stringify(out)
}

interface Tenant {
  account: Account
  connectionId: string
  destinationId: string
  routeId: string
  eventId: string
  deliveryId: string
}

async function seedTenant(email: string, name: string): Promise<Tenant> {
  const account = await signIn(h, email)
  const { connection } = await h.connections.createWebhook({ name, ownerUserId: account.userId })
  const { destination } = await createDestination(h.db, h.cipher, connection.id, { name: `${name}-dest`, url: 'http://127.0.0.1:1/x' })
  const route = await createRoute(h.db, connection.id, { name: `${name}-route`, eventType: '*', destinationIds: [destination.id] })
  const eventId = randomUUID()
  const envelope: Envelope = {
    id: eventId,
    provider: 'webhook',
    connectionId: connection.id,
    type: 'webhook.secret-plans',
    subtype: null,
    occurredAt: new Date().toISOString(),
    actor: null,
    context: { channelId: null, threadId: null, messageId: null },
    text: `${name} private text`,
    raw: {},
  }
  await h.db.insert(schema.events).values({ id: eventId, provider: 'webhook', connectionId: connection.id, dedupKey: eventId, raw: {}, envelope, routedAt: new Date() })
  const [delivery] = await h.db
    .insert(schema.deliveries)
    .values({ eventId, routeId: route.id, destinationId: destination.id, status: 'failed', attempts: 8, lastError: `${name} failure`, lastReplyJti: `${name}-jti` })
    .returning()
  await h.db.insert(schema.actionsLog).values({ deliveryId: delivery!.id, idempotencyKey: 'k', type: 'reply', params: {}, status: 'failed' })
  return { account, connectionId: connection.id, destinationId: destination.id, routeId: route.id, eventId, deliveryId: delivery!.id }
}

let a: Tenant
let b: Tenant

beforeEach(async () => {
  a = await seedTenant('a@example.com', 'alpha')
  b = await seedTenant('b@example.com', 'bravo')
})

const TENANT_PREFIX = '/api/c/:connectionId'
const tenantRoutes = () => {
  const keys = new Set(
    h.app.routes
      .filter((r) => r.path.startsWith(`${TENANT_PREFIX}/`) && r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path.slice(TENANT_PREFIX.length)}`),
  )
  return [...keys].map((k) => {
    const [method, path] = k.split(' ') as [string, string]
    return { method, path }
  })
}
const withIds = (path: string, t: Tenant) => (path.includes(':id') ? path.replace(':id', idFor(path, t)) : path)

function idFor(path: string, t: Tenant): string {
  const kind = path.split('/')[1]
  if (kind === 'destinations') return t.destinationId
  if (kind === 'routes') return t.routeId
  if (kind === 'events') return t.eventId
  if (kind === 'deliveries') return t.deliveryId
  throw new Error(`no resource for ${path}`)
}

function bodyFor(method: string, path: string): unknown {
  if (method === 'GET' || method === 'DELETE') return undefined
  if (path === '/destinations') return { kind: 'http', name: 'x', url: 'http://a.test' }
  if (path === '/destinations/:id') return { name: 'renamed', enabled: false }
  if (path === '/routes' || path === '/routes/:id') return { name: 'x', eventType: '*', destinationIds: [a.destinationId] }
  if (path === '/routes/preview') return { eventType: '*' }
  return {}
}

const secretsOf = (t: Tenant) => [t.connectionId, t.destinationId, t.routeId, t.eventId, t.deliveryId, 'bravo private text', 'bravo failure']

describe('tenant isolation', () => {
  it('covers every tenant endpoint', () => {
    const paths = tenantRoutes().map((r) => `${r.method} ${r.path}`)
    expect(paths.length).toBeGreaterThanOrEqual(22)
    for (const p of paths) expect(p).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//)
  })

  it("404s every tenant endpoint when A uses B's connection id, and changes nothing", async () => {
    const before = await snapshot()
    for (const r of tenantRoutes()) {
      const path = `/api/c/${b.connectionId}${withIds(r.path, b)}`
      const res = await a.account.api(r.method, path, bodyFor(r.method, r.path))
      expect(res.status, `${r.method} ${r.path}`).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
    expect(await snapshot()).toBe(before)
    expect(h.metrics.tenantDenied.get({})).toBe(tenantRoutes().length)
  })

  it("404s when A uses A's connection id with B's resource id, and changes nothing", async () => {
    const before = await snapshot()
    const withId = tenantRoutes().filter((r) => r.path.includes(':id'))
    expect(withId.length).toBeGreaterThanOrEqual(12)
    for (const r of withId) {
      const path = `/api/c/${a.connectionId}${withIds(r.path, b)}`
      const res = await a.account.api(r.method, path, bodyFor(r.method, r.path))
      expect(res.status, `${r.method} ${r.path}`).toBe(404)
    }
    expect(await snapshot()).toBe(before)
  })

  it("answers the same for a nonexistent id as for B's id", async () => {
    for (const r of tenantRoutes().filter((x) => x.path.includes(':id'))) {
      const call = (id: string) => a.account.api(r.method, `/api/c/${a.connectionId}${r.path.replace(':id', id)}`, bodyFor(r.method, r.path))
      const theirs = await call(idFor(r.path, b))
      const none = await call(randomUUID())
      expect([theirs.status, await theirs.json()], `${r.method} ${r.path}`).toEqual([none.status, await none.json()])
    }
  })

  it("never shows B's rows in A's lists, previews, or overview", async () => {
    const lists = tenantRoutes().filter((r) => r.method === 'GET' && !r.path.includes(':id'))
    expect(lists.map((r) => r.path).sort()).toEqual(['/deliveries', '/destinations', '/events', '/events/facets', '/overview', '/routes'])
    for (const r of lists) {
      const text = await (await a.account.api('GET', `/api/c/${a.connectionId}${r.path}`)).text()
      for (const s of secretsOf(b)) expect(text, `${r.path} leaks ${s}`).not.toContain(s)
    }
    const preview = await (await a.account.api('POST', `/api/c/${a.connectionId}/routes/preview`, { eventType: '*' })).json()
    expect(preview).toMatchObject({ scanned: 1, matches: [{ id: a.eventId }] })
    const overview = await (await a.account.api('GET', `/api/c/${a.connectionId}/overview`)).json()
    expect(overview).toMatchObject({ events: 1, deliveries: { failed: 1 }, failedActions: 1 })
  })

  it("returns nothing for ?eventId= of B's event under A's path", async () => {
    const res = await a.account.api('GET', `/api/c/${a.connectionId}/deliveries?eventId=${b.eventId}`)
    expect(res.status).toBe(200)
    expect((await body(res)).items).toEqual([])
    const own = await body(await a.account.api('GET', `/api/c/${a.connectionId}/deliveries?eventId=${a.eventId}`))
    expect(own.items.map((d: { id: string }) => d.id)).toEqual([a.deliveryId])
  })

  it('ignores a connectionId query param that tries to widen the event list', async () => {
    const res = await a.account.api('GET', `/api/c/${a.connectionId}/events?connectionId=${b.connectionId}`)
    expect((await body(res)).items.map((e: { id: string }) => e.id)).toEqual([a.eventId])
    const facets = (await (await a.account.api('GET', `/api/c/${a.connectionId}/events/facets?connectionId=${b.connectionId}`)).json()) as { all: number }
    expect(facets.all).toBe(1)
  })

  it("refuses to link B's destination to a route in A's connection", async () => {
    const before = await snapshot()
    for (const [method, path] of [['POST', '/routes'], ['PUT', `/routes/${a.routeId}`]] as const) {
      const theirs = await a.account.api(method, `/api/c/${a.connectionId}${path}`, { name: 'x', eventType: '*', destinationIds: [b.destinationId] })
      const none = await a.account.api(method, `/api/c/${a.connectionId}${path}`, { name: 'x', eventType: '*', destinationIds: [randomUUID()] })
      expect(theirs.status).toBe(400)
      expect(await theirs.json()).toEqual(await none.json())
    }
    expect(await snapshot()).toBe(before)
  })

  it('lists only connections the user is a member of', async () => {
    const mine = (await (await a.account.api('GET', '/api/connections')).json()) as { items: { id: string }[] }
    expect(mine.items.map((c: { id: string }) => c.id)).toEqual([a.connectionId])
    const session = (await (await a.account.api('GET', '/api/session')).json()) as { connections: { id: string }[] }
    expect(session.connections.map((c: { id: string }) => c.id)).toEqual([a.connectionId])
  })

  it('keeps token revoke account-level: any signed-in user can revoke any jti, and it only adds a revocation', async () => {
    const before = await snapshot()
    expect((await a.account.api('POST', '/api/tokens/revoke', { jti: 'bravo-jti' })).status).toBe(204)
    const rows = await h.db.select().from(schema.revokedTokens)
    expect(rows.map((r) => r.jti)).toEqual(['bravo-jti'])
    const after = JSON.parse(await snapshot())
    const was = JSON.parse(before)
    expect({ ...after, revoked_tokens: [] }).toEqual({ ...was, revoked_tokens: [] })
    expect((await a.account.api('POST', `/api/c/${b.connectionId}/tokens/revoke`, { jti: 'x' })).status).toBe(404)
  })
})
