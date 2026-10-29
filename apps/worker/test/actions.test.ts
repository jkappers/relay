import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { createActionExecutor, createDestination, QUEUES, schema, verifyReplyToken, type ActionResult, type Envelope, type RouteJob } from '@relay/core'
import { createSlackRuntime, eventCallbackSchema, normalizeSlack } from '@relay/provider-slack'
import { describe, expect, it } from 'vitest'
import { createSweeper } from '../src/sweeper'
import { createRouter } from '../src/router'
import { getDelivery, insertEvent, makeRoute, respond, SLACK_USER, slackSetup, startReceiver, useHarness } from './harness'

const h = useHarness()
const TOKEN = 'xoxp-test-token'

function fixtureEnvelope(name: string): Partial<Envelope> {
  const url = new URL(`../../../packages/providers/slack/test/fixtures/${name}.json`, import.meta.url)
  const cb = eventCallbackSchema.parse(JSON.parse(readFileSync(url, 'utf8')))
  const { id: _id, connectionId: _c, ...rest } = normalizeSlack(cb, { eventId: crypto.randomUUID(), connectionId: crypto.randomUUID() })
  return rest
}

const run = (deliveryId: string, actions: Record<string, unknown>[], mode: 'sync' | 'async' = 'sync') =>
  h.execute(deliveryId, actions as { type: string }[], mode)

const jobsNamed = (name: string) =>
  h.db.execute<{ data: Record<string, unknown>; start_after: Date; state: string }>(
    sql`select data, start_after, state from pgboss.job where name = ${name} order by created_on`,
  )

