import { createHmac } from 'node:crypto'
import { replayDelivery, QUEUES, type DispatchJob } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { createDispatcher } from '../src/dispatcher'
import {
  dispatchJobs,
  getDelivery,
  insertEvent,
  makeDelivery,
  makeRoute,
  respond,
  setup,
  startReceiver,
  useHarness,
  type Harness,
} from './harness'

const h = useHarness({ backoffBaseMs: 10, backoffCapMs: 50 })

async function scenario(
  handlers: Parameters<typeof startReceiver>[0],
  dest: { maxAttempts?: number; timeoutMs?: number } = {},
) {
  const receiver = await startReceiver(handlers)
  const s = await setup(h, { url: receiver.url, ...dest })
  const route = await makeRoute(h, { destinationIds: [s.destination.id] })
  const event = await insertEvent(h, s.connection.id)
  const delivery = await makeDelivery(h, event.id, route.id, s.destination.id)
  const run = (hh: Harness = h) => hh.dispatcher({ deliveryId: delivery.id })
  return { receiver, secret: s.secret, event, delivery, run, get: () => getDelivery(h, delivery.id) }
}

describe('dispatcher', () => {
  it('delivers a signed request and stores the JSON response', async () => {
    const s = await scenario(respond(200, { actions: [{ type: 'reply' }] }))
    await s.run()
    const row = await s.get()
    expect(row.status).toBe('succeeded')
    expect(row.attempts).toBe(1)
    expect(row.lastStatusCode).toBe(200)
    expect(row.completedAt).not.toBeNull()
    expect(row.responseBody).toEqual({ actions: [{ type: 'reply' }] })

    const [req] = s.receiver.requests
    expect(s.receiver.requests).toHaveLength(1)
    expect(req!.headers['content-type']).toBe('application/json')
    expect(req!.headers['user-agent']).toMatch(/^relay\/\d/)
    expect(req!.headers['relay-delivery-id']).toBe(s.delivery.id)
    expect(req!.headers['relay-event-id']).toBe(s.event.id)
    const ts = String(req!.headers['relay-timestamp'])
    expect(req!.headers['relay-signature']).toBe(
      `sha256=${createHmac('sha256', s.secret).update(`${ts}.${req!.body}`).digest('hex')}`,
    )
    expect(JSON.parse(req!.body)).toEqual({ ...s.event.envelope, delivery: { id: s.delivery.id, attempt: 1 } })
    expect(h.metrics.deliveryAttempts.get({ outcome: 'success' })).toBe(1)
    await s.receiver.close()
  })

  it('does not store a non-JSON response', async () => {
    const s = await scenario(respond(200, 'ok'))
    await s.run()
    const row = await s.get()
    expect(row.status).toBe('succeeded')
    expect(row.responseBody).toBeNull()
    await s.receiver.close()
  })

  it('does not store a JSON response over 64 KB', async () => {
    const s = await scenario(respond(200, { blob: 'x'.repeat(70 * 1024) }))
    await s.run()
    const row = await s.get()
    expect(row.status).toBe('succeeded')
    expect(row.responseBody).toBeNull()
    await s.receiver.close()
  })

  it('retries a 500 and then succeeds', async () => {
    const s = await scenario([respond(500), respond(200, { ok: true })])
    await s.run()
    let row = await s.get()
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.lastStatusCode).toBe(500)
    expect(row.lastError).toBe('HTTP 500')
    expect(row.nextAttemptAt).not.toBeNull()
    const jobs = await dispatchJobs(h)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.startAfter.getTime()).toBeLessThanOrEqual(row.nextAttemptAt!.getTime() + 5)

    await s.run()
    row = await s.get()
    expect(row.status).toBe('succeeded')
    expect(row.attempts).toBe(2)
    expect(JSON.parse(s.receiver.requests[1]!.body).delivery.attempt).toBe(2)
    expect(h.metrics.deliveryAttempts.get({ outcome: 'retry' })).toBe(1)
    await s.receiver.close()
  })

  it('retries a timeout', async () => {
    const s = await scenario([() => {}, respond(200, { ok: true })], { timeoutMs: 150 })
    await s.run()
    let row = await s.get()
    expect(row.status).toBe('pending')
    expect(row.lastError).toBe('timeout after 150ms')
    expect(row.lastStatusCode).toBeNull()
    await s.run()
    row = await s.get()
    expect(row.status).toBe('succeeded')
    await s.receiver.close()
  })

  it('retries a network error', async () => {
    const s = await scenario(respond(200))
    await s.receiver.close()
    await s.run()
    const row = await s.get()
    expect(row.status).toBe('pending')
    expect(row.lastError).toBeTruthy()
  })

  it('fails a 400 immediately', async () => {
    const s = await scenario(respond(400))
    await s.run()
    const row = await s.get()
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.lastStatusCode).toBe(400)
    expect(await dispatchJobs(h)).toHaveLength(0)
    expect(h.metrics.deliveryAttempts.get({ outcome: 'failed_non_retryable' })).toBe(1)
    await s.receiver.close()
  })

  it('does not follow redirects', async () => {
    const s = await scenario(respond(302, undefined, { location: 'http://127.0.0.1:1/x' }))
    await s.run()
    expect((await s.get()).status).toBe('failed')
    await s.receiver.close()
  })

  it('fails with failed_exhausted when attempts run out', async () => {
    const s = await scenario(respond(503), { maxAttempts: 2 })
    await s.run()
    expect((await s.get()).status).toBe('pending')
    await s.run()
    const row = await s.get()
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(2)
    expect(row.completedAt).not.toBeNull()
    expect(await dispatchJobs(h)).toHaveLength(1)
    expect(h.metrics.deliveryAttempts.get({ outcome: 'retry' })).toBe(1)
    expect(h.metrics.deliveryAttempts.get({ outcome: 'failed_exhausted' })).toBe(1)
    await s.receiver.close()
  })

  it('honors Retry-After on 429, capped at the backoff cap', async () => {
    const s = await scenario(respond(429, undefined, { 'retry-after': '3600' }))
    const before = Date.now()
    await s.run()
    const row = await s.get()
    expect(row.status).toBe('pending')
    const delay = row.nextAttemptAt!.getTime() - before
    expect(delay).toBeGreaterThanOrEqual(45)
    expect(delay).toBeLessThan(500)
    await s.receiver.close()
  })

  it('uses Retry-After below the cap', async () => {
    const h2 = useHarnessOnce()
    const s = await scenario(respond(429, undefined, { 'retry-after': '2' }))
    const before = Date.now()
    await h2.dispatcher({ deliveryId: s.delivery.id })
    const delay = (await s.get()).nextAttemptAt!.getTime() - before
    expect(delay).toBeGreaterThanOrEqual(1900)
    expect(delay).toBeLessThan(2500)
    await s.receiver.close()
  })

  it('treats a duplicate job for a finished delivery as a no-op', async () => {
    const s = await scenario(respond(200, { ok: true }))
    await s.run()
    await s.run()
    expect(s.receiver.requests).toHaveLength(1)
    expect((await s.get()).attempts).toBe(1)
    await s.receiver.close()
  })

  it('replays a failed delivery through to success', async () => {
    const s = await scenario([respond(400), respond(200, { ok: true })])
    await s.run()
    expect((await s.get()).status).toBe('failed')

    await replayDelivery(h.db, h.queue, s.delivery.id)
    let row = await s.get()
    expect(row).toMatchObject({ status: 'pending', attempts: 0, lastError: null, lastStatusCode: null, completedAt: null })
    expect(await dispatchJobs(h)).toHaveLength(1)

    await s.run()
    row = await s.get()
    expect(row.status).toBe('succeeded')
    expect(row.attempts).toBe(1)
    await s.receiver.close()
  })

  it('refuses to replay a delivery that is not failed', async () => {
    const s = await scenario(respond(200))
    await expect(replayDelivery(h.db, h.queue, s.delivery.id)).rejects.toThrow(/not in failed/)
    await s.receiver.close()
  })

  it('runs retries end to end through a real pg-boss worker', async () => {
    const s = await scenario([respond(500), respond(500), respond(200, { ok: true })])
    await h.queue.work<DispatchJob>(
      QUEUES.dispatch,
      async (jobs) => {
        for (const j of jobs) await h.dispatcher(j.data)
      },
      { pollingIntervalSeconds: 0.5 },
    )
    await h.queue.send<DispatchJob>(QUEUES.dispatch, { deliveryId: s.delivery.id })
    await expect.poll(async () => (await s.get()).status, { timeout: 15_000, interval: 200 }).toBe('succeeded')
    expect((await s.get()).attempts).toBe(3)
    await s.receiver.close()
  })
})

function useHarnessOnce(): Harness {
  const dispatcher = createDispatcher({
    db: h.db,
    queue: h.queue,
    cipher: h.cipher,
    metrics: h.metrics,
    backoffBaseMs: 5_000,
    backoffCapMs: 900_000,
  })
  return { ...h, dispatcher }
}
