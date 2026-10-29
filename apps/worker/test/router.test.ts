import { eq } from 'drizzle-orm'
import { schema } from '@relay/core'
import { describe, expect, it } from 'vitest'
import { dispatchJobs, insertEvent, makeRoute, setup, useHarness } from './harness'

const h = useHarness()

describe('router', () => {
  it('creates one delivery per destination and enqueues a dispatch job for each', async () => {
    const a = await setup(h, { url: 'http://127.0.0.1:1/a' })
    const b = await setup(h, { url: 'http://127.0.0.1:1/b' })
    const route = await makeRoute(h, { destinationIds: [a.destination.id, b.destination.id] })
    const event = await insertEvent(h, a.connection.id)

    await h.router({ eventId: event.id })

    const rows = await h.db.select().from(schema.deliveries)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'pending' && r.routeId === route.id)).toBe(true)
    expect((await dispatchJobs(h)).map((j) => j.deliveryId).sort()).toEqual(rows.map((r) => r.id).sort())
    expect(h.metrics.routerEvents.get({ outcome: 'matched' })).toBe(1)
    expect(h.metrics.deliveriesCreated.get({})).toBe(2)
  })

  it('does not duplicate deliveries or jobs when the same event is routed twice', async () => {
    const a = await setup(h, { url: 'http://127.0.0.1:1/a' })
    await makeRoute(h, { destinationIds: [a.destination.id] })
    const event = await insertEvent(h, a.connection.id)

    await h.router({ eventId: event.id })
    await h.router({ eventId: event.id })

    expect(await h.db.select().from(schema.deliveries)).toHaveLength(1)
    expect(await dispatchJobs(h)).toHaveLength(1)
    expect(h.metrics.deliveriesCreated.get({})).toBe(1)
  })

  it('creates deliveries only for new matches on replay', async () => {
    const a = await setup(h, { url: 'http://127.0.0.1:1/a' })
    await makeRoute(h, { destinationIds: [a.destination.id] })
    const event = await insertEvent(h, a.connection.id)
    await h.router({ eventId: event.id })
    await makeRoute(h, { name: 'second', destinationIds: [a.destination.id] })
    await h.router({ eventId: event.id })
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(2)
    expect(await dispatchJobs(h)).toHaveLength(2)
  })

  it('skips events for an inactive connection', async () => {
    const a = await setup(h, { url: 'http://127.0.0.1:1/a' })
    await makeRoute(h, { destinationIds: [a.destination.id] })
    const event = await insertEvent(h, a.connection.id)
    await h.db
      .update(schema.connections)
      .set({ status: 'revoked' })
      .where(eq(schema.connections.id, a.connection.id))

    await h.router({ eventId: event.id })

    expect(await h.db.select().from(schema.deliveries)).toHaveLength(0)
    expect(await dispatchJobs(h)).toHaveLength(0)
    expect(h.metrics.routerEvents.get({ outcome: 'skipped_inactive' })).toBe(1)
  })

  it('counts unmatched events', async () => {
    const a = await setup(h, { url: 'http://127.0.0.1:1/a' })
    await makeRoute(h, { eventType: 'slack.message.*', destinationIds: [a.destination.id] })
    const event = await insertEvent(h, a.connection.id)
    await h.router({ eventId: event.id })
    expect(h.metrics.routerEvents.get({ outcome: 'unmatched' })).toBe(1)
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(0)
  })

  it('ignores disabled destinations', async () => {
    const a = await setup(h, { url: 'http://127.0.0.1:1/a' })
    await makeRoute(h, { destinationIds: [a.destination.id] })
    await h.db.update(schema.destinations).set({ enabled: false })
    const event = await insertEvent(h, a.connection.id)
    await h.router({ eventId: event.id })
    expect(await h.db.select().from(schema.deliveries)).toHaveLength(0)
  })
})