describe('slack actions', () => {
  it('reply posts into the thread of a top-level message (thread_ts = ts)', async () => {
    const s = await slackSetup(h, { envelope: fixtureEnvelope('message_channels') })
    const env = s.event.envelope
    const [r] = await run(s.delivery.id, [{ type: 'reply', text: 'hello' }])
    expect(r).toMatchObject({ status: 'succeeded' })
    expect(h.slack.requests).toHaveLength(1)
    const req = h.slack.requests[0]!
    expect(req.method).toBe('POST')
    expect(req.slackMethod).toBe('chat.postMessage')
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req.body).toEqual({ channel: env.context.channelId, text: 'hello', thread_ts: env.context.messageId })
  })

  it('uses the token of the event connection, never another connection', async () => {
    await h.connections.upsertSlack({ teamId: 'T999OTHER', userId: 'U999OTHER', accessToken: 'xoxp-other-tenant', ownerUserId: null })
    const s = await slackSetup(h)
    await h.connections.upsertSlack({ teamId: 'T888OTHER', userId: 'U888OTHER', accessToken: 'xoxp-third-tenant', ownerUserId: null })
    await run(s.delivery.id, [{ type: 'reply', text: 'hi' }])
    await run(s.delivery.id, [{ type: 'thread.history' }], 'async')
    expect(h.slack.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
  })

  it('reply uses the parent thread_ts for a message inside a thread', async () => {
    const s = await slackSetup(h, { envelope: fixtureEnvelope('message_channels_thread_reply') })
    const env = s.event.envelope
    expect(env.context.threadId).not.toBe(env.context.messageId)
    await run(s.delivery.id, [{ type: 'reply', text: 'x' }])
    expect(h.slack.requests[0]!.body.thread_ts).toBe(env.context.threadId)
  })

  it('post sends to the same channel without thread_ts', async () => {
    const s = await slackSetup(h)
    await run(s.delivery.id, [{ type: 'post', text: 'plain' }])
    expect(h.slack.requests[0]!.body).toEqual({ channel: 'D024BE91L', text: 'plain' })
  })

  it('cannot target another channel: extra params are ignored', async () => {
    const s = await slackSetup(h)
    await run(s.delivery.id, [{ type: 'post', text: 'plain', channel: 'C999', thread_ts: '1.1' }])
    expect(h.slack.requests[0]!.body).toEqual({ channel: 'D024BE91L', text: 'plain' })
  })

  it('react adds a reaction on the source message', async () => {
    const s = await slackSetup(h)
    const [r] = await run(s.delivery.id, [{ type: 'react', name: 'eyes' }])
    expect(r!.status).toBe('succeeded')
    const req = h.slack.requests[0]!
    expect(req.slackMethod).toBe('reactions.add')
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req.body).toEqual({ channel: 'D024BE91L', timestamp: '1355517523.000005', name: 'eyes' })
  })

  it('react treats already_reacted as success', async () => {
    const s = await slackSetup(h)
    h.slack.on('reactions.add', () => ({ json: { ok: false, error: 'already_reacted' } }))
    const [r] = await run(s.delivery.id, [{ type: 'react', name: 'eyes' }])
    expect(r!.status).toBe('succeeded')
  })

  it('update edits a message relay sent and refuses others', async () => {
    const s = await slackSetup(h)
    const [posted] = await run(s.delivery.id, [{ type: 'reply', text: 'v1' }])
    const ts = (posted!.result as { ts: string }).ts

    const [ok] = await run(s.delivery.id, [{ type: 'update', messageId: ts, text: 'v2' }], 'async').catch(() => [])
    expect(ok).toMatchObject({ status: 'failed', error: 'idempotency_key_required' })

    const [updated] = await run(s.delivery.id, [{ type: 'update', messageId: ts, text: 'v2', idempotencyKey: 'u1' }], 'async')
    expect(updated!.status).toBe('succeeded')
    const req = h.slack.calls('chat.update')[0]!
    expect(req.body).toEqual({ channel: 'D024BE91L', ts, text: 'v2' })

    const [refused] = await run(s.delivery.id, [{ type: 'update', messageId: '1111.2222', text: 'x', idempotencyKey: 'u2' }], 'async')
    expect(refused).toMatchObject({ status: 'failed', error: 'message_not_sent_by_relay' })
    expect(h.slack.calls('chat.update')).toHaveLength(1)
  })

  it('update refuses a ts relay sent in a different channel', async () => {
    const s = await slackSetup(h)
    await h.db.insert(schema.sentMessages).values({ connectionId: s.connection.id, channel: 'COTHER', ts: '5.5' })
    const [r] = await run(s.delivery.id, [{ type: 'update', messageId: '5.5', text: 'x', idempotencyKey: 'k' }], 'async')
    expect(r).toMatchObject({ status: 'failed', error: 'message_not_sent_by_relay' })
    expect(h.slack.requests).toHaveLength(0)
  })

  it('thread.history reads the thread and returns a trimmed list; it is not logged', async () => {
    const s = await slackSetup(h)
    const [r] = await run(s.delivery.id, [{ type: 'thread.history', limit: 5 }])
    expect(r!.status).toBe('succeeded')
    const req = h.slack.requests[0]!
    expect(req.method).toBe('GET')
    expect(req.slackMethod).toBe('conversations.replies')
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req.body).toEqual({ channel: 'D024BE91L', ts: '1355517523.000005', limit: '5' })
    expect(r!.result).toEqual({
      messages: [
        { ts: '1355517523.000005', user: 'U1', text: 'parent', thread_ts: '1355517523.000005' },
        { ts: '1700000001.000001', user: 'U2', text: 'child', thread_ts: '1355517523.000005' },
      ],
      hasMore: false,
    })
    expect(await h.db.select().from(schema.actionsLog)).toHaveLength(0)
  })

  it('rejects invalid params and unknown or disallowed actions without calling Slack', async () => {
    const s = await slackSetup(h, { allowedActions: ['reply'] })
    const results = await run(s.delivery.id, [
      { type: 'reply' },
      { type: 'nope' },
      { type: 'post', text: 'x' },
      { type: 'thread.history', limit: 500 },
    ])
    expect(results.map((r) => r.error)).toEqual(['invalid_params', 'not_allowed', 'not_allowed', 'not_allowed'])
    expect(h.slack.requests).toHaveLength(0)
  })

  describe('errors', () => {
    const first = async (reply: Parameters<typeof h.slack.on>[1]) => {
      const s = await slackSetup(h)
      h.slack.on('chat.postMessage', reply)
      const [r] = await run(s.delivery.id, [{ type: 'post', text: 'x' }])
      return { r: r!, s }
    }

    it('HTTP 429 is retryable and carries Retry-After', async () => {
      const { r } = await first(() => ({ status: 429, headers: { 'retry-after': '7' }, json: { ok: false, error: 'ratelimited' } }))
      expect(r).toMatchObject({ status: 'retry', error: 'ratelimited', retryAfterSeconds: 7 })
    })
    it('ok:false ratelimited is retryable', async () => {
      const { r } = await first(() => ({ json: { ok: false, error: 'ratelimited' } }))
      expect(r.status).toBe('retry')
    })
    it('5xx is retryable', async () => {
      const { r } = await first(() => ({ status: 503, json: {} }))
      expect(r.status).toBe('retry')
    })
    it('other ok:false errors are final', async () => {
      const { r, s } = await first(() => ({ json: { ok: false, error: 'channel_not_found' } }))
      expect(r).toMatchObject({ status: 'failed', error: 'channel_not_found' })
      const [row] = await h.db.select().from(schema.actionsLog).where(eq(schema.actionsLog.deliveryId, s.delivery.id))
      expect(row).toMatchObject({ status: 'failed', error: 'channel_not_found' })
      const [again] = await run(s.delivery.id, [{ type: 'post', text: 'x' }])
      expect(again).toMatchObject({ status: 'failed', error: 'channel_not_found' })
      expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
      expect(h.metrics.actions.get({ provider: 'slack', type: 'post', mode: 'sync', outcome: 'replayed' })).toBe(1)
    })
    it('network errors are retryable', async () => {
      const s = await slackSetup(h)
      const execute = createActionExecutor({
        db: h.db,
        connections: h.connections,
        runtimes: { slack: createSlackRuntime({ db: h.db, apiBase: 'http://127.0.0.1:1/api' }) },
      })
      const [r] = await execute(s.delivery.id, [{ type: 'post', text: 'x' }], 'sync')
      expect(r).toMatchObject({ status: 'retry', error: 'network_error' })
    })
  })
})

