import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  log,
  matchRoute,
  QUEUES,
  schema,
  type Db,
  type DispatchJob,
  type Envelope,
  type Queue,
  type RouteJob,
} from '@relay/core'
import type { WorkerMetrics } from './metrics'

export interface RouterDeps {
  db: Db
  queue: Queue
  metrics: WorkerMetrics
}

export function createRouter(deps: RouterDeps) {
  const { db, queue, metrics } = deps

  const markRouted = (eventId: string) =>
    db.update(schema.events).set({ routedAt: new Date() }).where(eq(schema.events.id, eventId))

  return async function route(job: RouteJob): Promise<void> {
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, job.eventId))
    if (!event) {
      log.warn('router: event not found', { eventId: job.eventId })
      return
    }

    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, event.connectionId))
    if (!connection || connection.status !== 'active') {
      await markRouted(event.id)
      metrics.routerEvents.inc({ outcome: 'skipped_inactive' })
      log.info('router: connection not active, skipping', { eventId: event.id, connectionId: event.connectionId })
      return
    }

    // M3: the loop guard (provider isSelfEcho check) goes here, before any route is matched.

    const envelope = event.envelope as Envelope
    const candidates = await db
      .select()
      .from(schema.routes)
      .where(
        and(
          eq(schema.routes.enabled, true),
          or(isNull(schema.routes.connectionId), eq(schema.routes.connectionId, event.connectionId)),
        ),
      )
    const matched = candidates.filter((r) => matchRoute(r, envelope))
    if (matched.length === 0) {
      await markRouted(event.id)
      metrics.routerEvents.inc({ outcome: 'unmatched' })
      return
    }

    const links = await db
      .select({ routeId: schema.routeDestinations.routeId, destinationId: schema.routeDestinations.destinationId })
      .from(schema.routeDestinations)
      .innerJoin(schema.destinations, eq(schema.destinations.id, schema.routeDestinations.destinationId))
      .where(
        and(
          inArray(
            schema.routeDestinations.routeId,
            matched.map((r) => r.id),
          ),
          eq(schema.destinations.enabled, true),
        ),
      )

    const created = await db.transaction(async (tx) => {
      await tx.update(schema.events).set({ routedAt: new Date() }).where(eq(schema.events.id, event.id))
      if (links.length === 0) return []
      const inserted = await tx
        .insert(schema.deliveries)
        .values(links.map((l) => ({ eventId: event.id, routeId: l.routeId, destinationId: l.destinationId })))
        .onConflictDoNothing({
          target: [schema.deliveries.eventId, schema.deliveries.routeId, schema.deliveries.destinationId],
        })
        .returning({ id: schema.deliveries.id })
      for (const row of inserted) await queue.send<DispatchJob>(QUEUES.dispatch, { deliveryId: row.id }, { tx, singletonKey: row.id })
      return inserted
    })

    metrics.routerEvents.inc({ outcome: 'matched' })
    if (created.length > 0) metrics.deliveriesCreated.inc({}, created.length)
    log.info('router: routed event', { eventId: event.id, routes: matched.length, newDeliveries: created.length })
  }
}
