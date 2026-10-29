import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { QUEUES, schema, type Envelope } from '@relay/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiAs, login, useHarness, type Api } from './harness'

const h = useHarness()
let api: Api

beforeEach(async () => {
  api = apiAs(h.app, (await login(h.app)).cookie)
})

const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>

async function seedConnection() {
  const { connection } = await h.connections.createWebhook()
  return connection.id
}

async function seedEvent(connectionId: string, over: Partial<Envelope> & { receivedAt?: Date; routed?: boolean } = {}) {
  const id = randomUUID()
  const envelope: Envelope = {
    id,
    provider: 'webhook',
    connectionId,
    type: 'webhook.received',
    subtype: null,
    occurredAt: new Date().toISOString(),
    actor: null,
    context: { channelId: null, threadId: null, messageId: null },
    text: 'hello',
    raw: {},
    ...over,
  }
  await h.db.insert(schema.events).values({
    id,
    provider: envelope.provider,
    connectionId,
    dedupKey: id,
    raw: { n: 1 },
    envelope,
    receivedAt: over.receivedAt ?? new Date(),
    routedAt: over.routed ? new Date() : null,
  })
  return id
}

async function seedDestination() {
  const body = await json(api('POST', '/api/destinations', { kind: 'http', name: 'echo', url: 'http://localhost:9/x' }))
  return body.id as string
}

const jobCount = async (name: string, key: string) => {
  const rows = await h.db.execute<{ n: number }>(
    sql`select count(*)::int as n from pgboss.job where name = ${name} and singleton_key = ${key}`,
  )
  return rows[0]!.n
}

describe('connections', () => {
  it('creates a webhook connection and shows the secret once', async () => {
    const res = await api('POST', '/api/connections/webhook')
    expect(res.status).toBe(201)
    const created = await json(res)
    expect(created.url).toBe(`http://relay.test/hooks/webhook/${created.id}`)
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(await h.connections.getWebhookSecret(created.id)).toBe(created.secret)

    const text = await (await api('GET', '/api/connections')).text()
    expect(text).not.toContain(created.secret)
    expect(text).not.toMatch(/secret|ciphertext|token/i)
    const list = JSON.parse(text)
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ id: created.id, provider: 'webhook', status: 'active' })
  })

  it('revokes a connection', async () => {
    const id = await seedConnection()
    expect((await api('POST', `/api/connections/${id}/revoke`)).status).toBe(204)
    expect((await h.connections.findById(id))?.status).toBe('revoked')
    expect((await api('POST', `/api/connections/${randomUUID()}/revoke`)).status).toBe(404)
    expect(h.metrics.consoleMutations.get({ resource: 'connection', action: 'revoke' })).toBe(1)
  })

  it('returns the Slack connect URL', async () => {
    expect(await json(api('GET', '/api/connections/slack-url'))).toEqual({ url: 'http://relay.test/oauth/slack/start' })
  })
})