describe('idempotency', () => {
  it('running the same sync actions twice posts once and returns the stored result', async () => {
    const s = await slackSetup(h)
    const actions = [{ type: 'reply', text: 'a' }, { type: 'react', name: 'tada' }]
    const first = await run(s.delivery.id, actions)
    const second = await run(s.delivery.id, actions)
    expect(second).toEqual(first)
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
    expect(h.slack.calls('reactions.add')).toHaveLength(1)
    const rows = await h.db.select().from(schema.actionsLog).where(eq(schema.actionsLog.deliveryId, s.delivery.id))
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual(['sync:0', 'sync:1'])
    expect(await h.db.select().from(schema.sentMessages)).toHaveLength(1)
    expect(h.metrics.actions.get({ provider: 'slack', type: 'reply', mode: 'sync', outcome: 'replayed' })).toBe(1)
  })

  it('the same async idempotencyKey posts once and returns the stored result', async () => {
    const s = await slackSetup(h)
    const a = { type: 'reply', text: 'a', idempotencyKey: 'k1' }
    const first = await run(s.delivery.id, [a], 'async')
    const second = await run(s.delivery.id, [a], 'async')
    expect(second).toEqual(first)
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
  })

  it('the same key with different params is a conflict and does not call Slack', async () => {
    const s = await slackSetup(h)
    await run(s.delivery.id, [{ type: 'reply', text: 'a', idempotencyKey: 'k1' }], 'async')
    const [r] = await run(s.delivery.id, [{ type: 'reply', text: 'DIFFERENT', idempotencyKey: 'k1' }], 'async')
    expect(r).toMatchObject({ status: 'failed', error: 'idempotency_key_conflict' })
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
  })

  it('a fresh pending row returns in_progress; a stale one is re-run', async () => {
    const s = await slackSetup(h)
    await h.db.insert(schema.actionsLog).values({
      deliveryId: s.delivery.id,
      idempotencyKey: 'k1',
      type: 'reply',
      params: { text: 'a' },
      status: 'pending',
    })
    const a = { type: 'reply', text: 'a', idempotencyKey: 'k1' }
    const [fresh] = await run(s.delivery.id, [a], 'async')
    expect(fresh!.status).toBe('in_progress')
    expect(h.slack.requests).toHaveLength(0)

    await h.db.update(schema.actionsLog).set({ updatedAt: new Date(Date.now() - 120_000) })
    const [stale] = await run(s.delivery.id, [a], 'async')
    expect(stale!.status).toBe('succeeded')
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
    const [row] = await h.db.select().from(schema.actionsLog)
    expect(row).toMatchObject({ status: 'succeeded', attempts: 2 })
  })

  it('a retryable failure releases the claim so the next attempt runs at once', async () => {
    const s = await slackSetup(h)
    let n = 0
    h.slack.on('chat.postMessage', () => (++n === 1 ? { status: 500, json: {} } : undefined))
    const [a] = await run(s.delivery.id, [{ type: 'reply', text: 'a' }])
    expect(a!.status).toBe('retry')
    const [b] = await run(s.delivery.id, [{ type: 'reply', text: 'a' }])
    expect(b!.status).toBe('succeeded')
    expect(h.slack.calls('chat.postMessage')).toHaveLength(2)
    expect(await h.db.select().from(schema.sentMessages)).toHaveLength(1)
  })

  it('gives up after the attempt cap', async () => {
    const s = await slackSetup(h)
    h.slack.on('chat.postMessage', () => ({ status: 500, json: {} }))
    let last: ActionResult | undefined
    for (let i = 0; i < 8; i++) last = (await run(s.delivery.id, [{ type: 'reply', text: 'a' }]))[0]
    expect(last).toMatchObject({ status: 'failed' })
    expect(last!.error).toMatch(/^retries_exhausted/)
  })

  it('refuses actions when the connection is revoked', async () => {
    const s = await slackSetup(h)
    await h.connections.revokeSlack('T123ABC456', [SLACK_USER])
    const [r] = await run(s.delivery.id, [{ type: 'post', text: 'x' }])
    expect(r).toMatchObject({ status: 'failed', error: 'connection_inactive' })
    expect(h.slack.requests).toHaveLength(0)
  })
})

