import { and, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { assignLabels, CLASSIFIER_MODEL, mapLabels, type Classifier, type ClassifyResult } from '@relay/classifier'
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

type ConnectionRow = typeof schema.connections.$inferSelect
type RouteRow = typeof schema.routes.$inferSelect

export interface RouterDeps {
  db: Db
  queue: Queue
  metrics: WorkerMetrics
  runtimes: Record<string, ProviderRuntime>
  classifier: Classifier
  recheckDelayMs?: number
  recheckMaxAgeMs?: number
}

export function createRouter(deps: RouterDeps) {
  const { db, queue, metrics, classifier } = deps

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

    const mode = connection.classifierMode
    const gated = mode === 'off' ? [] : matched.filter((r) => r.selection === 'classifier').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const gatedIds = new Set(gated.map((r) => r.id))
    const alwaysIds = new Set(matched.filter((r) => !gatedIds.has(r.id)).map((r) => r.id))

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

    let pending: PendingDecision | null = null
    if (gated.length > 0) {
      const [existing] = await db
        .select({ id: schema.routeDecisions.id })
        .from(schema.routeDecisions)
        .where(eq(schema.routeDecisions.eventId, event.id))
      if (existing) metrics.classifierCalls.inc({ outcome: 'reused' })
      else pending = await decide(event.id, connection, mode as DecidingMode, envelope, gated)
    }

    const { created, finalGated, won } = await db.transaction(async (tx) => {
      await tx.update(schema.events).set({ routedAt: new Date() }).where(eq(schema.events.id, event.id))
      let finalGated: string[] = []
      let won = false
      if (gated.length > 0) {
        if (pending) {
          const ins = await tx
            .insert(schema.routeDecisions)
            .values(pending.row)
            .onConflictDoNothing({ target: schema.routeDecisions.eventId })
            .returning({ id: schema.routeDecisions.id })
          won = ins.length > 0
        }
        const [stored] = await tx
          .select({ selected: schema.routeDecisions.selected })
          .from(schema.routeDecisions)
          .where(eq(schema.routeDecisions.eventId, event.id))
        if (!stored) throw new Error(`router: no route decision for event ${event.id}`)
        finalGated = mode === 'shadow' ? [...gatedIds] : stored.selected.filter((id) => gatedIds.has(id))
      }
      const deliver = new Set([...alwaysIds, ...finalGated])
      const toInsert = links.filter((l) => deliver.has(l.routeId))
      if (toInsert.length === 0) return { created: [], finalGated, won }
      const inserted = await tx
        .insert(schema.deliveries)
        .values(toInsert.map((l) => ({ eventId: event.id, routeId: l.routeId, destinationId: l.destinationId })))
        .onConflictDoNothing({
          target: [schema.deliveries.eventId, schema.deliveries.routeId, schema.deliveries.destinationId],
        })
        .returning({ id: schema.deliveries.id })
      for (const row of inserted) await queue.send<DispatchJob>(QUEUES.dispatch, { deliveryId: row.id }, { tx, singletonKey: row.id })
      return { created: inserted, finalGated, won }
    })

    if (pending && won) metrics.classifierDecisions.inc({ mode: pending.row.mode, result: pending.result })
    const classifiedNone = gated.length > 0 && alwaysIds.size === 0 && finalGated.length === 0
    metrics.routerEvents.inc({ outcome: classifiedNone ? 'classified_none' : 'matched' })
    if (created.length > 0) metrics.deliveriesCreated.inc({}, created.length)
    log.info('router: routed event', {
      eventId: event.id,
      routes: matched.length,
      gated: gated.length,
      gatedDelivered: finalGated.length,
      newDeliveries: created.length,
    })
  }

  async function decide(
    eventId: string,
    connection: ConnectionRow,
    mode: DecidingMode,
    envelope: Envelope,
    gated: RouteRow[],
  ): Promise<PendingDecision> {
    const candidates = assignLabels(gated.map((r) => r.id))
    const fallback = gated.filter((r) => r.classifierFallback === 'deliver').map((r) => r.id)
    const base = { eventId, connectionId: connection.id, mode, candidates }
    const resultFor = (status: 'ok' | 'fallback' | 'budget_exceeded', selected: string[]): DecisionResult =>
      status === 'ok' ? (selected.length > 0 ? 'selected' : 'none') : selected.length > 0 ? 'fallback_deliver' : 'fallback_drop'

    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(schema.routeDecisions)
      .where(
        and(
          eq(schema.routeDecisions.connectionId, connection.id),
          sql`${schema.routeDecisions.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
          ne(schema.routeDecisions.status, 'budget_exceeded'),
        ),
      )
    if (n >= connection.classifierDailyLimit) {
      metrics.classifierCalls.inc({ outcome: 'budget_exceeded' })
      log.warn('router: classifier daily limit reached, using fallbacks', { eventId, connectionId: connection.id })
      return {
        row: { ...base, model: CLASSIFIER_MODEL, selected: fallback, status: 'budget_exceeded' },
        result: resultFor('budget_exceeded', fallback),
      }
    }

    const started = Date.now()
    let res: ClassifyResult
    try {
      res = await classifier.classify({
        eventType: envelope.type,
        text: envelope.text,
        candidates: candidates.map((c, i) => ({ label: c.label, intent: gated[i]!.intent ?? '' })),
      })
    } catch (err) {
      res = { outcome: 'error', labels: [], error: err instanceof Error ? err.name : 'unknown', model: CLASSIFIER_MODEL, usage: { inputTokens: 0, outputTokens: 0 } }
    }
    const latencyMs = Date.now() - started
    metrics.classifierCalls.inc({ outcome: res.outcome })
    if (res.usage.inputTokens > 0) metrics.classifierTokens.inc({ kind: 'input' }, res.usage.inputTokens)
    if (res.usage.outputTokens > 0) metrics.classifierTokens.inc({ kind: 'output' }, res.usage.outputTokens)
    const ok = res.outcome === 'ok'
    const selected = ok ? mapLabels(res.labels, candidates) : fallback
    if (!ok) log.warn('router: classifier failed, using fallbacks', { eventId, outcome: res.outcome, error: res.error })
    const status = ok ? 'ok' : 'fallback'
    return {
      row: {
        ...base,
        model: res.model,
        selected,
        status,
        error: ok ? null : (res.error ?? res.outcome),
        latencyMs,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
      },
      result: resultFor(status, selected),
    }
  }
}

type DecidingMode = 'shadow' | 'enforce'
type DecisionResult = 'selected' | 'none' | 'fallback_deliver' | 'fallback_drop'
interface PendingDecision {
  row: typeof schema.routeDecisions.$inferInsert & { mode: DecidingMode }
  result: DecisionResult
}
