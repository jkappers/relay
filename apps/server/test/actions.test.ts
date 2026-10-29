import { createCipher, createDestination, createRoute, deriveReplyTokenKey, mintReplyToken, revokeReplyToken, schema } from '@relay/core'
import { TEST_MASTER_KEY } from '@relay/core/testing'
import { describe, expect, it } from 'vitest'
import { MAX_ACTIONS_BODY_BYTES } from '../src/actions'
import { useHarness } from './harness'

const h = useHarness()
const key = deriveReplyTokenKey(TEST_MASTER_KEY)
const now = () => Math.floor(Date.now() / 1000)

async function setupDelivery(allowedActions: string[] | null = null) {
  const connection = await h.connections.upsertSlack({ teamId: 'T1', userId: 'U1', accessToken: 'xoxp-secret-token' })
  const cipher = await createCipher(TEST_MASTER_KEY)
  const { destination } = await createDestination(h.db, cipher, { name: 'd', url: 'http://127.0.0.1:1/x', allowedActions })
  const route = await createRoute(h.db, { name: 'r', eventType: 'slack.*', destinationIds: [destination.id] })
  const eventId = crypto.randomUUID()
  await h.db.insert(schema.events).values({
    id: eventId,
    provider: 'slack',
    connectionId: connection.id,
    dedupKey: eventId,
    raw: {},
    envelope: {
      id: eventId,
      provider: 'slack',
      connectionId: connection.id,
      type: 'slack.message.im',
      subtype: null,
      occurredAt: new Date().toISOString(),
      actor: 'U9',
      context: { channelId: 'D1', threadId: '1.000001', messageId: '1.000001' },
      text: 'hi',
      raw: {},
    },
  })
  const [delivery] = await h.db.insert(schema.deliveries).values({ eventId, routeId: route.id, destinationId: destination.id }).returning()
  const allowed = allowedActions ?? ['reply', 'post', 'react', 'update', 'thread.history']
  const mint = (over: { allowed?: string[]; ttlSeconds?: number; deliveryId?: string } = {}) =>
    mintReplyToken(key, { deliveryId: over.deliveryId ?? delivery!.id, allowed: over.allowed ?? allowed, ttlSeconds: over.ttlSeconds ?? 3600, nowSeconds: now() })
  return { connection, delivery: delivery!, mint }
}