describe('sync path', () => {
  it('end to end: response actions become one Slack post, a sent_messages row, and actions_done_at', async () => {
    const receiver = await startReceiver(respond(200, { actions: [{ type: 'reply', text: 'hi' }] }))
    const s = await slackSetup(h, { url: receiver.url })
    await h.dispatcher({ deliveryId: s.delivery.id })

    const sent = JSON.parse(receiver.requests[0]!.body)
    expect(sent.reply.actionsUrl).toBe('http://relay.test/actions')
    expect(sent.reply.allowed.sort()).toEqual(['post', 'react', 'reply', 'thread.history', 'update'])
    const check = await verifyReplyToken(h.db, h.replyKey, sent.reply.token, Math.floor(Date.now() / 1000))
    expect(check.ok).toBe(true)
    expect((await getDelivery(h, s.delivery.id)).lastReplyJti).toBe(check.ok ? check.payload.jti : null)

    const jobs = await jobsNamed(QUEUES.actions)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.data).toEqual({ deliveryId: s.delivery.id })

    await h.actions({ deliveryId: s.delivery.id })
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
    expect(h.slack.requests[0]!.body.text).toBe('hi')
    expect(await h.db.select().from(schema.sentMessages)).toHaveLength(1)
    expect((await getDelivery(h, s.delivery.id)).actionsDoneAt).not.toBeNull()

    await h.actions({ deliveryId: s.delivery.id })
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
    await receiver.close()
  })

  it('mints a fresh token on every attempt', async () => {
    const receiver = await startReceiver([respond(500), respond(200, {})])
    const s = await slackSetup(h, { url: receiver.url })
    await h.dispatcher({ deliveryId: s.delivery.id })
    await h.dispatcher({ deliveryId: s.delivery.id })
    const [t1, t2] = receiver.requests.map((r) => JSON.parse(r.body).reply.token as string)
    expect(t1).not.toBe(t2)
    await receiver.close()
  })

  it('limits allowed actions to the destination list, and omits reply when none remain', async () => {
    const receiver = await startReceiver(respond(200, {}))
    const s = await slackSetup(h, { url: receiver.url, allowedActions: ['react', 'bogus'] })
    await h.dispatcher({ deliveryId: s.delivery.id })
    expect(JSON.parse(receiver.requests[0]!.body).reply.allowed).toEqual(['react'])
    await receiver.close()

    const r2 = await startReceiver(respond(200, {}))
    const s2 = await slackSetup(h, { url: r2.url, allowedActions: [] })
    await h.dispatcher({ deliveryId: s2.delivery.id })
    expect(JSON.parse(r2.requests[0]!.body).reply).toBeUndefined()
    await r2.close()
  })

  it('sync actions outside the destination allow-list are not run', async () => {
    const receiver = await startReceiver(respond(200, { actions: [{ type: 'post', text: 'x' }] }))
    const s = await slackSetup(h, { url: receiver.url, allowedActions: ['react'] })
    await h.dispatcher({ deliveryId: s.delivery.id })
    await h.actions({ deliveryId: s.delivery.id })
    expect(h.slack.requests).toHaveLength(0)
    expect((await getDelivery(h, s.delivery.id)).actionsDoneAt).not.toBeNull()
    await receiver.close()
  })

  it('ignores more than 20 actions and does not queue a job', async () => {
    const many = Array.from({ length: 21 }, () => ({ type: 'react', name: 'eyes' }))
    const receiver = await startReceiver(respond(200, { actions: many }))
    const s = await slackSetup(h, { url: receiver.url })
    await h.dispatcher({ deliveryId: s.delivery.id })
    expect(await jobsNamed(QUEUES.actions)).toHaveLength(0)
    expect((await getDelivery(h, s.delivery.id)).actionsDoneAt).not.toBeNull()
    await receiver.close()
  })

  it('a retryable Slack error makes the handler throw and later succeed, posting once', async () => {
    const receiver = await startReceiver(respond(200, { actions: [{ type: 'reply', text: 'hi' }] }))
    const s = await slackSetup(h, { url: receiver.url })
    await h.dispatcher({ deliveryId: s.delivery.id })
    let n = 0
    h.slack.on('chat.postMessage', () => (++n === 1 ? { status: 500, json: {} } : undefined))
    await expect(h.actions({ deliveryId: s.delivery.id })).rejects.toThrow()
    expect((await getDelivery(h, s.delivery.id)).actionsDoneAt).toBeNull()
    await h.actions({ deliveryId: s.delivery.id })
    expect((await getDelivery(h, s.delivery.id)).actionsDoneAt).not.toBeNull()
    expect(await h.db.select().from(schema.sentMessages)).toHaveLength(1)
    await receiver.close()
  })

  it('on 429 with Retry-After the handler reschedules instead of throwing', async () => {
    const receiver = await startReceiver(respond(200, { actions: [{ type: 'reply', text: 'hi' }] }))
    const s = await slackSetup(h, { url: receiver.url })
    await h.dispatcher({ deliveryId: s.delivery.id })
    await h.db.execute(sql`delete from pgboss.job where name = ${QUEUES.actions}`)
    h.slack.on('chat.postMessage', () => ({ status: 429, headers: { 'retry-after': '30' }, json: { ok: false } }))
    await h.actions({ deliveryId: s.delivery.id })
    const [job] = await jobsNamed(QUEUES.actions)
    expect(new Date(job!.start_after).getTime()).toBeGreaterThan(Date.now() + 20_000)
    await receiver.close()
  })
})