describe('destinations', () => {
  it('creates, reads, updates and deletes an http destination without leaking the secret', async () => {
    const res = await api('POST', '/api/destinations', { kind: 'http', name: 'echo', url: 'http://localhost:9/x', maxAttempts: 2 })
    expect(res.status).toBe(201)
    const created = await json(res)
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/)
    expect((await json(api('GET', '/api/destinations'))).items[0].routeCount).toBe(0)
    const [row] = await h.db.select().from(schema.destinations)
    expect(h.cipher.decrypt(row!.secretCiphertext!)).toBe(created.secret)

    for (const path of ['/api/destinations', `/api/destinations/${created.id}`]) {
      const text = await (await api('GET', path)).text()
      expect(text).not.toContain(created.secret)
      expect(text).not.toContain(row!.secretCiphertext!)
      expect(text).not.toMatch(/secret/i)
    }

    const patched = await json(api('PATCH', `/api/destinations/${created.id}`, { name: 'renamed', enabled: false, allowedActions: ['reply'] }))
    expect(patched).toMatchObject({ name: 'renamed', enabled: false, allowedActions: ['reply'], maxAttempts: 2 })

    const del = await api('DELETE', `/api/destinations/${created.id}`)
    expect(del.status).toBe(204)
    expect((await api('GET', `/api/destinations/${created.id}`)).status).toBe(404)
  })

  it('rotates the signing secret', async () => {
    const created = await json(api('POST', '/api/destinations', { kind: 'http', name: 'a', url: 'http://localhost:9/x' }))
    const rotated = await json(api('POST', `/api/destinations/${created.id}/rotate-secret`))
    expect(rotated.secret).not.toBe(created.secret)
    const [row] = await h.db.select().from(schema.destinations)
    expect(h.cipher.decrypt(row!.secretCiphertext!)).toBe(rotated.secret)
  })

  it('creates and updates an agent destination, merging config', async () => {
    const res = await api('POST', '/api/destinations', {
      kind: 'agent',
      name: 'bot',
      config: { systemPrompt: 'Be brief.', maxTurns: 5, model: 'claude-test' },
    })
    expect(res.status).toBe(201)
    const created = await json(res)
    expect(created).not.toHaveProperty('secret')
    expect(created.config).toMatchObject({ systemPrompt: 'Be brief.', maxTurns: 5, model: 'claude-test' })

    const patched = await json(api('PATCH', `/api/destinations/${created.id}`, { config: { systemPrompt: 'Be very brief.' } }))
    expect(patched.config).toMatchObject({ systemPrompt: 'Be very brief.', maxTurns: 5, model: 'claude-test' })

    expect((await api('POST', `/api/destinations/${created.id}/rotate-secret`)).status).toBe(400)
  })

  it('validates input', async () => {
    const noUrl = await api('POST', '/api/destinations', { kind: 'http', name: 'x' })
    expect(noUrl.status).toBe(400)
    expect((await json(noUrl)).error).toBe('validation')
    expect((await api('POST', '/api/destinations', { kind: 'http', name: 'x', url: 'ftp://x.test' })).status).toBe(400)
    expect((await api('POST', '/api/destinations', { kind: 'agent', name: 'x', config: {} })).status).toBe(400)
    expect((await api('POST', '/api/destinations', { kind: 'agent', name: 'x', config: { systemPrompt: '' } })).status).toBe(400)
    expect((await api('POST', '/api/destinations', { name: 'x', url: 'http://a.test' })).status).toBe(400)
    const id = await seedDestination()
    expect((await api('PATCH', `/api/destinations/${id}`, { url: 'nope' })).status).toBe(400)
    expect((await api('PATCH', `/api/destinations/${id}`, { bogus: 1 })).status).toBe(400)
    expect((await api('GET', '/api/destinations/not-a-uuid')).status).toBe(404)
  })

  it('refuses to delete a destination that routes link to', async () => {
    const id = await seedDestination()
    const route = await json(api('POST', '/api/routes', { name: 'r', eventType: '*', destinationIds: [id] }))
    const res = await api('DELETE', `/api/destinations/${id}`)
    expect(res.status).toBe(409)
    expect((await json(res)).message).toMatch(/route/)
    await api('DELETE', `/api/routes/${route.id}`)
    expect((await api('DELETE', `/api/destinations/${id}`)).status).toBe(204)
  })
})