const post = (token: string | null, body: unknown, raw?: string) =>
  h.app.request('/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  })

describe('POST /actions', () => {
  it('200: runs actions and returns one result each', async () => {
    const s = await setupDelivery()
    const res = await post(s.mint().token, {
      actions: [
        { type: 'react', name: 'eyes', idempotencyKey: 'a' },
        { type: 'thread.history' },
      ],
    })
    expect(res.status).toBe(200)
    const { results } = (await res.json()) as { results: { type: string; status: string }[] }
    expect(results.map((r) => [r.type, r.status])).toEqual([['react', 'succeeded'], ['thread.history', 'succeeded']])
    const react = h.slack.calls('reactions.add')[0]!
    expect(react.headers.authorization).toBe('Bearer xoxp-secret-token')
    expect(react.body).toEqual({ channel: 'D1', timestamp: '1.000001', name: 'eyes' })
    expect(h.metrics.actions.get({ provider: 'slack', type: 'react', mode: 'async', outcome: 'succeeded' })).toBe(1)
  })

  it('same idempotencyKey twice calls Slack once and returns the stored result', async () => {
    const s = await setupDelivery()
    const token = s.mint().token
    const body = { actions: [{ type: 'reply', text: 'x', idempotencyKey: 'k' }] }
    const a = await (await post(token, body)).json()
    const b = await (await post(token, body)).json()
    expect(b).toEqual(a)
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
    expect(await h.db.select().from(schema.sentMessages)).toHaveLength(1)
  })

  it('a second token for the same delivery shares idempotency', async () => {
    const s = await setupDelivery()
    const body = { actions: [{ type: 'reply', text: 'x', idempotencyKey: 'k' }] }
    await post(s.mint().token, body)
    await post(s.mint().token, body)
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
  })

  describe('401 with no detail', () => {
    const expect401 = async (res: Response, reason: string) => {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
      expect(h.metrics.replyTokensRejected.get({ reason } as never)).toBe(1)
      expect(h.slack.requests).toHaveLength(0)
    }
    const body = { actions: [{ type: 'react', name: 'eyes', idempotencyKey: 'a' }] }

    it('no header', async () => expect401(await post(null, body), 'malformed'))
    it('garbage', async () => expect401(await post('abc.def', body), 'bad_signature'))
    it('tampered payload', async () => {
      const s = await setupDelivery()
      const [p, mac] = s.mint({ allowed: ['react'] }).token.split('.') as [string, string]
      const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), allowed: ['post'] })).toString('base64url')
      await expect401(await post(`${evil}.${mac}`, body), 'bad_signature')
    })
    it('signed with another key', async () => {
      const s = await setupDelivery()
      const t = mintReplyToken(Buffer.alloc(32, 1), { deliveryId: s.delivery.id, allowed: ['react'], ttlSeconds: 60, nowSeconds: now() })
      await expect401(await post(t.token, body), 'bad_signature')
    })
    it('expired', async () => {
      const s = await setupDelivery()
      await expect401(await post(s.mint({ ttlSeconds: -10 }).token, body), 'expired')
    })
    it('revoked', async () => {
      const s = await setupDelivery()
      const t = s.mint()
      await revokeReplyToken(h.db, t.jti)
      await expect401(await post(t.token, body), 'revoked')
    })
    it('unknown delivery', async () => {
      const s = await setupDelivery()
      await expect401(await post(s.mint({ deliveryId: crypto.randomUUID() }).token, body), 'unknown_delivery')
    })
    it('revoked connection', async () => {
      const s = await setupDelivery()
      await h.connections.revokeSlack('T1', ['U1'])
      await expect401(await post(s.mint().token, body), 'connection_inactive')
    })
  })

  it('403: action type not in the token allowed list, and nothing runs', async () => {
    const s = await setupDelivery()
    const res = await post(s.mint({ allowed: ['react'] }).token, {
      actions: [
        { type: 'react', name: 'eyes', idempotencyKey: 'a' },
        { type: 'post', text: 'x', idempotencyKey: 'b' },
      ],
    })
    expect(res.status).toBe(403)
    expect(h.slack.requests).toHaveLength(0)
    expect(h.metrics.replyTokensRejected.get({ reason: 'action_not_allowed' })).toBe(1)
  })

  describe('400', () => {
    it('missing idempotencyKey on a mutating action', async () => {
      const s = await setupDelivery()
      const res = await post(s.mint().token, { actions: [{ type: 'reply', text: 'x' }] })
      expect(res.status).toBe(400)
      expect(h.slack.requests).toHaveLength(0)
    })
    it('idempotencyKey too long', async () => {
      const s = await setupDelivery()
      const res = await post(s.mint().token, { actions: [{ type: 'reply', text: 'x', idempotencyKey: 'k'.repeat(201) }] })
      expect(res.status).toBe(400)
    })
    it('bad params', async () => {
      const s = await setupDelivery()
      const res = await post(s.mint().token, { actions: [{ type: 'thread.history', limit: 101 }] })
      expect(res.status).toBe(400)
    })
    it('not JSON, wrong shape, empty, or more than 20 actions', async () => {
      const s = await setupDelivery()
      const t = s.mint().token
      expect((await post(t, null, 'nope')).status).toBe(400)
      expect((await post(t, { actions: 'x' })).status).toBe(400)
      expect((await post(t, { actions: [] })).status).toBe(400)
      const many = Array.from({ length: 21 }, (_, i) => ({ type: 'react', name: 'eyes', idempotencyKey: String(i) }))
      expect((await post(t, { actions: many })).status).toBe(400)
      expect(h.slack.requests).toHaveLength(0)
    })
  })

  it('413 over the body limit', async () => {
    const s = await setupDelivery()
    const big = JSON.stringify({ actions: [{ type: 'reply', text: 'x'.repeat(MAX_ACTIONS_BODY_BYTES), idempotencyKey: 'k' }] })
    const res = await post(s.mint().token, null, big)
    expect(res.status).toBe(413)
    expect(h.slack.requests).toHaveLength(0)
  })

  it('reports a retryable Slack failure per action with Retry-After', async () => {
    const s = await setupDelivery()
    h.slack.on('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '12' }, json: { ok: false } }))
    const res = await post(s.mint().token, { actions: [{ type: 'reply', text: 'x', idempotencyKey: 'k' }] })
    expect(res.status).toBe(200)
    expect(res.headers.get('retry-after')).toBe('12')
    expect(await res.json()).toEqual({ results: [{ type: 'reply', status: 'retry', error: 'ratelimited', retryAfterSeconds: 12 }] })
  })
})