describe('sweeper: actions', () => {
  const sweeper = () => createSweeper({ db: h.db, queue: h.queue, metrics: h.metrics, graceMs: 60_000 })

  it('picks up a succeeded delivery whose actions never finished', async () => {
    const s = await slackSetup(h)
    const old = new Date(Date.now() - 10 * 60_000)
    await h.db
      .update(schema.deliveries)
      .set({ status: 'succeeded', completedAt: old, responseBody: { actions: [{ type: 'reply', text: 'hi' }] } })
      .where(eq(schema.deliveries.id, s.delivery.id))

    expect(await sweeper()()).toMatchObject({ actions: 1 })
    expect(await jobsNamed(QUEUES.actions)).toHaveLength(1)
    expect(h.metrics.sweeperRequeued.get({ kind: 'actions' })).toBe(1)
    expect(await sweeper()()).toMatchObject({ actions: 0 })

    await h.actions({ deliveryId: s.delivery.id })
    expect(h.slack.calls('chat.postMessage')).toHaveLength(1)
    expect(await sweeper()()).toMatchObject({ actions: 0 })
  })

  it('ignores recent deliveries, finished ones, and responses without actions', async () => {
    const a = await slackSetup(h)
    const body = { actions: [{ type: 'reply', text: 'hi' }] }
    const old = new Date(Date.now() - 10 * 60_000)
    await h.db.update(schema.deliveries).set({ status: 'succeeded', completedAt: new Date(), responseBody: body }).where(eq(schema.deliveries.id, a.delivery.id))
    expect(await sweeper()()).toMatchObject({ actions: 0 })
    await h.db.update(schema.deliveries).set({ completedAt: old, actionsDoneAt: new Date() }).where(eq(schema.deliveries.id, a.delivery.id))
    expect(await sweeper()()).toMatchObject({ actions: 0 })
    await h.db.update(schema.deliveries).set({ actionsDoneAt: null, responseBody: { ok: true } }).where(eq(schema.deliveries.id, a.delivery.id))
    expect(await sweeper()()).toMatchObject({ actions: 0 })
  })
})

