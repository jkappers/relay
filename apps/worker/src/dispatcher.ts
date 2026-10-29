import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import {
  computeAllowed,
  mintReplyToken,
  syncResponseSchema,
  type ActionsJob,
  type AgentJob,
  type ProviderRuntime,
  computeBackoffMs,
  computeSignature,
  log,
  parseRetryAfterMs,
  QUEUES,
  RELAY_VERSION,
  schema,
  type Cipher,
  type Db,
  type DispatchJob,
  type Queue,
} from '@relay/core'
import type { WorkerMetrics } from './metrics'

export const MAX_STORED_RESPONSE_BYTES = 64 * 1024

export interface DispatcherDeps {
  db: Db
  queue: Queue
  cipher: Cipher
  metrics: WorkerMetrics
  backoffBaseMs: number
  backoffCapMs: number
  runtimes: Record<string, ProviderRuntime>
  replyKey: Buffer
  publicUrl: string
  replyTtlSeconds: number
  fetch?: typeof fetch
  random?: () => number
  nowSeconds?: () => number
}

type Failure = { retryable: boolean; statusCode: number | null; error: string; retryAfterMs?: number | null }
type Outcome = { ok: true; statusCode: number; body: unknown } | ({ ok: false } & Failure)

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'TimeoutError') return `timeout after ${timeoutMs}ms`
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : ''
    return `${err.message}${cause}`.slice(0, 500)
  }
  return String(err).slice(0, 500)
}