describe('routes', () => {
  it('runs CRUD, relinking destinations and toggling', async () => {
    const d1 = await seedDestination()
    const d2 = await seedDestination()
    const conn = await seedConnection()
    const res = await api('POST', '/api/routes', { name: 'r', eventType: 'slack.message.*', destinationIds: [d1], textContains: 'hi' })
    expect(res.status).toBe(201)
    const route = await json(res)
    expect(route).toMatchObject({ enabled: true, destinationIds: [d1], textContains: 'hi', includeSubtypes: false })

    const updated = await json(
      api('PUT', `/api/routes/${route.id}`, {
        name: 'r2',
        eventType: 'x',
        destinationIds: [d2],
        connectionId: conn,
        textRegex: '^a+$',
        includeSubtypes: true,
        enabled: false,
      }),
    )
    expect(updated).toMatchObject({ name: 'r2', destinationIds: [d2], connectionId: conn, textRegex: '^a+$', includeSubtypes: true, enabled: false, textContains: null })

    expect((await json(api('POST', `/api/routes/${route.id}/enable`))).enabled).toBe(true)
    expect((await json(api('POST', `/api/routes/${route.id}/disable`))).enabled).toBe(false)
    expect((await json(api('GET', `/api/routes/${route.id}`))).name).toBe('r2')
    expect((await json(api('GET', '/api/routes'))).items).toHaveLength(1)

    expect((await api('DELETE', `/api/routes/${route.id}`)).status).toBe(204)
    expect((await api('GET', `/api/routes/${route.id}`)).status).toBe(404)
    expect(await h.db.select().from(schema.routeDestinations)).toHaveLength(0)
  })

  it('validates regexes and references', async () => {
    const d = await seedDestination()
    const bad = await api('POST', '/api/routes', { name: 'r', eventType: 'x', destinationIds: [d], textRegex: '(' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await json(bad))).toContain('regex')
    const long = await api('POST', '/api/routes', { name: 'r', eventType: 'x', destinationIds: [d], textRegex: 'a'.repeat(201) })
    expect(long.status).toBe(400)
    expect((await api('POST', '/api/routes', { name: 'r', eventType: 'x', destinationIds: [] })).status).toBe(400)
    expect((await api('POST', '/api/routes', { name: 'r', eventType: 'x', destinationIds: [randomUUID()] })).status).toBe(400)
    expect((await api('POST', '/api/routes', { name: 'r', eventType: 'x', destinationIds: [d], connectionId: randomUUID() })).status).toBe(400)
    expect((await api('PUT', `/api/routes/${randomUUID()}`, { name: 'r', eventType: 'x', destinationIds: [d] })).status).toBe(404)
  })

  it('previews matches against the last 50 events', async () => {
    const conn = await seedConnection()
    const hit = await seedEvent(conn, { text: 'Deploy FAILED now', type: 'slack.message.channel' })
    await seedEvent(conn, { text: 'all good', type: 'slack.message.channel' })
    await seedEvent(conn, { text: 'deploy failed', type: 'slack.reaction' })
    await seedEvent(conn, { text: 'deploy failed', type: 'slack.message.channel', subtype: 'bot_message' })

    const res = await json(api('POST', '/api/routes/preview', { eventType: 'slack.message.*', textContains: 'deploy failed' }))
    expect(res.scanned).toBe(4)
    expect(res.matches.map((m: any) => m.id)).toEqual([hit])

    const withSub = await json(api('POST', '/api/routes/preview', { eventType: 'slack.message.*', textRegex: '^deploy', includeSubtypes: true }))
    expect(withSub.matches).toHaveLength(1)
    expect(withSub.matches[0].type).toBe('slack.message.channel')

    expect((await api('POST', '/api/routes/preview', { eventType: 'x', textRegex: '(' })).status).toBe(400)

    for (let i = 0; i < 60; i++) await seedEvent(conn, { text: 'bulk' })
    expect((await json(api('POST', '/api/routes/preview', { eventType: '*x' }))).scanned).toBe(50)
  })
})