describe('loop guard', () => {
  const ts = '1700000000.000042'
  const selfEvent = (over: Partial<Envelope> = {}) => ({
    provider: 'slack',
    type: 'slack.message.im',
    actor: SLACK_USER,
    context: { channelId: 'D024BE91L', threadId: ts, messageId: ts },
    ...over,
  })

  async function withRoute() {
    const { connection } = await slackSetup(h)
    await h.db.delete(schema.deliveries)
    return connection
  }

  it('skips an event whose ts relay sent', async () => {
    const connection = await withRoute()
    await h.db.insert(schema.sentMessages).values({ connectionId: connection.id, channel: 'D024BE91L', ts })
    const ev = await insertEvent(h, connection.id, selfEvent())
    await h.router({ eventId: ev.id })
    expect(h.metrics.routerEvents.get({ outcome: 'skipped_echo' })).toBe(1)
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(0)
    const [row] = await h.db.select().from(schema.events).where(eq(schema.events.id, ev.id))
    expect(row!.routedAt).not.toBeNull()
  })

  it('skips an echo from another actor too (match is on sent_messages)', async () => {
    const connection = await withRoute()
    await h.db.insert(schema.sentMessages).values({ connectionId: connection.id, channel: 'D024BE91L', ts })
    const ev = await insertEvent(h, connection.id, selfEvent({ actor: 'U0OTHER' }))
    await h.router({ eventId: ev.id })
    expect(h.metrics.routerEvents.get({ outcome: 'skipped_echo' })).toBe(1)
  })

  it('does not skip when the ts was sent in another channel', async () => {
    const connection = await withRoute()
    await h.db.insert(schema.sentMessages).values({ connectionId: connection.id, channel: 'COTHER', ts })
    const ev = await insertEvent(h, connection.id, selfEvent({ actor: 'U0OTHER' }))
    await h.router({ eventId: ev.id })
    expect(h.metrics.routerEvents.get({ outcome: 'matched' })).toBe(1)
  })

  it('rechecks a self-authored event, then skips it once the row exists', async () => {
    const connection = await withRoute()
    const ev = await insertEvent(h, connection.id, selfEvent())
    await h.router({ eventId: ev.id })
    expect(h.metrics.routerEvents.get({ outcome: 'echo_recheck' })).toBe(1)
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(0)
    const [row] = await h.db.select().from(schema.events).where(eq(schema.events.id, ev.id))
    expect(row!.routedAt).toBeNull()
    const jobs = await jobsNamed(QUEUES.route)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.data).toEqual({ eventId: ev.id, recheck: true })
    expect(new Date(jobs[0]!.start_after).getTime()).toBeGreaterThan(Date.now() + 3_000)

    await h.db.insert(schema.sentMessages).values({ connectionId: connection.id, channel: 'D024BE91L', ts })
    await h.router({ eventId: ev.id, recheck: true })
    expect(h.metrics.routerEvents.get({ outcome: 'skipped_echo' })).toBe(1)
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(0)
  })

  it('routes a genuinely new self-authored event (a DM to yourself) after the recheck', async () => {
    const connection = await withRoute()
    const ev = await insertEvent(h, connection.id, selfEvent())
    await h.router({ eventId: ev.id })
    await h.router({ eventId: ev.id, recheck: true })
    expect(h.metrics.routerEvents.get({ outcome: 'matched' })).toBe(1)
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(1)
  })

  it('routes other actors and old self-authored events at once', async () => {
    const connection = await withRoute()
    const other = await insertEvent(h, connection.id, selfEvent({ actor: 'U0OTHER' }))
    await h.router({ eventId: other.id })
    const old = await insertEvent(h, connection.id, selfEvent({ context: { channelId: 'D024BE91L', threadId: '1.1', messageId: '1.1' } }))
    await h.db.update(schema.events).set({ receivedAt: new Date(Date.now() - 120_000) }).where(eq(schema.events.id, old.id))
    await h.router({ eventId: old.id })
    expect(h.metrics.routerEvents.get({ outcome: 'matched' })).toBe(2)
    expect(h.metrics.routerEvents.get({ outcome: 'echo_recheck' })).toBe(0)
  })

  it('webhook events are never echoes', async () => {
    const { connection } = await h.connections.createWebhook({ ownerUserId: null })
    const dest = await createDestination(h.db, h.cipher, connection.id, { name: 'd', url: 'http://127.0.0.1:1/x' })
    await makeRoute(h, { destinationIds: [dest.destination.id] })
    const ev = await insertEvent(h, connection.id)
    await h.router({ eventId: ev.id })
    expect(h.metrics.routerEvents.get({ outcome: 'matched' })).toBe(1)
  })

  it('a running route job can queue its own recheck under policy short', async () => {
    const connection = await withRoute()
    const router = createRouter({ db: h.db, queue: h.queue, metrics: h.metrics, runtimes: h.runtimes, recheckDelayMs: 300 })
    const ev = await insertEvent(h, connection.id, selfEvent())
    await h.queue.work<RouteJob>(QUEUES.route, async (jobs) => {
      for (const j of jobs) await router(j.data)
    }, { pollingIntervalSeconds: 0.5 })
    await h.queue.send<RouteJob>(QUEUES.route, { eventId: ev.id }, { singletonKey: ev.id })
    await expect.poll(async () => h.metrics.routerEvents.get({ outcome: 'matched' }), { timeout: 15_000, interval: 200 }).toBe(1)
    expect(h.metrics.routerEvents.get({ outcome: 'echo_recheck' })).toBe(1)
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(1)
  })
})