export function createDispatcher(deps: DispatcherDeps) {
  const { db, queue, metrics } = deps
  const doFetch = deps.fetch ?? fetch
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))

  async function send(
    destination: schema.DestinationRow,
    url: string,
    secret: string,
    deliveryId: string,
    eventId: string,
    attempt: number,
    envelope: object,
    reply: object | null,
  ): Promise<Outcome> {
    const body = JSON.stringify({ ...envelope, ...(reply ? { reply } : {}), delivery: { id: deliveryId, attempt } })
    const timestamp = String(nowSeconds())
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(destination.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'user-agent': `relay/${RELAY_VERSION}`,
          'relay-delivery-id': deliveryId,
          'relay-event-id': eventId,
          'relay-timestamp': timestamp,
          'relay-signature': computeSignature(secret, timestamp, body),
        },
        body,
      })
    } catch (err) {
      return { ok: false, retryable: true, statusCode: null, error: describeError(err, destination.timeoutMs) }
    }

    const status = res.status
    if (status >= 200 && status < 300) {
      let parsed: unknown = null
      try {
        if ((res.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
          const text = await readCapped(res, MAX_STORED_RESPONSE_BYTES)
          if (text !== null) parsed = JSON.parse(text)
        } else {
          await res.body?.cancel()
        }
      } catch {
        parsed = null
      }
      return { ok: true, statusCode: status, body: parsed }
    }

    await res.body?.cancel().catch(() => {})
    const retryable = status === 408 || status === 429 || status >= 500
    return {
      ok: false,
      retryable,
      statusCode: status,
      error: `HTTP ${status}`,
      retryAfterMs: status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : null,
    }
  }

  return async function dispatch(job: DispatchJob): Promise<void> {
    const [row] = await db
      .select({ delivery: schema.deliveries, destination: schema.destinations, event: schema.events })
      .from(schema.deliveries)
      .innerJoin(schema.destinations, eq(schema.destinations.id, schema.deliveries.destinationId))
      .innerJoin(schema.events, eq(schema.events.id, schema.deliveries.eventId))
      .where(eq(schema.deliveries.id, job.deliveryId))
    if (!row) {
      log.warn('dispatcher: delivery not found', { deliveryId: job.deliveryId })
      return
    }
    const { delivery, destination, event } = row
    if (delivery.status !== 'pending') return

    const pending = and(eq(schema.deliveries.id, delivery.id), eq(schema.deliveries.status, 'pending'))

    if (!destination.enabled) {
      await db
        .update(schema.deliveries)
        .set({ status: 'failed', lastError: 'destination disabled', completedAt: new Date(), nextAttemptAt: null, updatedAt: new Date() })
        .where(pending)
      metrics.deliveryAttempts.inc({ outcome: 'failed_non_retryable' })
      return
    }

    if (destination.kind === 'agent') {
      await queue.send<AgentJob>(QUEUES.agent, { deliveryId: delivery.id }, { singletonKey: delivery.id })
      return
    }

    if (!destination.url || !destination.secretCiphertext) {
      await db
        .update(schema.deliveries)
        .set({ status: 'failed', lastError: 'destination misconfigured', completedAt: new Date(), nextAttemptAt: null, updatedAt: new Date() })
        .where(pending)
      metrics.deliveryAttempts.inc({ outcome: 'failed_non_retryable' })
      return
    }

    const jti = randomUUID()
    const [claimed] = await db
      .update(schema.deliveries)
      .set({ attempts: sql`${schema.deliveries.attempts} + 1`, lastReplyJti: jti, updatedAt: new Date() })
      .where(pending)
      .returning({ attempts: schema.deliveries.attempts })
    if (!claimed) return
    const attempt = claimed.attempts

    const secret = deps.cipher.decrypt(destination.secretCiphertext)
    const allowed = computeAllowed(deps.runtimes[event.provider], destination.allowedActions)
    const reply =
      allowed.length > 0
        ? {
            actionsUrl: `${deps.publicUrl}/actions`,
            token: mintReplyToken(deps.replyKey, {
              deliveryId: delivery.id,
              allowed,
              ttlSeconds: deps.replyTtlSeconds,
              nowSeconds: nowSeconds(),
              jti,
            }).token,
            allowed,
          }
        : null
    const outcome = await send(destination, destination.url, secret, delivery.id, event.id, attempt, event.envelope as object, reply)
    const now = new Date()

    if (outcome.ok) {
      const hasActionsKey =
        outcome.body !== null && typeof outcome.body === 'object' && !Array.isArray(outcome.body) && 'actions' in outcome.body
      const syncActions = hasActionsKey ? syncResponseSchema.safeParse(outcome.body) : null
      const hasActions = Boolean(syncActions?.success && syncActions.data.actions.length > 0)
      if (hasActionsKey && !hasActions) {
        log.warn('dispatcher: ignoring invalid or empty actions in response', { deliveryId: delivery.id })
      }
      await db.transaction(async (tx) => {
        await tx
          .update(schema.deliveries)
          .set({
            status: 'succeeded',
            lastStatusCode: outcome.statusCode,
            lastError: null,
            responseBody: outcome.body,
            nextAttemptAt: null,
            completedAt: now,
            actionsDoneAt: hasActionsKey && !hasActions ? now : null,
            updatedAt: now,
          })
          .where(pending)
        if (hasActions) await queue.send<ActionsJob>(QUEUES.actions, { deliveryId: delivery.id }, { tx, singletonKey: delivery.id })
      })
      metrics.deliveryAttempts.inc({ outcome: 'success' })
      return
    }

    if (!outcome.retryable || attempt >= destination.maxAttempts) {
      await db
        .update(schema.deliveries)
        .set({
          status: 'failed',
          lastStatusCode: outcome.statusCode,
          lastError: outcome.error,
          nextAttemptAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(pending)
      metrics.deliveryAttempts.inc({ outcome: outcome.retryable ? 'failed_exhausted' : 'failed_non_retryable' })
      log.warn('dispatcher: delivery failed', { deliveryId: delivery.id, attempt, error: outcome.error })
      return
    }

    const delayMs =
      outcome.retryAfterMs != null
        ? Math.min(outcome.retryAfterMs, deps.backoffCapMs)
        : computeBackoffMs(attempt, {
            baseMs: deps.backoffBaseMs,
            capMs: deps.backoffCapMs,
            ...(deps.random ? { random: deps.random } : {}),
          })
    const nextAttemptAt = new Date(now.getTime() + delayMs)
    await db.transaction(async (tx) => {
      await tx
        .update(schema.deliveries)
        .set({ lastStatusCode: outcome.statusCode, lastError: outcome.error, nextAttemptAt, updatedAt: now })
        .where(pending)
      await queue.send<DispatchJob>(QUEUES.dispatch, { deliveryId: delivery.id }, { tx, startAfter: nextAttemptAt, singletonKey: delivery.id })
    })
    metrics.deliveryAttempts.inc({ outcome: 'retry' })
  }
}
