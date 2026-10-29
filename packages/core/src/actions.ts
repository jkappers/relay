import { and, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { ConnectionStore } from './connections'
import type { Db, Tx } from './db/client'
import { actionsLog, connections, deliveries, destinations, events, sentMessages } from './db/schema'
import type { Envelope } from './envelope'
import { log } from './log'
import { ActionError, computeAllowed, type ActionDef, type ProviderRuntime } from './provider'
import type { MetricsRegistry } from './metrics'

export const MAX_ACTIONS_PER_REQUEST = 20
export const PENDING_STALE_MS = 60_000
export const MAX_ACTION_ATTEMPTS = 8

export type ActionMode = 'sync' | 'async' | 'agent'
export type ActionOutcome = 'succeeded' | 'failed' | 'replayed' | 'in_progress' | 'retry'
export type ActionStatus = 'succeeded' | 'failed' | 'in_progress' | 'retry'

export interface ActionResult {
  type: string
  status: ActionStatus
  result?: unknown
  error?: string
  retryAfterSeconds?: number
}

export const isTerminal = (r: ActionResult) => r.status === 'succeeded' || r.status === 'failed'

export const rawActionSchema = z.object({ type: z.string().min(1).max(100) }).loose()
export type RawAction = z.infer<typeof rawActionSchema>

export const syncResponseSchema = z.object({ actions: z.array(rawActionSchema).max(MAX_ACTIONS_PER_REQUEST) })

export const idempotencyKeySchema = z.string().min(1).max(200)

export function createActionCounters(registry: MetricsRegistry) {
  return {
    actions: registry.counter('relay_actions_total', 'Actions by provider, type, mode and outcome.', [
      'provider',
      'type',
      'mode',
      'outcome',
    ] as const),
  }
}
export type ActionCounters = ReturnType<typeof createActionCounters>

export interface ExecutorDeps {
  db: Db
  connections: ConnectionStore
  runtimes: Record<string, ProviderRuntime>
  counters?: ActionCounters
  fetch?: typeof fetch
  now?: () => Date
}

export type ValidatedAction =
  | { ok: true; type: string; def: ActionDef; params: unknown; idempotencyKey: string | null }
  | { ok: false; type: string; error: string }

function splitAction(action: RawAction): { params: Record<string, unknown>; key: unknown } {
  const { type: _type, idempotencyKey, ...params } = action
  return { params, key: idempotencyKey }
}

export function validateAction(runtime: ProviderRuntime, action: RawAction, mode: ActionMode, index: number): ValidatedAction {
  const def = runtime.actions[action.type]
  if (!def) return { ok: false, type: action.type, error: 'unknown_action' }
  const { params, key } = splitAction(action)
  const parsed = def.params.safeParse(params)
  if (!parsed.success) return { ok: false, type: action.type, error: 'invalid_params' }
  let idempotencyKey: string | null = null
  if (def.mutating) {
    if (mode === 'sync') idempotencyKey = `sync:${index}`
    else {
      const k = idempotencyKeySchema.safeParse(key)
      if (!k.success) return { ok: false, type: action.type, error: 'idempotency_key_required' }
      idempotencyKey = k.data
    }
  }
  return { ok: true, type: action.type, def, params: parsed.data, idempotencyKey }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function createActionExecutor(deps: ExecutorDeps) {
  const { db } = deps
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())

  function count(provider: string, type: string, mode: ActionMode, outcome: ActionOutcome) {
    deps.counters?.actions.inc({ provider, type, mode, outcome })
  }

  async function loadContext(deliveryId: string) {
    const [row] = await db
      .select({ event: events, destination: destinations, connection: connections })
      .from(deliveries)
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
      .innerJoin(connections, eq(connections.id, events.connectionId))
      .where(eq(deliveries.id, deliveryId))
    return row ?? null
  }

  return async function executeActions(
    deliveryId: string,
    actions: RawAction[],
    mode: ActionMode,
    hooks: ExecuteHooks = {},
  ): Promise<ActionResult[]> {
    const ctx = await loadContext(deliveryId)
    if (!ctx) return actions.map((a) => ({ type: a.type, status: 'failed', error: 'unknown_delivery' }))
    const provider = ctx.event.provider
    const runtime = deps.runtimes[provider]
    const allowed = computeAllowed(runtime, ctx.destination.allowedActions)
    const envelope = ctx.event.envelope as Envelope
    const results: ActionResult[] = []

    for (const [index, action] of actions.entries()) {
      const finish = (r: ActionResult, outcome: ActionOutcome) => {
        count(provider, action.type, mode, outcome)
        results.push(r)
      }
      if (!runtime || ctx.connection.status !== 'active') {
        finish({ type: action.type, status: 'failed', error: runtime ? 'connection_inactive' : 'unknown_provider' }, 'failed')
        continue
      }
      if (!allowed.includes(action.type)) {
        finish({ type: action.type, status: 'failed', error: 'not_allowed' }, 'failed')
        continue
      }
      const v = validateAction(runtime, action, mode, index)
      if (!v.ok) {
        finish({ type: v.type, status: 'failed', error: v.error }, 'failed')
        continue
      }

      const credentials = await deps.connections.getCredentials(ctx.connection.id)
      const runCtx = { envelope, connection: { ...ctx.connection }, credentials, fetch: doFetch }

      const attempt = async (): Promise<{ result: ActionResult; outcome: ActionOutcome; output?: Awaited<ReturnType<ActionDef['run']>> }> => {
        try {
          const output = await v.def.run(runCtx, v.params)
          return { result: { type: v.type, status: 'succeeded', result: output.result }, outcome: 'succeeded', output }
        } catch (err) {
          if (err instanceof ActionError) {
            if (err.retryable) {
              return {
                result: {
                  type: v.type,
                  status: 'retry',
                  error: err.code,
                  ...(err.retryAfterMs != null ? { retryAfterSeconds: Math.ceil(err.retryAfterMs / 1000) } : {}),
                },
                outcome: 'retry',
              }
            }
            return { result: { type: v.type, status: 'failed', error: err.code }, outcome: 'failed' }
          }
          log.error('action crashed', { deliveryId, type: v.type, err: err instanceof Error ? err.name : 'unknown' })
          return { result: { type: v.type, status: 'retry', error: 'internal_error' }, outcome: 'retry' }
        }
      }

      if (!v.def.mutating) {
        const r = await attempt()
        finish(r.result, r.outcome)
        continue
      }

      const key = v.idempotencyKey!
      const startedAt = now()
      const [inserted] = await db
        .insert(actionsLog)
        .values({
          deliveryId,
          idempotencyKey: key,
          type: v.type,
          params: v.params as object,
          status: 'pending',
          attempts: 1,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .onConflictDoNothing({ target: [actionsLog.deliveryId, actionsLog.idempotencyKey] })
        .returning({ id: actionsLog.id })

      let logId = inserted?.id
      if (!logId) {
        const [existing] = await db
          .select()
          .from(actionsLog)
          .where(and(eq(actionsLog.deliveryId, deliveryId), eq(actionsLog.idempotencyKey, key)))
        if (!existing) {
          finish({ type: v.type, status: 'retry', error: 'internal_error' }, 'retry')
          continue
        }
        if (existing.type !== v.type || canonical(existing.params) !== canonical(v.params)) {
          finish({ type: v.type, status: 'failed', error: 'idempotency_key_conflict' }, 'failed')
          continue
        }
        if (existing.status === 'succeeded') {
          finish({ type: v.type, status: 'succeeded', result: existing.result }, 'replayed')
          continue
        }
        if (existing.status === 'failed') {
          finish({ type: v.type, status: 'failed', error: existing.error ?? 'failed' }, 'replayed')
          continue
        }
        // A pending row older than PENDING_STALE_MS is a crashed run: re-run it (at least once).
        const cutoff = new Date(startedAt.getTime() - PENDING_STALE_MS)
        const [claimed] = await db
          .update(actionsLog)
          .set({ attempts: existing.attempts + 1, updatedAt: startedAt })
          .where(and(eq(actionsLog.id, existing.id), eq(actionsLog.status, 'pending'), lt(actionsLog.updatedAt, cutoff)))
          .returning({ id: actionsLog.id })
        if (!claimed) {
          finish({ type: v.type, status: 'in_progress' }, 'in_progress')
          continue
        }
        logId = claimed.id
      }

      const r = await attempt()
      if (r.result.status === 'succeeded' && r.output) {
        const sent = r.output.sentMessage
        await db.transaction(async (tx) => {
          await tx
            .update(actionsLog)
            .set({ status: 'succeeded', result: r.output!.result ?? null, error: null, updatedAt: now() })
            .where(eq(actionsLog.id, logId!))
          if (sent) {
            await tx
              .insert(sentMessages)
              .values({ connectionId: ctx.connection.id, channel: sent.channel, ts: sent.ts })
              .onConflictDoNothing()
          }
          await hooks.onMutationSucceeded?.(tx, v.type)
        })
        finish(r.result, 'succeeded')
      } else if (r.result.status === 'failed') {
        await db
          .update(actionsLog)
          .set({ status: 'failed', error: r.result.error ?? 'failed', updatedAt: now() })
          .where(eq(actionsLog.id, logId))
        finish(r.result, 'failed')
      } else {
        const [row] = await db.select({ attempts: actionsLog.attempts }).from(actionsLog).where(eq(actionsLog.id, logId))
        if ((row?.attempts ?? 1) >= MAX_ACTION_ATTEMPTS) {
          const error = `retries_exhausted:${r.result.error ?? 'error'}`
          await db.update(actionsLog).set({ status: 'failed', error, updatedAt: now() }).where(eq(actionsLog.id, logId))
          finish({ type: v.type, status: 'failed', error }, 'failed')
        } else {
          // Release the claim so the next attempt can run at once instead of waiting out the stale window.
          await db
            .update(actionsLog)
            .set({ error: r.result.error ?? null, updatedAt: new Date(0) })
            .where(eq(actionsLog.id, logId))
          finish(r.result, 'retry')
        }
      }
    }
    return results
  }
}

export interface ExecuteHooks {
  /** Runs inside the transaction that records a successful mutating action. */
  onMutationSucceeded?: (tx: Tx, type: string) => Promise<void>
}

export type ActionExecutor = ReturnType<typeof createActionExecutor>
