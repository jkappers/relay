import { eq, sql } from 'drizzle-orm'
import { schema } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { createSweeper } from '../src/sweeper'
import { dispatchJobs, getDelivery, insertEvent, makeDelivery, makeRoute, respond, setup, startReceiver, useHarness } from './harness'

const h = useHarness()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)
const sweeper = (graceMs = 60_000) => createSweeper({ db: h.db, queue: h.queue, metrics: h.metrics, graceMs })

async function clearJobs() {
  await h.db.execute(sql`delete from pgboss.job`)
}

describe('sweeper', () => {
  it('requeues a stranded pending delivery, which then succeeds', async () => {
    const receiver = await startReceiver(respond(200, { ok: true }))
    const s = await setup(h, { url: receiver.url })
    const route = await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    const delivery = await makeDelivery(h, event.id, route.id, s.destination.id)
    await h.db.update(schema.deliveries).set({ updatedAt: minutesAgo(10) }).where(eq(schema.deliveries.id, delivery.id))

    expect(await sweeper()()).toEqual({ events: 0, deliveries: 1, actions: 0 })
    expect(await dispatchJobs(h)).toHaveLength(1)
    expect(h.metrics.sweeperRequeued.get({ kind: 'delivery' })).toBe(1)

    await h.dispatcher({ deliveryId: delivery.id })
    expect((await getDelivery(h, delivery.id)).status).toBe('succeeded')
    await receiver.close()
  })

  it('routes an event that was enqueued but never routed', async () => {
    const s = await setup(h, { url: 'http://127.0.0.1:1/x' })
    await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    await h.db.update(schema.events).set({ enqueuedAt: minutesAgo(10) }).where(eq(schema.events.id, event.id))

    expect(await sweeper()()).toEqual({ events: 1, deliveries: 0, actions: 0 })
    const jobs = await h.db.execute<{ data: { eventId: string } }>(sql`select data from pgboss.job where name = 'route'`)
    expect(jobs.map((j) => j.data.eventId)).toEqual([event.id])

    await h.router({ eventId: event.id })
    const [row] = await h.db.select().from(schema.events).where(eq(schema.events.id, event.id))
    expect(row!.routedAt).not.toBeNull()
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(1)
    expect(h.metrics.sweeperRequeued.get({ kind: 'event' })).toBe(1)
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 0, actions: 0 })
  })

  it('leaves rows inside the grace period alone', async () => {
    const s = await setup(h, { url: 'http://127.0.0.1:1/x' })
    const route = await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    await h.db.update(schema.events).set({ enqueuedAt: new Date(Date.now() - 10_000) }).where(eq(schema.events.id, event.id))
    await makeDelivery(h, event.id, route.id, s.destination.id)
    await h.db.update(schema.deliveries).set({ nextAttemptAt: new Date(Date.now() + 60_000) })

    expect(await sweeper()()).toEqual({ events: 0, deliveries: 0, actions: 0 })
    expect(await dispatchJobs(h)).toHaveLength(0)
  })

  it('ignores events that are routed and deliveries that are finished', async () => {
    const s = await setup(h, { url: 'http://127.0.0.1:1/x' })
    const route = await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    await h.db.update(schema.events).set({ enqueuedAt: minutesAgo(10), routedAt: minutesAgo(9) })
    const delivery = await makeDelivery(h, event.id, route.id, s.destination.id)
    await h.db.update(schema.deliveries).set({ status: 'failed', updatedAt: minutesAgo(10) }).where(eq(schema.deliveries.id, delivery.id))
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 0, actions: 0 })
  })

  it('does not create a second job while one is already queued', async () => {
    const s = await setup(h, { url: 'http://127.0.0.1:1/x' })
    const route = await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    await h.db.update(schema.events).set({ enqueuedAt: minutesAgo(10) })
    const delivery = await makeDelivery(h, event.id, route.id, s.destination.id)
    await h.db.update(schema.deliveries).set({ updatedAt: minutesAgo(10) }).where(eq(schema.deliveries.id, delivery.id))
    await clearJobs()

    await sweeper()()
    expect(await sweeper()()).toEqual({ events: 0, deliveries: 0, actions: 0 })
    expect(await dispatchJobs(h)).toHaveLength(1)
    const rows = await h.db.execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where name = 'route'`)
    expect(rows[0]?.n).toBe(1)
  })

  it('does not collide with a delayed retry job for the same delivery', async () => {
    const receiver = await startReceiver([respond(500), respond(200)])
    const s = await setup(h, { url: receiver.url })
    const route = await makeRoute(h, { destinationIds: [s.destination.id] })
    const event = await insertEvent(h, s.connection.id)
    const delivery = await makeDelivery(h, event.id, route.id, s.destination.id)
    await h.dispatcher({ deliveryId: delivery.id })
    expect(await dispatchJobs(h)).toHaveLength(1)
    await receiver.close()
  })
})
