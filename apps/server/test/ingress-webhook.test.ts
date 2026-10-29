import { schema } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { routeJobCount, useHarness, webhookRequest } from './harness'

const h = useHarness()
const outcome = (o: string) => h.metrics.ingressRequests.get({ provider: 'webhook', outcome: o })

describe('POST /hooks/webhook/:connectionId', () => {
  it('accepts a signed event and normalizes its type', async () => {
    const { connection, secret } = await h.connections.createWebhook({ ownerUserId: null })
    const res = await webhookRequest(h.app, connection.id, secret, JSON.stringify({ type: 'deploy.finished', text: 'hi' }))
    expect(res.status).toBe(200)

    const [row] = await h.db.select().from(schema.events)
    expect(row).toMatchObject({ provider: 'webhook', connectionId: connection.id })
    expect(row?.envelope).toMatchObject({ type: 'webhook.deploy.finished', text: 'hi' })
    expect(await routeJobCount(h.db, row!.id)).toBe(1)
    expect(outcome('accepted')).toBe(1)
  })

  it('defaults the type to webhook.event', async () => {
    const { connection, secret } = await h.connections.createWebhook({ ownerUserId: null })
    await webhookRequest(h.app, connection.id, secret, JSON.stringify({ hello: 'world' }))
    const [row] = await h.db.select().from(schema.events)
    expect(row?.envelope).toMatchObject({ type: 'webhook.event' })
  })

  it('dedupes on X-Relay-Event-Id', async () => {
    const { connection, secret } = await h.connections.createWebhook({ ownerUserId: null })
    const a = await webhookRequest(h.app, connection.id, secret, '{"n":1}', { eventId: 'evt-1' })
    const b = await webhookRequest(h.app, connection.id, secret, '{"n":2}', { eventId: 'evt-1' })
    expect([a.status, b.status]).toEqual([200, 200])
    expect(b.headers.get('x-slack-no-retry')).toBeNull()
    const rows = await h.db.select().from(schema.events)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dedupKey).toBe(`${connection.id}:id:evt-1`)
    expect(outcome('duplicate')).toBe(1)
  })

  it('dedupes on body hash without an event id', async () => {
    const { connection, secret } = await h.connections.createWebhook({ ownerUserId: null })
    await webhookRequest(h.app, connection.id, secret, '{"n":1}')
    await webhookRequest(h.app, connection.id, secret, '{"n":1}')
    await webhookRequest(h.app, connection.id, secret, '{"n":2}')
    expect(await h.db.select().from(schema.events)).toHaveLength(2)
  })

  it('scopes dedup keys per connection', async () => {
    const a = await h.connections.createWebhook({ ownerUserId: null })
    const b = await h.connections.createWebhook({ ownerUserId: null })
    await webhookRequest(h.app, a.connection.id, a.secret, '{"n":1}')
    await webhookRequest(h.app, b.connection.id, b.secret, '{"n":1}')
    expect(await h.db.select().from(schema.events)).toHaveLength(2)
  })

  it('rejects a bad signature, wrong secret, and stale timestamp with 401', async () => {
    const { connection, secret } = await h.connections.createWebhook({ ownerUserId: null })
    const tampered = await webhookRequest(h.app, connection.id, secret, '{"n":1}', { signature: 'sha256=00' })
    const wrong = await webhookRequest(h.app, connection.id, 'not-the-secret', '{"n":1}')
    const stale = await webhookRequest(h.app, connection.id, secret, '{"n":1}', {
      timestamp: Math.floor(Date.now() / 1000) - 301,
    })
    expect([tampered.status, wrong.status, stale.status]).toEqual([401, 401, 401])
    expect(await h.db.select().from(schema.events)).toHaveLength(0)
    expect(outcome('bad_signature')).toBe(3)
  })

  it('returns 200 and stores nothing for an unknown connection', async () => {
    const res = await webhookRequest(h.app, '22222222-2222-4222-8222-222222222222', 'x', '{}')
    const notUuid = await webhookRequest(h.app, 'nope', 'x', '{}')
    expect([res.status, notUuid.status]).toEqual([200, 200])
    expect(outcome('unknown_connection')).toBe(2)
  })

  it('stores the webhook secret encrypted', async () => {
    const { connection, secret } = await h.connections.createWebhook({ ownerUserId: null })
    const [cred] = await h.db.select().from(schema.credentials)
    expect(cred?.ciphertext).not.toContain(secret)
    expect(await h.connections.getCredentials(connection.id)).toEqual({ webhook_secret: secret })
  })
})