describe('events', () => {
  it('paginates newest first with a stable keyset cursor, including ties', async () => {
    const conn = await seedConnection()
    const t = new Date('2026-01-01T00:00:00.000Z')
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push(await seedEvent(conn, { text: `e${i}`, receivedAt: new Date(t.getTime() + Math.floor(i / 2) * 1000) }))
    await h.db.execute(sql`update events set received_at = received_at + interval '123 microseconds' where id = ${ids[6]!}::uuid`)

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const q: string = `/api/events?limit=3${cursor ? `&cursor=${cursor}` : ''}`
      const page: any = await json(api('GET', q))
      seen.push(...page.items.map((e: any) => e.id))
      cursor = page.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(7)
    const expected = await h.db.execute<{ id: string }>(sql`select id from events order by received_at desc, id desc`)
    expect(seen).toEqual(expected.map((r) => r.id))

    expect((await api('GET', '/api/events?cursor=garbage')).status).toBe(400)
  })

  it('filters by provider, connection, type prefix and since', async () => {
    const c1 = await seedConnection()
    const c2 = await seedConnection()
    const old = await seedEvent(c1, { type: 'slack.message.im', provider: 'slack', receivedAt: new Date('2020-01-01T00:00:00Z') })
    const a = await seedEvent(c1, { type: 'slack.message.channel', provider: 'slack' })
    const b = await seedEvent(c2, { type: 'webhook.received' })
    const ids = async (q: string) => (await json(api('GET', `/api/events?${q}`))).items.map((e: any) => e.id).sort()

    expect(await ids('provider=slack')).toEqual([old, a].sort())
    expect(await ids(`connectionId=${c2}`)).toEqual([b])
    expect(await ids('type=slack.message.')).toEqual([old, a].sort())
    expect(await ids('type=slack.message.im')).toEqual([old])
    expect(await ids('type=100%25')).toEqual([])
    expect(await ids('since=2021-01-01T00:00:00Z')).toEqual([a, b].sort())
    expect((await api('GET', '/api/events?since=yesterday')).status).toBe(400)
    expect((await api('GET', '/api/events?connectionId=x')).status).toBe(400)
  })

  it('returns detail with deliveries, actions and agent runs', async () => {
    const conn = await seedConnection()
    const eventId = await seedEvent(conn, { routed: true })
    const dest = await seedDestination()
    const route = await json(api('POST', '/api/routes', { name: 'r', eventType: '*', destinationIds: [dest] }))
    const [delivery] = await h.db
      .insert(schema.deliveries)
      .values({ eventId, routeId: route.id, destinationId: dest, status: 'failed', attempts: 3, lastError: 'boom', lastStatusCode: 500, responseBody: { why: 'x' } })
      .returning()
    await h.db.insert(schema.actionsLog).values({ deliveryId: delivery!.id, idempotencyKey: 'k', type: 'reply', params: { text: 'hi' }, status: 'failed', error: 'nope' })
    await h.db.insert(schema.agentRuns).values({ deliveryId: delivery!.id, leaseUntil: new Date(), status: 'succeeded', turns: 2, costUsd: '0.5' })

    const d = await json(api('GET', `/api/events/${eventId}`))
    expect(d.state).toBe('routed')
    expect(d.routed).toBe(true)
    expect(d.echo).toBe(false)
    expect(d.envelope.id).toBe(eventId)
    expect(d.raw).toEqual({ n: 1 })
    expect(d.deliveries).toHaveLength(1)
    expect(d.deliveries[0]).toMatchObject({ status: 'failed', attempts: 3, lastError: 'boom', responseBody: { why: 'x' }, routeName: 'r', destinationName: 'echo' })
    expect(d.actions).toHaveLength(1)
    expect(d.actions[0]).toMatchObject({ type: 'reply', status: 'failed', error: 'nope' })
    expect(d.agentRuns).toHaveLength(1)
    expect(d.agentRuns[0]).toMatchObject({ turns: 2, status: 'succeeded' })
    expect(JSON.stringify(d)).not.toMatch(/ciphertext/)

    const list = await json(api('GET', '/api/events'))
    expect(list.items[0]).toMatchObject({ id: eventId, deliveryCount: 1, failedCount: 1 })
    expect((await api('GET', `/api/events/${randomUUID()}`)).status).toBe(404)
  })

  it('reports unrouted, unmatched and echo states', async () => {
    const conn = await seedConnection()
    const pending = await seedEvent(conn)
    const unmatched = await seedEvent(conn, { routed: true })
    expect((await json(api('GET', `/api/events/${pending}`))).state).toBe('pending')
    expect((await json(api('GET', `/api/events/${unmatched}`))).state).toBe('unmatched')

    const slackConn = await h.connections.upsertSlack({ teamId: 'T1', userId: 'U1', accessToken: 'xoxp' })
    const echo = await seedEvent(slackConn.id, {
      provider: 'slack',
      type: 'slack.message.im',
      actor: 'U1',
      context: { channelId: 'D1', threadId: '1.1', messageId: '1.2' },
      routed: true,
    })
    await h.db.insert(schema.sentMessages).values({ connectionId: slackConn.id, channel: 'D1', ts: '1.2' })
    const d = await json(api('GET', `/api/events/${echo}`))
    expect(d.echo).toBe(true)
    expect(d.state).toBe('skipped_echo')

    await h.connections.revokeSlack('T1', ['U1'])
    expect((await json(api('GET', `/api/events/${echo}`))).state).toBe('skipped_inactive')
  })

  it('summarizes each event trace in the list', async () => {
    const conn = await seedConnection()
    const dest = await seedDestination()
    const dest2 = await seedDestination()
    const route = await json(api('POST', '/api/routes', { name: 'r', eventType: '*', destinationIds: [dest, dest2] }))
    const deliver = async (eventId: string, status: 'pending' | 'succeeded' | 'failed', destinationId = dest, lastError: string | null = null) => {
      const [d] = await h.db.insert(schema.deliveries).values({ eventId, routeId: route.id, destinationId, status, lastError }).returning()
      return d!
    }

    const pending = await seedEvent(conn)
    const unmatched = await seedEvent(conn, { routed: true })
    const succeeded = await seedEvent(conn, { routed: true })
    const ok = await deliver(succeeded, 'succeeded')
    await h.db.insert(schema.actionsLog).values([
      { deliveryId: ok.id, idempotencyKey: 'a', type: 'reply', params: {}, status: 'succeeded' },
      { deliveryId: ok.id, idempotencyKey: 'b', type: 'react', params: {}, status: 'pending' },
    ])
    const failed = await seedEvent(conn, { routed: true })
    await deliver(failed, 'pending')
    const bad = await deliver(failed, 'failed', dest2, 'HTTP 500')

    const slackConn = await h.connections.upsertSlack({ teamId: 'T1', userId: 'U1', accessToken: 'xoxp' })
    const echo = await seedEvent(slackConn.id, {
      provider: 'slack',
      type: 'slack.message.im',
      context: { channelId: 'D1', threadId: null, messageId: '1.2' },
      routed: true,
    })
    await h.db.insert(schema.sentMessages).values({ connectionId: slackConn.id, channel: 'D1', ts: '1.2' })
    const revokedConn = await seedConnection()
    const inactive = await seedEvent(revokedConn, { routed: true })
    await api('POST', `/api/connections/${revokedConn}/revoke`)

    const items = (await json(api('GET', '/api/events'))).items as any[]
    const trace = (id: string) => items.find((e) => e.id === id).trace
    const none = { pending: 0, succeeded: 0, failed: 0 }

    expect(trace(pending)).toEqual({ routed: 'pending', deliveries: none, actions: none, failedDelivery: null })
    expect(trace(unmatched)).toEqual({ routed: 'unmatched', deliveries: none, actions: none, failedDelivery: null })
    expect(trace(succeeded)).toEqual({
      routed: 'routed',
      deliveries: { ...none, succeeded: 1 },
      actions: { ...none, succeeded: 1, pending: 1 },
      failedDelivery: null,
    })
    expect(trace(failed)).toEqual({
      routed: 'routed',
      deliveries: { ...none, pending: 1, failed: 1 },
      actions: none,
      failedDelivery: { id: bad.id, lastError: 'HTTP 500' },
    })
    expect(trace(echo).routed).toBe('echo')
    expect(trace(inactive).routed).toBe('inactive')
  })

  it('builds the event list page in one query', async () => {
    const conn = await seedConnection()
    const dest = await seedDestination()
    const route = await json(api('POST', '/api/routes', { name: 'r', eventType: '*', destinationIds: [dest] }))
    const countFor = async (n: number) => {
      await resetEvents()
      for (let i = 0; i < n; i++) {
        const e = await seedEvent(conn, { routed: true })
        await h.db.insert(schema.deliveries).values({ eventId: e, routeId: route.id, destinationId: dest, status: 'failed' })
      }
      const client = (h.db as unknown as { $client: { unsafe: (...args: unknown[]) => unknown } }).$client
      const spy = vi.spyOn(client, 'unsafe')
      try {
        const res = await api('GET', '/api/events')
        expect((await json(res)).items).toHaveLength(n)
        return spy.mock.calls.length
      } finally {
        spy.mockRestore()
      }
    }
    const resetEvents = async () => {
      await h.db.delete(schema.deliveries)
      await h.db.delete(schema.events)
    }
    const one = await countFor(1)
    const many = await countFor(12)
    expect(one).toBe(1)
    expect(many).toBe(1)
  })

  it('replays an event with a singleton key', async () => {
    const conn = await seedConnection()
    const id = await seedEvent(conn)
    const res = await api('POST', `/api/events/${id}/replay`)
    expect(res.status).toBe(202)
    await api('POST', `/api/events/${id}/replay`)
    expect(await jobCount(QUEUES.route, id)).toBe(1)
    expect((await api('POST', `/api/events/${randomUUID()}/replay`)).status).toBe(404)
    expect(h.metrics.consoleMutations.get({ resource: 'event', action: 'replay' })).toBe(2)
  })
})

