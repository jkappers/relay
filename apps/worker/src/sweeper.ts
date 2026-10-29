import { and, asc, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { log, QUEUES, schema, type Db, type ActionsJob,
  type DispatchJob, type Queue, type RouteJob } from '@relay/core'
import type { WorkerMetrics } from './metrics'

export const SWEEP_LIMIT = 100

export interface SweeperDeps {
  db: Db
  queue: Queue
  metrics: WorkerMetrics
  graceMs: number
}

export function createSweeper(deps: SweeperDeps) {
  const { db, queue, metrics } = deps

  return async function sweep(): Promise<{ events: number; deliveries: number; actions: number }> {
    const cutoff = new Date(Date.now() - deps.graceMs)

    const stuckEvents = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(isNotNull(schema.events.enqueuedAt), isNull(schema.events.routedAt), lt(schema.events.enqueuedAt, cutoff)),
      )
      .orderBy(asc(schema.events.enqueuedAt))
      .limit(SWEEP_LIMIT)
    let events = 0
    for (const e of stuckEvents) {
      if (await queue.send<RouteJob>(QUEUES.route, { eventId: e.id }, { singletonKey: e.id })) events++
    }

    const d = schema.deliveries
    const stuckDeliveries = await db
      .select({ id: d.id })
      .from(d)
      .where(and(sql`${d.status} = 'pending'`, sql`coalesce(${d.nextAttemptAt}, ${d.updatedAt}) < ${cutoff.toISOString()}::timestamptz`))
      .orderBy(asc(d.updatedAt))
      .limit(SWEEP_LIMIT)
    let deliveries = 0
    for (const row of stuckDeliveries) {
      if (await queue.send<DispatchJob>(QUEUES.dispatch, { deliveryId: row.id }, { singletonKey: row.id })) deliveries++
    }

    const stuckActions = await db
      .select({ id: d.id })
      .from(d)
      .where(
        and(
          sql`${d.status} = 'succeeded'`,
          isNull(d.actionsDoneAt),
          sql`jsonb_typeof(${d.responseBody}->'actions') = 'array'`,
          sql`jsonb_array_length(${d.responseBody}->'actions') > 0`,
          lt(d.completedAt, cutoff),
        ),
      )
      .orderBy(asc(d.completedAt))
      .limit(SWEEP_LIMIT)
    let actions = 0
    for (const row of stuckActions) {
      if (await queue.send<ActionsJob>(QUEUES.actions, { deliveryId: row.id }, { singletonKey: row.id })) actions++
    }

    if (events) metrics.sweeperRequeued.inc({ kind: 'event' }, events)
    if (deliveries) metrics.sweeperRequeued.inc({ kind: 'delivery' }, deliveries)
    if (actions) metrics.sweeperRequeued.inc({ kind: 'actions' }, actions)
    if (events || deliveries || actions) log.warn('sweeper: requeued stranded work', { events, deliveries, actions })
    return { events, deliveries, actions }
  }
}
