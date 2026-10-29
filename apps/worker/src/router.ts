import { and, eq, inArray } from 'drizzle-orm'
import {
  log,
  matchRoute,
  QUEUES,
  schema,
  type Db,
  type DispatchJob,
  type Envelope,
  type ProviderRuntime,
  type Queue,
  type RouteJob,
} from '@relay/core'
import type { WorkerMetrics } from './metrics'

export interface RouterDeps {
  db: Db
  queue: Queue
  metrics: WorkerMetrics
  runtimes: Record<string, ProviderRuntime>
  recheckDelayMs?: number
  recheckMaxAgeMs?: number
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

    const envelope = event.envelope as Envelope
    const runtime = deps.runtimes[event.provider]
    if (runtime && (await runtime.isSelfEcho(envelope, connection))) {
      await markRouted(event.id)
      metrics.routerEvents.inc({ outcome: 'skipped_echo' })
      log.info('router: skipping echo of a relay message', { eventId: event.id })
      return
    }
    // The echo can arrive before the action commits its sent_messages row. Look once more after a delay.
    const ageMs = Date.now() - event.receivedAt.getTime()
    if (!job.recheck && runtime?.echoRecheck !== false && envelope.actor !== null && envelope.actor === connection.userId && ageMs < (deps.recheckMaxAgeMs ?? 30_000)) {
      await queue.send<RouteJob>(
        QUEUES.route,
        { eventId: event.id, recheck: true },
        { singletonKey: event.id, startAfter: new Date(Date.now() + (deps.recheckDelayMs ?? 5_000)) },
      )
      metrics.routerEvents.inc({ outcome: 'echo_recheck' })
      return
    }

    const candidates = await db
      .select()
      .from(schema.routes)
      .where(and(eq(schema.routes.enabled, true), eq(schema.routes.connectionId, event.connectionId)))
    const matched = candidates.filter((r) => matchRoute(r, envelope))
    if (matched.length === 0) {
      await markRouted(event.id)
      metrics.routerEvents.inc({ outcome: 'unmatched' })
      return
    }

    const allLinks = await db
      .select({
        routeId: schema.routeDestinations.routeId,
        destinationId: schema.routeDestinations.destinationId,
        destinationConnectionId: schema.destinations.connectionId,
      })
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
    const links = allLinks.filter((l) => l.destinationConnectionId === event.connectionId)
    for (const l of allLinks.filter((x) => x.destinationConnectionId !== event.connectionId)) {
      metrics.crossTenantBlocked.inc({ stage: 'router' })
      log.warn('router: skipped a destination in another connection', { eventId: event.id, routeId: l.routeId, destinationId: l.destinationId })
    }

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