describe('deliveries and tokens', () => {
  async function seedDelivery(status: 'pending' | 'failed' | 'succeeded') {
    const conn = await seedConnection()
    const eventId = await seedEvent(conn)
    const dest = await seedDestination()
    const route = await json(api('POST', '/api/routes', { name: 'r', eventType: '*', destinationIds: [dest] }))
    const [d] = await h.db
      .insert(schema.deliveries)
      .values({ eventId, routeId: route.id, destinationId: dest, status, attempts: 4, lastError: 'e' })
      .returning()
    return d!
  }

  it('lists with a status filter and replays failed deliveries only', async () => {
    const failed = await seedDelivery('failed')
    const ok = await seedDelivery('succeeded')
    expect((await json(api('GET', '/api/deliveries'))).items).toHaveLength(2)
    const only = await json(api('GET', '/api/deliveries?status=failed'))
    expect(only.items.map((d: any) => d.id)).toEqual([failed.id])
    expect(only.items[0]).toMatchObject({ routeName: 'r', destinationName: 'echo', eventType: 'webhook.received' })
    expect((await api('GET', '/api/deliveries?status=weird')).status).toBe(400)

    expect((await api('POST', `/api/deliveries/${ok.id}/replay`)).status).toBe(409)
    expect((await api('POST', `/api/deliveries/${randomUUID()}/replay`)).status).toBe(404)
    const res = await api('POST', `/api/deliveries/${failed.id}/replay`)
    expect(res.status).toBe(202)
    const [row] = await h.db.select().from(schema.deliveries).where(eq(schema.deliveries.id, failed.id))
    expect(row).toMatchObject({ status: 'pending', attempts: 0, lastError: null })
    expect(await jobCount(QUEUES.dispatch, failed.id)).toBe(1)
  })

  it('revokes a reply token by jti', async () => {
    expect((await api('POST', '/api/tokens/revoke', { jti: 'abc-123' })).status).toBe(204)
    const rows = await h.db.select().from(schema.revokedTokens)
    expect(rows.map((r) => r.jti)).toEqual(['abc-123'])
    expect((await api('POST', '/api/tokens/revoke', {})).status).toBe(400)
  })
})

describe('overview', () => {
  it('counts the last 24 hours from SQL', async () => {
    const empty = await json(api('GET', '/api/overview'))
    expect(empty).toMatchObject({ events: 0, deliveries: { pending: 0, succeeded: 0, failed: 0 }, failedActions: 0, agentRuns: 0 })

    const conn = await seedConnection()
    const eventId = await seedEvent(conn)
    await seedEvent(conn, { receivedAt: new Date(Date.now() - 48 * 3600_000) })
    const dest = await seedDestination()
    const route = await json(api('POST', '/api/routes', { name: 'r', eventType: '*', destinationIds: [dest] }))
    const [d1, d2] = await Promise.all(
      (['failed', 'succeeded'] as const).map(async (status) => {
        const e = await seedEvent(conn)
        const [d] = await h.db.insert(schema.deliveries).values({ eventId: e, routeId: route.id, destinationId: dest, status }).returning()
        return d!
      }),
    )
    await h.db.insert(schema.actionsLog).values({ deliveryId: d1!.id, idempotencyKey: 'k', type: 'reply', params: {}, status: 'failed' })
    await h.db.insert(schema.agentRuns).values([
      { deliveryId: d1!.id, leaseUntil: new Date(), costUsd: '0.25' },
      { deliveryId: d2!.id, leaseUntil: new Date(), costUsd: '0.5' },
    ])
    void eventId
    const o = await json(api('GET', '/api/overview'))
    expect(o).toMatchObject({ events: 3, deliveries: { pending: 0, succeeded: 1, failed: 1 }, failedActions: 1, agentRuns: 2 })
    expect(Number(o.agentCostUsd)).toBeCloseTo(0.75)
  })
})
